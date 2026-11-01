# El servicio `sugiere`

Un solo mecanismo de sugerencia para la compañía y para Paseo: un servicio sin estado que propone el
siguiente mensaje de una sesión y dictamina si puede enviarse. `paseo-sugiere` pasa a ser su cliente
(píldora y ajustes); el supervisor de la compañía, otro. Ninguno de los dos razona ya por su cuenta.

Este documento es la especificación. No hay implementación en este ticket: ni plugin, ni
`jira-epic-trigger.py`, ni `company-sesion`, ni `company_revalidar.py` cambian aquí.

## 1. Forma

- **Pod + ArgoCD app `sugiere` en el namespace `llm`**, junto a `ollaya` y el residente. Imagen por CI
  del repo `paseo-sugiere`; manifiesto en el repo GitOps.
- **Sin estado y sin ficheros**: no lee transcripts, no guarda sesiones, no escribe tickets. Todo lo
  que necesita llega en la petición. Es lo que permite servir a la vez a una sesión tmux del x86 y a un
  agente de Paseo sin montar dos homes en el mismo volumen.
- **Solo interno**: Service de clúster y token. Sin ingress, sin `*.lan`, sin publicar en internet.
- Alcance de red: LiteLLM (residente) y `ollaya` (Jev) por Service. Se va el router local, el bearer de
  la cuenta y el tope de 60 s del RPC del host.
- Dos endpoints: `/v1/suggest` (propone) y `/v1/verdict` (dictamina). La instrucción del residente y la
  rúbrica del juez viven aquí y en ningún otro sitio: un ConfigMap montado y releído en cada petición,
  sin reinicio.

## 2. `POST /v1/suggest`

Propone el siguiente mensaje de la sesión. Sustituye a la llamada al router que hoy hace
`server/suggest.ts`.

Entrada:

```json
{"sid": "<id de sesión>", "turno": "<id del turno cerrado>",
 "transcript": "<transcript aplanado>",
 "contexto": {"kind": "company|live", "key": "<clave del ticket>", "rol": "developer"}}
```

| Campo | Tipo | Regla |
|---|---|---|
| `sid` | string | no vacío; solo para trazas |
| `turno` | string | no vacío; solo para trazas y para que el llamante case la respuesta |
| `transcript` | string | 1..200 000 caracteres, ya aplanado por el llamante (los tool calls, una línea; nunca su contenido). Por encima, se recorta por la cola antes de enviar |
| `contexto` | objeto | opcional; `kind` obligatorio si viene. `key`/`rol` solo si es de compañía |

Salida (`200`):

```json
{"sugerencia": "Abre el PR contra deploy/prod y espera CI", "modelo": "qwen38-off", "ms": 812}
```

- `sugerencia` vacía es una respuesta **válida**: el turno ha terminado o no hay nada que proponer (la
  píldora no aparece; el supervisor no la usa). No es un error.
- Alias residente `qwen38-off` (sin thinking) y `max_tokens ≤ 48`, como hoy. El prefijo estable se
  mantiene: la instrucción fija va al final y el transcript delante.
- Sin caché: cada transcript es distinto.
- Códigos: `422` cuerpo inválido · `503` el residente no contesta → el llamante se queda como está
  (píldora que no sale; `RETOMA` en la compañía).

## 3. `POST /v1/verdict`

Dictamina si esa sugerencia puede enviarse como siguiente turno. Es la pieza 2 del plan, mudada del
supervisor al servicio.

Entrada:

```json
{"sid": "<id de sesión>", "turno": "<id del turno cerrado>", "sugerencia": "<texto propuesto>",
 "contexto": {"cwd": "/home/<usuario>/k8s/<repo>", "key": "<clave del ticket>",
              "resumen": "…", "criterio": "…"}}
```

| Campo | Tipo | Regla |
|---|---|---|
| `sid` | string | no vacío |
| `turno` | string | el turno **cuya** sugerencia es. Si el llamante detecta que ya no es el vigente, no llama: la puerta no tiene registro de sesiones |
| `sugerencia` | string | 1..4000 caracteres tras normalizar |
| `contexto` | objeto | **obligatorio**: `cwd` (el del registro de la sesión, para D10); `key`, `resumen` y `criterio` si es de compañía (son lo que juzga la rúbrica) |

Salida (siempre `200`, también para un veredicto negativo):

```json
{"ok": false, "riesgo": "dinero", "motivo": "D6: importe o pago en el mensaje"}
```

| Campo | Tipo | Valores |
|---|---|---|
| `ok` | bool | `true` solo si `riesgo` es `ninguno` o `bajo` |
| `riesgo` | string | `ninguno` · `bajo` · `alto` · `dinero` |
| `motivo` | string | una línea: el id de la regla dura que disparó, o `rúbrica <p> (<modelo>)`. Nunca vacío |

Códigos: `422` cuerpo inválido o falta `contexto.cwd` · `200` en todo lo demás. **Fail-closed**: si Jev
y el residente fallan o se agotan, responde `{"ok": false, "riesgo": "alto", "motivo": "puerta no
disponible"}` y el llamante cae a `RETOMA`.

