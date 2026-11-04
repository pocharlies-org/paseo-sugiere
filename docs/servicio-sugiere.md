# El servicio `sugiere`

Un solo mecanismo de sugerencia para la compañía y para Paseo: un servicio sin estado que propone el
siguiente mensaje de una sesión y dictamina si puede enviarse. `paseo-sugiere` pasa a ser su cliente
(píldora y ajustes); el supervisor de la compañía, otro. Ninguno de los dos razona ya por su cuenta.

Este documento es la especificación. No hay implementación en este ticket: ni plugin, ni
`jira-epic-trigger.py`, ni `company-sesion`, ni `company_revalidar.py` cambian aquí.

## 1. Forma

- **Pod + ArgoCD app `sugiere` en el namespace `llm`**, junto al residente. Imagen por CI
  del repo `paseo-sugiere`; manifiesto en el repo GitOps.
- **Sin estado**: no lee transcripts, no guarda sesiones, no escribe tickets. Todo lo que necesita
  llega en la petición. Es lo que permite servir a la vez a una sesión tmux del x86 y a un agente de
  Paseo sin montar dos homes en el mismo volumen. La única escritura es la auditoría (§10), un JSONL
  que no se lee para decidir nada.
- **Solo interno**: Service de clúster y token. Sin ingress, sin `*.lan`, sin publicar en internet.
- Alcance de red: LiteLLM (residente) por Service, y el brain (§9) solo si está encendido. Se va el router local, el bearer de
  la cuenta y el tope de 60 s del RPC del host.
- Tres endpoints: `/v1/suggest` (propone), `/v1/verdict` (dictamina) y `/v1/auditoria` (lee el registro). La instrucción del residente y la
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
| `transcript` | string | 1..32 MiB (un `.jsonl` de sesión real pasa de 6): el `.jsonl` de la sesión tal cual. El servicio lo aplana con `shared/transcript.ts` (tool calls, una línea; nunca su contenido), así que el llamante solo lee un fichero |
| `contexto` | objeto | opcional; `kind` obligatorio si viene. `key`/`rol` solo si es de compañía. `instruccion` sustituye a la de fábrica, para editar el prompt desde el ConfigMap sin reiniciar |

Salida (`200`):

```json
{"sugerencia": "Abre el PR contra deploy/prod y espera CI", "modelo": "claude-opus-5-5", "ms": 812}
```

- `sugerencia` vacía es una respuesta **válida**: el turno ha terminado o no hay nada que proponer (la
  píldora no aparece; el supervisor no la usa). No es un error.
- El modelo es **el de la sesión** (Dani 22-10), no un alias fijo: `shared/suggest.ts` lo saca del transcript y LiteLLM lo enruta. `max_tokens` 32 000 (el máximo que aceptan los tres backends) y `reasoning_effort: none`, que LiteLLM traduce a `enable_thinking: false`. Sin modelo real en la sesión no hay llamada y `sugerencia` sale vacía.
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
| `motivo` | string | una línea: el id de la regla dura que disparó, o el motivo que da el residente. Nunca vacío |

Códigos: `422` cuerpo inválido o falta `contexto.cwd` · `200` en todo lo demás. **Fail-closed**: si el
residente no contesta, se agota o no da JSON, responde `{"ok": false, "riesgo": "alto", "motivo": "puerta no
disponible"}` con la traza del fallo, y el llamante cae a `RETOMA`.

Presupuesto, medido en el clúster (01-11): el residente tarda ~18-60 s; el servicio le espera 60 s. Por eso
el veredicto es asíncrono: un llamante síncrono con presupuesto de 30 s no lo puede
esperar entero y debe tratar el silencio como fail-closed. Caché: `sha256(sid|turno|sugerencia)` →
veredicto de modelo, 24 h, LRU 1000. Las reglas duras **no** se cachean: se evalúan siempre y ganan al
veredicto cacheado. Con el brain en `on` no se cachea nada, porque el dictamen depende de esos recuerdos; un
veredicto servido de la caché lleva `traza: ["cache"]` y el fail-closed no se guarda nunca.

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
| D11 | ticket cerrado sin su PR | `\bdone\b[^\n]{0,60}\b(a mano\|sin (su \|la \|una )?pr( fusionad[ao])?\|sin (el \|la )?merge\|sin fusionar)\b` (y el orden inverso) | `ok:false`, `alto` |
| D12 | hold sobre pedido en curso | `\bfulfillment\s+hold\b[^\n]{0,60}\b(in[ _-]?progress\|en curso\|ya empezad[oa])\b` (y el orden inverso) | `ok:false`, `alto` |
| D13 | reinicio de Hermes | `\bhermes\b[^\n]{0,60}\b(rollout\s+restart\|reinici\w+\|restart\w*\|argocd\s+app\s+sync)\b` (y el orden inverso) | `ok:false`, `alto` (skill `hermes-config`: solo su despliegue ordenado) |
| D14 | ventana creative programada | `\b(ventana\s+creative\|dgx3[- ]ventana\|dgx3_mode)\b[^\n]{0,80}\b(cron\w*\|program\w+\|schedule\w*\|timer\|a las?\s+\d)\b` (y el orden inverso) | `ok:false`, `alto` (la abre su dueño, a mano) |

