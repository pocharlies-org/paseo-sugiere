# paseo-sugiere

Plugin de Paseo: al acabar un turno y pasar la sesión un minuto en silencio, el residente propone el
mensaje que el usuario debería enviar a continuación, y lo muestra como píldora en el composer de ese
agente. El menú de la píldora lo envía como siguiente mensaje o lo descarta; cualquier turno nuevo
tira la sugerencia pendiente. Es el port del `session-assist` que funcionaba en el fork de
OpenChamber.

Es un plugin hermano del de [claude-account-switcher](https://github.com/pocharlies-org/claude-account-switcher):
comparte reglas de lectura (el contrato `file.claude-cuentas.v1` — solo lee `<id>.token`, nunca
escribe) y el mismo router local, pero es código propio en repo propio.

## Cómo funciona

- `agent.turn_ended` (completed) abre una ventana de silencio de 60 s; `agent.turn_started` la cierra.
- Al expirar, una sola llamada sin herramientas con el transcript de la sesión al residente
  (alias fijo `qwen38-off`, por el router local en `127.0.0.1` con el bearer de la cuenta dueña de la
  sesión). El transcript se aplanaba igual que en las preguntas laterales: los tool calls dejan una
  línea, nunca su contenido.
- El prompt es apéndice-estable (el transcript solo crece; la instrucción fija va al final), así que
  del segundo aviso de una misma sesión en adelante el motor del residente acierta el prefijo y solo
  se pagan ~40 tokens de la respuesta. Con la sesión en reposo no se llama a nada.
- Trabajo terminado, ofertas opcionales o decisiones del usuario → sugerencia vacía → la píldora no
  aparece. El envío es siempre un toque del usuario.

## Qué lee y envía

Lee el transcript del agente (`~/.claude*/projects/**/*.jsonl` vía `~/.paseo/config.json`) y el token
de la cuenta dueña (`~/.config/claude-cuentas/<id>.token`, lectura sola, nunca guardado). Envía una
sola cosa: la llamada al router en `127.0.0.1:18791`. Nada de eso llega a la app.

## Instalación

```sh
paseo plugin install ~/src/paseo-sugiere
```

## Pruebas

`npm ci && npm run typecheck && npm test`. La ventana de silencio y el parseo se testean sin red; la
ruta al router es la misma medida por las preguntas laterales del plugin de cuentas.