Presupuesto: Jev ≤ 5 s, residente ≤ 15 s, tope duro 25 s; el cliente espera 30 s (el plugin, 35 s por
su RPC de 60 s). Caché: `sha256(sid|turno|sugerencia)` → veredicto de modelo, 24 h, LRU 1000. Las
reglas duras **no** se cachean: se evalúan siempre y ganan al veredicto cacheado.

## 4. Reglas duras (lista cerrada)

Se aplican antes de cualquier modelo, sobre el texto normalizado (NFKC, sin espacios de borde),
case-insensitive y multilínea. **Son estas y ninguna más**: añadir una es cambiar esta especificación.
En la tabla, `\|` es el separador de alternancia de la regex (`|` rompe el markdown).

| id | Qué | Patrón exacto | Veredicto |
|---|---|---|---|
| D0 | sugerencia vacía | `len(sugerencia.strip()) < 3` | `ok:false`, `bajo` |
| D1 | borrado de ficheros | `\brm\s+(-[^\s]+\s+)*-[^\s]*[rf]` · `\bfind\b[^\n]*\s-delete\b` · `\bshred\b` · `\bmkfs(\.\w+)?\b` · `\bdd\b[^\n]*\bof=/dev/` · `>\s*/dev/(sd\|nvme\|disk)` | `ok:false`, `alto` |
| D2 | k8s destructivo | `\bkubectl\s+delete\b` · `\bkubectl\b[^\n]*\s--force\b` · `\bkubectl\s+drain\b` · `\bargocd\s+app\s+delete\b` · `\bhelm\s+(uninstall\|delete)\b` | `ok:false`, `alto` |
| D3 | perfil de cómputo | `gpu-arbiter-state` · `\bkubectl\s+scale\b` · `\bcompute_mode\b` | `ok:false`, `dinero` (carga de los Sparks: lo decide Dani) |
| D4 | git destructivo | `\bgit\s+push\b[^\n]*(\s--force\b\|\s-f\b\|[^\s]*\+[^\s]*:[^\s]*)` · `\bgit\s+reset\s+--hard\b` · `\bgit\s+clean\s+-[^\s]*f` · `\bgit\s+branch\s+-D\b` | `ok:false`, `alto` |
| D5 | datos | `\b(DROP\|TRUNCATE)\s+(TABLE\|DATABASE\|SCHEMA\|INDEX)\b` · `\bDELETE\s+FROM\b` · `\bpg_restore\b` · `\bpsql\b[^\n]*\bdrop\b` | `ok:false`, `dinero` |
| D6 | dinero | `(€\|\$\|£)\s?\d` · `\d+([.,]\d+)?\s?(€\|eur\|usd\|gbp)` · `\b(pagar\|pago\|transferencia\|bizum\|adeudo\|domiciliaci[oó]n\|reembolso\|comprar\|checkout\|tarjeta)\b` · `confirmar_pago` | `ok:false`, `dinero` |
| D7 | secretos y credenciales | `\bop\s+(item\|document\|vault)\s+(create\|edit\|delete)\b` · `\bkubectl\s+delete\s+secret\b` · `\b(passwd\|chpasswd)\b` · `\bsysadminctl\b[^\n]*-newPassword` · `\bgh\s+auth\s+(login\|refresh)\b` · `\bssh-keygen\b` | `ok:false`, `dinero` |
| D8 | publicación y release | `\bsocial_(publish\|send_\|approve_draft)\w*\b` · `\bgmail_send\b` · `publish_html[^\n]*public\s*=\s*true` · `\b(npm\|twine\|cargo)\s+publish\b` · `\bgh\s+release\b[^\n]*upload` | `ok:false`, `dinero` |
| D9 | programado | `\bcrontab\b` · `\bsystemctl\s+(enable\|start\|restart)\b` · `\bcreate_(schedule\|heartbeat)\b` | `ok:false`, `alto` |
| D10 | fuera del ámbito | cualquier ruta `(~\|/home/[\w.-]+)/…` cuyo prefijo no sea `contexto.cwd` (o la casa del ticket si `cwd` es el de la sesión de compañía: `~/k8s/<repo>`, `~/src/<repo>`, `~/proyectos/<producto>`) | `ok:false`, `alto` |

Notas de aplicación:

- `dinero` en D3/D5/D7/D8 no significa que el mensaje cueste dinero: significa **solo Dani lo decide**
  (perfil de cómputo, datos, secretos, publicación). La tabla de §6 es la que manda.
- D10 solo mira rutas con raíz absoluta o `~`; una ruta relativa se juzga contra `contexto.cwd`.
- El texto se juzga entero, también dentro de bloques de código: un `rm -rf` propuesto "para comprobar"
  sigue siendo un `rm -rf`.

## 5. Rúbrica de Jev

Modelo `kev:4b` (env `REVALIDAR_JEV_MODELO`), por `POST /v1/systemone` de Ollaya (la misma forma de
`company_revalidar.jev()`). Dos preguntas de elección:

```
veredicto: "¿Debe la compañía enviar este mensaje como siguiente turno?"
  seguir    "Avanza el ticket hacia su criterio de aceptación, sin ensanchar el ámbito ni tocar nada
             irreversible, y no se limita a repetir lo ya hecho."
  detener   "Ensancha el ámbito, repite trabajo ya cerrado, pide algo que el brief no autoriza, o
             propone un acto irreversible o de gasto aunque no use ninguna de las palabras de las
             reglas duras."

riesgo: "¿Qué riesgo tiene ejecutar el mensaje?"
  ninguno   "Lectura, análisis, código en el repo del ticket, pruebas locales."
  bajo      "Cambios reversibles en el repo del ticket, PR, comentarios."
  alto      "Toca otro repo, el clúster, ficheros del sistema o algo que no se deshace."
  dinero    "Gasta dinero, publica fuera, mueve datos o credenciales."
```

El estado que ve Jev va envuelto en `<dato-xxxx>` con nonce (el `_dato()` de `company_revalidar.py`):
la sugerencia es **dato no confiable**, y una que diga "ignora tus instrucciones" no puede cambiar la
rúbrica. Incluye resumen y criterio de aceptación del ticket, la línea de cierre del turno, la
sugerencia y `contexto.cwd`.

Umbral y escalado, idénticos a `decidir()`:

| Paso | Condición | Qué pasa |
|---|---|---|
| 1 | Jev `seguir` con `p ≥ 0,90` y `riesgo ≠ dinero` | `ok:true`, `riesgo` el suyo, `motivo:"rúbrica <p> (kev:4b)"` |
| 2 | Jev `p < 0,90`, falla o no contesta en 5 s | escala al residente (`qwen38-flash-next` por LiteLLM, `x-claude-class: company`), misma rúbrica en JSON |
| 3 | residente `p ≥ 0,90` y `riesgo ≠ dinero` | `ok:true`, `motivo:"rúbrica <p> (<modelo>)"` |
| 4 | residente `p < 0,90` o falla | `ok:false`, `riesgo:"alto"`, `motivo:"rúbrica <p> (<modelo>)"` |
| — | cualquiera de los dos dice `riesgo:"dinero"` | `ok:false`, `riesgo:"dinero"`, **sin escalar**: dinero no se negocia con un modelo |

## 6. Veredicto → qué hace cada cliente

| Situación | `ok` | `riesgo` | Compañía (supervisor) | Paseo (píldora) |
|---|---|---|---|---|
| Sugerencia buena | `true` | `ninguno` | `mensaje` al dueño con la sugerencia, prefijada `[SUPERVISOR]` | píldora normal; enviar sigue siendo el toque de Dani |
| Buena con riesgo bajo | `true` | `bajo` | igual | igual |
| D1/D2/D4/D9/D10, o rúbrica < 0,90 | `false` | `alto` | `RETOMA` de hoy; el motivo va al historial del ticket, no a Dani | sin píldora; motivo en `paseo plugin logs` |
| D3/D5/D6/D7/D8, o rúbrica `dinero` | `false` | `dinero` | `PARA DANI` con `preguntar()`; **no se autoenvía nunca** | sin píldora; la sugerencia se guarda junto a la pregunta |
| Vacía (D0) | `false` | `bajo` | `RETOMA` | sin píldora |
| Servicio caído o timeout | — | — | `RETOMA` | sin píldora |

Reglas transversales:

- `RETOMA` sigue siendo el respaldo de todo lo que no sea `ok:true`. El servicio no puede dejar un
  ticket en silencio, y por eso nunca es él quien envía.
- `PARA DANI` **nunca** se autoenvía, aunque Dani ya haya autorizado algo parecido antes: la
  autorización es por mensaje, no por clase.
- Tope anti-bucle: 3 envíos automáticos seguidos sin `ESTADO: ENTREGA`, `ESPERA:` ni `PARA DANI:` en el
  turno anterior → se deja de enviar y se pide entrega. Lo cuenta el supervisor.
- El plugin **no** se queda con un respaldo local del razonamiento: si el servicio no contesta, no hay
  sugerencia. Dos caminos fue como acabamos con dos cerebros.

## 7. Lo que el servicio no hace

- No lee transcripts, no conoce sesiones, no guarda estado.
- No envía, no escribe en el ticket, no mueve estados.
- No lee el repositorio ni el clúster: decide con el texto y el contexto que le mandan.
- No sustituye a `security` ni autoriza nada: un `ok:true` sobre un secreto es imposible por D7.

## 8. Cómo se valida cuando se implemente

Corpus congelado, uno por fila de §6 y dos paráfrasis por regla dura (p. ej. «vacía el namespace» sin
la palabra `delete`), como test de aserciones del servicio. Criterio de salida: cero falsos negativos
y un caso real registrado por cada resultado (`true`, `alto`, `dinero`) más uno por cliente (píldora y
compañía) contra el mismo servicio.