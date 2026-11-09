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
  (30/60/120/300 s) y los topes del autopilot (pasos seguidos y por sesión; 0 = sin tope, lo de fábrica). El documento vive en
  el host (`shared/settings.ts`); el server lo obedece al vuelo.
- La instrucción vive solo en el servicio `sugiere` (decisión 5 de Dani): el plugin no manda ninguna y
  `~/.local/state/paseo-sugiere/prompt.txt` ya no se lee. No hay editor en la píldora: la píldora es para enviar (Dani 17-10).
- **Garantizar plan**: si `~/.local/state/paseo-plan/anchor-<agentId>.json` (lo escribe paseo-plan) tiene
  `guard: true` y criterios, al acabar cada turno de ese agente se pide la sugerencia con el plan, sin ventana de silencio y aunque
  `auto` esté apagado. La ✦ enseña la insignia (▸ paso del plan, ✚ trabajo nuevo, ✓ verificar) y el criterio; al lado sale
  «no es esto», y tres seguidos callan la ✦ hasta que la pulses. Enviar sigue siendo tu toque.
- La ✦ sin sugerencia abre un popover: «Sugerir ahora» (el force de siempre) y el interruptor **Autopilot** de ese agente (también
  en la tarjeta del móvil). Encendido, al acabar cada turno `completed` el plugin pregunta a `POST /v1/autopilot` del servicio
  (`contexto.kind: "live"`, `cwd`, la `key` del ancla, el plan si hay guarda, `nativa` solo sin plan, y `topes` de los ajustes;
  plazo 330 s) y obedece: `enviar` → manda el mensaje si no empezó otro turno (`seq`); `esperar` → ✦ dorada «esperando: …»;
  `humano` → ✦ rojo brillante con pulso (sin animación con movimiento reducido) hasta el siguiente mensaje; `cerrar` → archiva el
  agente. Un 503, sin respuesta o una lectura fallida de la sesión se reintenta una vez a los 60 s; si vuelve a fallar, rojo con la causa. Con el autopilot encendido no se genera
  sugerencia (una sola llamada por turno). Estado en `~/.local/state/paseo-sugiere/autopilot.json`
  (`{agentId: {on, desde, estado, motivo, decidido?, pasos?, enviado?}}`). Al arrancar, una evaluación de los agentes con autopilot `idle` cuyo último mensaje es
  del asistente (en la primera llamada que trae el host: la SDK no da `paseo` al arrancar). Es distinto de «Sugerir
  automáticamente», que solo propone.

## Qué lee y envía

Lee el transcript del agente (`~/.claude*/projects/**/*.jsonl` vía `~/.paseo/config.json`). No lee
cuentas ni tokens. A la red manda dos cosas: la llamada a LiteLLM (con el modelo de la sesión) y, para mantenerse al día del
tronco, el `git ls-remote`/`git clone` de su propio repo en GitHub (con las credenciales de git del usuario). Nada de
eso llega a la app.

## Instalación

Desde el clon, en el trunk:

```sh
scripts/deploy.sh
```

Empaqueta como el plugin de cuentas: carpeta versionada `~/.local/share/paseo-sugiere/paseo-plugin/<versión>-<git sha>`
y enlace `current`; instala (`paseo plugin install <current>`) la primera vez y recarga (`paseo plugin reload
paseo-sugiere`) en adelante. El daemon apunta al `current`, no al clon. Comprueba antes `paseo --version` contra
`requirements.paseo` del manifiesto: fuera de rango no despliega y lo dice. Sin reiniciar el daemon.

Después de esa primera vez no se vuelve a tocar: `scripts/autodeploy.sh` mira el tronco de GitHub y, si hay un commit que no está
desplegado, lo baja y llama a `deploy.sh`. Lo lanza el propio server del plugin cada 5 min (y al arrancar, por si el merge cayó
con Paseo cerrado), así que **lo que está fusionado es lo que corre**. Necesita `git` con credenciales para el repo y escribe su
bitácora en `~/.local/state/paseo-sugiere/autodeploy.log`.

## Pruebas

`npm ci && npm run typecheck && npm test`. La ventana de silencio y el parseo se testean sin red; la
llamada a LiteLLM se prueba con el transporte simulado.