Notas de aplicación:

- `dinero` en D3/D5/D7/D8 no significa que el mensaje cueste dinero: significa **solo Dani lo decide**
  (perfil de cómputo, datos, secretos, publicación). La tabla de §6 es la que manda.
- D10 solo mira rutas con raíz absoluta o `~`; una ruta relativa se juzga contra `contexto.cwd`.
- El texto se juzga entero, también dentro de bloques de código: un `rm -rf` propuesto "para comprobar"
  sigue siendo un `rm -rf`.

## 5. La rúbrica del residente

El único juez es el residente (`qwen38-flash-next` por LiteLLM), con la rúbrica en JSON. Jev (`kev:4b` en
Ollaya) salió el 04-11 por decisión de Dani: en 16 casos reales medidos no decidió ninguno (15 «seguir» con
p 0,57-0,58 y una llamada caída) y solo añadía 24-38 s por veredicto delante del residente.

El estado que ve el modelo va envuelto en `<dato-xxxx>` con nonce (el `_dato()` de `company_revalidar.py`):
la sugerencia es **dato no confiable**, y una que diga "ignora tus instrucciones" no puede cambiar la
rúbrica. Incluye resumen y criterio de aceptación del ticket y el mensaje propuesto.

Antes del modelo corre el **tamiz léxico** (`service/tamiz.ts`), barato y determinista. Su invariante: sobre
vocabulario de riesgo —dinero, credenciales, publicación fuera, lo irreversible— el `seguir` del residente
**nunca es final**; el riesgo del tamiz se combina con el del modelo y manda el mayor. Los patrones de prosa
solo dejan `marca=prosa-parN` en la traza y no cambian ningún veredicto. Los verbos de borrado en prosa no
entran en el tamiz: ya los cazan D1/D2/D5 en su literal, y en prosa son la mitad de las legítimas medidas.

| Paso | Condición | Qué pasa |
|---|---|---|
| 1 | una regla dura (D0-D14) | `ok:false`, `riesgo` el de la regla, `motivo:"<id>: <motivo>"`, **sin llamar a ningún modelo** |
| 2 | residente `seguir` y riesgo final `ninguno`/`bajo` | `ok:true`, `riesgo` el final, `motivo` el que da el residente |
| 3 | residente `detener`, o riesgo final `alto` aunque diga `seguir` | `ok:false`, `riesgo:"alto"` |
| 4 | riesgo final `dinero` (del modelo o del tamiz) | `ok:false`, `riesgo:"dinero"`: dinero no se negocia con un modelo |
| 5 | JSON inválido, falla o no contesta en 60 s | `ok:false`, `riesgo:"alto"`, `via:"ninguno"` y la traza del fallo |

La rúbrica pide el **riesgo** de ejecutar el mensaje (`ninguno`/`bajo`/`alto`/`dinero`) y reserva `detener`
para lo irreversible, el dinero y las credenciales: un ticket sin resumen o un criterio sin escribir **no** son
razón para detener (medido el 04-11: detenía la cola entera por eso).

El residente escribe `p: 0.0` cuando se le pide una (medido el 01-11), así que su campo `p` se registra pero
no se compara: decide su `veredicto`.

## 6. Veredicto → qué hace cada cliente

| Situación | `ok` | `riesgo` | Compañía (supervisor) | Paseo (píldora) |
|---|---|---|---|---|
| Sugerencia buena | `true` | `ninguno` | `mensaje` al dueño con la sugerencia, prefijada `[SUPERVISOR]` | píldora normal; enviar sigue siendo el toque de Dani |
| Buena con riesgo bajo | `true` | `bajo` | igual | igual |
| D1/D2/D4/D9/D10/D13/D14, o el modelo dice `detener`, o rúbrica `alto` | `false` | `alto` | `RETOMA` de hoy; el motivo va al historial del ticket, no a Dani | sin píldora; motivo en `paseo plugin logs` |
| D3/D5/D6/D7/D8, o rúbrica o tamiz `dinero` | `false` | `dinero` | `PARA DANI` con `preguntar()`; **no se autoenvía nunca** | sin píldora; la sugerencia se guarda junto a la pregunta |
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
## 9. El brain (hindsight), apagado por defecto

