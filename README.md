# paseo-sugiere

> Listing overview, requirements and what the plugin reads, sends and writes (in English): [OVERVIEW.md](OVERVIEW.md).

Plugin de Paseo: al acabar un turno y pasar la sesión un minuto en silencio, el mismo modelo de la sesión propone el
mensaje que el usuario debería enviar a continuación, y lo muestra como píldora en el composer de ese
agente. Nada entra en el prompt sin pulsar: la sugerencia espera en la píldora de su ventana, y el puente escribe solo en el composer de
esa ventana — si no está delante (pestaña o ventana cambiada) no escribe en ninguna otra y la píldora la guarda hasta que la pulses
(Dani 02-11). Al pulsarla, en web y escritorio el texto se añade al prompt de ese agente (una línea debajo de lo que ya hubiera, sin
reemplazarlo) para revisarlo y enviarlo con el Enter normal. Donde eso no se puede (móvil, layout compacto, prompt no localizable o
ambiguo) sale la tarjeta: el texto ya editable en el sitio, sin bordes ni caja propia, en un campo de dos líneas con scroll.
En móvil usa la entrada de Paseo integrada con el teclado de la hoja y un botón «Send ↑» de al menos 44 puntos debajo del texto,
alineado a la izquierda; en escritorio mantiene la flecha a la derecha. Enter o el botón manda lo que haya en el campo
(como lo sugiera el modelo o editado por el usuario); Mayús+Enter inserta saltos de línea. Cualquier turno nuevo tira la sugerencia pendiente. Es el port del `session-assist` que funcionaba en el fork de OpenChamber.

