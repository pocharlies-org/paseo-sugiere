# paseo-sugiere

Plugin de Paseo: al acabar un turno y pasar la sesión un minuto en silencio, el residente propone el
mensaje que el usuario debería enviar a continuación, y lo muestra como píldora en el composer de ese
agente. La tarjeta de la píldora es el texto ya editable en el sitio, sin bordes ni caja propia y con la altura justa del texto:
Enter manda lo que haya en el campo (como lo sugiera el residente o editado por el usuario), Mayús+Enter saltos de línea;
cualquier turno nuevo tira la sugerencia pendiente. Es el port del `session-assist` que funcionaba en el fork de OpenChamber.

Es un plugin hermano del de [claude-account-switcher](https://github.com/pocharlies-org/claude-account-switcher):
usa el mismo router local, pero no consume el contrato `file.claude-cuentas.v1` — para un alias local
como `qwen38-off` el router descarta el bearer (medido 13-10: 200 con un token falso), así que aquí no
se lee ninguna cuenta ni ningún token. El aplanado del transcript es una copia declarada de
`shared/ask.ts` del repo hermano (ver `ARCHITECTURE.md`).

## Cómo funciona

- `agent.turn_ended` (completed) abre una ventana de silencio de 60 s; `agent.turn_started` la cierra.
- Al expirar, una sola llamada sin herramientas con el transcript de la sesión al residente
  (alias fijo `qwen38-off`, por el router local en `127.0.0.1` con el bearer de la cuenta dueña de la
  sesión). El transcript se aplanaba igual que en las preguntas laterales: los tool calls dejan una
  línea, nunca su contenido.
- El prompt es apéndice-estable (el transcript solo crece; la instrucción fija va al final), así que
  del segundo aviso de una misma sesión en adelante se espera que el motor del residente acierte el
  prefijo (APC) y solo se pague el decode de la respuesta (≤48 tokens por tope, `max_tokens`). La
  ganancia real de prefijo no está medida en vivo todavía. Con la sesión en reposo no se llama a nada.
- Trabajo terminado, ofertas opcionales o decisiones del usuario → sugerencia vacía → la píldora no
  aparece. El envío es siempre un toque del usuario.
- Configurable: pantalla propia «Sugerencia del siguiente mensaje» en los ajustes de Paseo — interruptor
  `enabled` (al desactivar se tiran las sugerencias pendientes y mostradas) y ventana de silencio
  (30/60/120/300 s). El documento vive en el host (`shared/settings.ts`); el server lo obedece al vuelo.
- La instrucción que recibe el residente se cambia a mano en `~/.local/state/paseo-sugiere/prompt.txt` (vacío = la del plugin; se
  lee con cada generación, no hace falta reiniciar). No hay editor en la píldora: la píldora es para enviar (Dani 17-10).

## Qué lee y envía

Lee el transcript del agente (`~/.claude*/projects/**/*.jsonl` vía `~/.paseo/config.json`). No lee
cuentas ni tokens. A la red manda dos cosas: la llamada al router en `127.0.0.1:18791` y, para mantenerse al día del
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
ruta al router es la misma medida por las preguntas laterales del plugin de cuentas.