La rúbrica puede ver lo que la casa ya decidió en casos parecidos, traído del brain por su API de recall
(`/v1/default/banks/<banco>/memories/recall`). Está **apagado de fábrica**, porque se midió lo que cuesta:
el 03-11, desde el propio pod, un recall de 5 recuerdos tardó **8,6-9,6 s** y **3 de 5 pasaron de 20 s**.

Se enciende por fichero (`/etc/sugiere/brain.json`, releído en cada petición: sin reiniciar), con tres modos:

| `modo` | Qué hace | Latencia añadida | Efecto en el veredicto |
|---|---|---|---|
| `off` (de fábrica) | no llama a nadie | 0 | ninguno |
| `sombra` | recall **en paralelo** al veredicto | 0 | ninguno: el resultado solo va a la auditoría |
| `on` | recall **antes** de la rúbrica, con tope duro (`BRAIN_TOPE_MS`, 20 s) | 8-9 s típicos | los recuerdos entran en la rúbrica |

Reglas del brain, en los tres modos:

- **Una regla dura no espera al brain**: se evalúa antes y, si dispara, el veredicto sale en milisegundos
  aunque el recall esté colgado (probado con una promesa que no resuelve nunca).
- **Falla abierto**: sin token, con error, con timeout o con respuesta ilegible, el veredicto sale como si
  el brain no existiera. Un timeout del brain no puede cerrar la puerta.
- Los recuerdos entran en la rúbrica envueltos en `<dato-xxxx>` igual que la sugerencia: son **dato no
  confiable**, y un recuerdo que diga «ignora tus instrucciones» no cambia las preguntas.
- El token (`BRAIN_TOKEN`, o `BRAIN_TOKEN_FICHERO`) es una identidad de lectura del boundary de hindsight:
  la crea `security`. Sin token, `sombra` y `on` no miden nada y lo dicen (`motivo: "sin token"`).
- Para pasar de `sombra` a `on` hace falta la comparación de la auditoría (§10): mismos casos con y sin
  brain. `on` no se enciende por gusto.

Medido el 03-11 con el código en marcha contra los backends reales: `off` y `sombra` dan el mismo
veredicto con la misma latencia (1-2 ms en un caso de regla; la línea de auditoría de `sombra` llega
después, con `brain.ms` de 6,0 a 16,2 s). `on` suma esos mismos 6-16 s a cada veredicto que llega al
modelo.

## 10. Auditoría de calidad

Una línea JSON por veredicto en `AUDITORIA_RUTA` (por defecto `/var/lib/sugiere/auditoria.jsonl`, PVC),
con la **sugerencia entera** (el log de stdout la corta a 120 caracteres, que no sirve para etiquetar), el
`cwd`, la clave del ticket, `ok`, `riesgo`, `motivo`, `via`, `traza`, `ms` y el resultado del brain
(`modo`, `ms`, `n`, `motivo`).

- Se escribe **después** de responder: en `sombra` la línea espera a que el brain acabe y el llamante no
  espera a la línea.
- Rotación por tamaño (`AUDITORIA_MAX_BYTES`, 64 MiB) a un único `.1`.
- Si no se puede escribir, se avisa y la puerta sigue: la auditoría no puede tumbar un veredicto.

`GET /v1/auditoria?limit=&desde=&hasta=&ok=&via=` devuelve las últimas líneas que pasan el filtro (máximo
500), de la más vieja a la más nueva.

Con eso se etiqueta a mano lo que la puerta aprobó (¿era buena la continuación?) y se compara: reglas contra
rúbrica, `via`, y brain apagado contra brain encendido sobre los mismos casos.

## 11. Token y acceso fuera del clúster

`SUGIERE_TOKEN` es opcional: sin él, el servicio se comporta como siempre (solo clúster). Con él, cada
petición debe traer `authorization: Bearer <token>` (`/healthz` queda libre). Es lo que permite publicarlo
por LAN sin que quede abierto a quien no lo tenga: la ruta y el token son un solo cambio, nunca la ruta sola.