Es un plugin hermano del de [claude-account-switcher](https://github.com/pocharlies-org/claude-account-switcher):
no consume su contrato `file.claude-cuentas.v1`: la llamada va a LiteLLM con la url y la clave de
`~/.config/claude-local/env`, así que aquí no se lee ninguna cuenta. El aplanado del transcript es una copia declarada de
`shared/ask.ts` del repo hermano (ver `ARCHITECTURE.md`).

## Cómo funciona

- `agent.turn_ended` (completed) abre una ventana de silencio de 60 s; `agent.turn_started` la cierra.
- Primero, la **sugerencia nativa**: el daemon parcheado deja la que el CLI de Claude Code bifurca del prefijo **cacheado** de la
  propia sesión, con su mismo modelo (Claude, GPT o Alibaba por LiteLLM), en `$PASEO_HOME/.paseo/suggest/<sid>.json`; solo se
  paga el decode. Si no hay una fresca (≤ 15 min), el servicio `sugiere` del clúster con `kind: "live"`: mismo modelo que la
  sesión (el `message.model` del último mensaje del asistente; se ignora `<synthetic>`), sin compartir su caché. La compañía
  llama al mismo servicio sin `kind` y le contesta el residente local (Dani 06-11). Si la sesión aún no tiene un modelo real no
  se llama a nada: el force de la píldora muestra «la sesión aún no tiene modelo». Los tool calls del transcript dejan una línea,
  nunca su contenido.
- El prompt es apéndice-estable (el transcript solo crece; la instrucción fija va en `system`) y la respuesta no tiene tope práctico
  (`max_tokens` 32 000). **Coste**: cada sugerencia envía la conversación (hasta ~100k tokens) al modelo de la sesión, sin compartir la caché
  de la propia sesión. Con la sesión en reposo no se llama a nada.
- Trabajo terminado, ofertas opcionales o decisiones del usuario → sugerencia vacía → la píldora no
  aparece. El envío de una sugerencia es siempre un toque del usuario.
- Configurable: pantalla propia «Sugerencia del siguiente mensaje» en los ajustes de Paseo — interruptor
  `enabled` (al desactivar se tiran las sugerencias pendientes y mostradas) y ventana de silencio
  (30/60/120/300 s). El documento vive en
  el host (`shared/settings.ts`); el server lo obedece al vuelo.
- La instrucción vive solo en el servicio `sugiere` (decisión 5 de Dani): el plugin no manda ninguna y
  `~/.local/state/paseo-sugiere/prompt.txt` ya no se lee. No hay editor en la píldora: la píldora es para enviar (Dani 17-10).
- **Garantizar plan**: si `~/.local/state/paseo-plan/anchor-<agentId>.json` (lo escribe paseo-plan) tiene
  `guard: true` y criterios, al acabar cada turno de ese agente se pide la sugerencia con el plan, sin ventana de silencio y aunque
  `auto` esté apagado. La ✦ enseña la insignia (▸ paso del plan, ✚ trabajo nuevo, ✓ verificar) y el criterio; al lado sale
  «no es esto», y tres seguidos callan la ✦ hasta que la pulses. Enviar sigue siendo tu toque.
- La ✦ sin sugerencia abre un popover: «Sugerir ahora» (el force de siempre) y el **Autopilot** de ese agente (también
  en la tarjeta del móvil), que ya no es un interruptor del plugin sino un formulario de arranque (14-11-2026): objetivo —
  «Plan vinculado» (elegible solo si el ancla de paseo-plan tiene ticket y al menos un criterio; se muestra como
  `CLAVE · n criterios`) o «Prompt» (texto) — y modelo del auditor (los modelos del proveedor de la sesión,
  `claude-opus-5-5` si lo ofrece). «Empezar» llama al supervisor de la compañía (`POST /autopilot/par`, cabecera
  `X-Company-Token` de `~/.company/jira-trigger/secret`, base `http://company.paseo.svc.cluster.local:19911`, env
  `SUPERVISOR_URL`), que crea la sesión auditora B: B planifica, audita contra los criterios y escribe el siguiente mensaje
  de A; el plugin solo arranca y para la pareja y enseña su estado («Parar» = `DELETE /autopilot/par/<a_id>`). El host corta
  el RPC a los 30 s y el supervisor tarda más en crear B: pasados 25 s «Empezar» responde ok con la pareja ya reservada en el
  registro (`activa`) y la ✦ cuenta cómo acaba, el mismo plazo que Goal (`arrancarEnPlazo`, `server/goal.ts`). Con la pareja
  viva la ✦ habla por ella: amarilla y girando (`activa`/`pensando`/`esperando`), roja brillante con pulso cuando hace falta
  una persona (`humano`) o roja fija cuando el auditor dejó de responder (`degradada`), verde al entregar (`entregada`); el
  popover da el motivo, los pasos, el último envío y el auditor. El estado viene del registro del supervisor
  (`~/.company/jira-trigger/autopilot-pares.json`): fichero ausente = sin pareja; ilegible = estado desconocido sin romper la
  píldora. Un error del supervisor se enseña una vez en el popover. Es distinto de «Sugerir automáticamente», que solo propone.
- **Goal** en la cabecera de cada workspace (15-11-2026): una sesión nueva que nace con su autopilot. Formulario:
  el goal, el modelo de la sesión y el del auditor (proveedor `claude`, `claude-opus-5-5` por defecto). «Empezar» crea la
  sesión en ese workspace sin primer mensaje y en `bypassPermissions`, y arranca su pareja con el goal como objetivo
  «Prompt» (el mismo `POST /autopilot/par`): el primer mensaje de la sesión lo escribe el auditor. El host corta el RPC a
  los 30 s y crear la sesión más el auditor tarda más: pasados 25 s el formulario se cierra con la sesión ya creada y su ✦
  dice cómo acaba la pareja. Si el supervisor la rechaza, el formulario da su motivo y la sesión queda (su ✦ reintenta);
  nunca se archiva por una respuesta que no llegó. Sale también en un workspace sin sesiones.

## Qué lee y envía

Lee el transcript del agente (`~/.claude*/projects/**/*.jsonl` vía `~/.paseo/config.json`). No lee
cuentas ni tokens. A la red manda dos cosas: la llamada a LiteLLM (con el modelo de la sesión) y, para mantenerse al día del
tronco, el `git ls-remote`/`git clone` de su propio repo en GitHub (con las credenciales de git del usuario). Nada de
eso llega a la app.

## Instalación

```sh
paseo plugin add git:pocharlies-org/paseo-sugiere --ref main
```

El daemon lo instala desde el checkout git y comprueba `requirements.paseo` del manifiesto. Después no se vuelve a tocar: en
esta casa un merge a `main` lo despliega el supervisor de la compañía, que recibe el PR fusionado por Synapse
(`webhook.github.received`) y ejecuta `paseo plugin update paseo-sugiere --ref <sha>` contra el daemon de paseo-0 (opt-in
`PLUGINS_GIT` en x86-host-runtime). Al arrancar, el supervisor compara una vez el tronco con el commit vivo, por si el
merge cayó con él parado. El plugin no sondea nada.

## Pruebas

`npm ci && npm run typecheck && npm test`. La ventana de silencio y el parseo se testean sin red; la
llamada a LiteLLM se prueba con el transporte simulado.
