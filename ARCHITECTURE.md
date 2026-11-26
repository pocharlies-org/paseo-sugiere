# ARCHITECTURE — paseo-sugiere

Qué es este repo y por qué está separado, según la evaluación del architect (13-10).

## Rol

Plugin de Paseo que sugiere el siguiente mensaje del usuario. No es parte de
claude-account-switcher: ese repo publica la extensión VS Code y el conmutador de
cuentas; este repo es un plugin de Paseo con otro ciclo de vida y otro público. La
única relación entre ambos es el aplanado del transcript (copia declarada). La llamada va a LiteLLM
(url y clave de `~/.config/claude-local/env`) con **el modelo de la sesión** (`message.model` del último mensaje real del asistente;
sin modelo real no hay llamada ni modelo de respaldo, Dani 22-10), y **no se consume el contrato
`file.claude-cuentas.v1`**: no se lee `~/.config/claude-cuentas`. Coste: cada sugerencia envía la conversación (hasta ~100k tokens)
al modelo de la sesión, sin compartir la caché de la sesión.

## Ficheros

- `shared/suggest.ts` — la instrucción fija, el cuerpo apéndice-estable (con el modelo de la sesión, o `null` si no lo hay) y el parseo.
- `shared/transcript.ts` — aplanado del transcript. **Copia declarada** del
  aplanado de `paseo-plugin/shared/ask.ts` del repo hermano (hallazgo 6): se copió
  en vez de extraer un paquete común porque son dos repos con ciclos de release
  distintos y el aplanado son ~60 líneas estables. Si el de cuentas cambia, este no
  lo sabe; la duplicación es a propósito y `duplicados` (jscpd) no la ve porque es
  entre repos. `newestMessage` (el último mensaje de conversación y si cierra un turno, para
  validar la sugerencia nativa) **no** es parte de esa copia: es código propio de este repo.
- `server/session.ts` — localizar el transcript de la sesión, las llamadas (fetch) al servicio `sugiere` del clúster (`/v1/suggest` y
  `/v1/verdict`) y la lectura de la sugerencia nativa del daemon (`nativeSuggestion`, contrato `file.paseo.suggest-native.v1`: se
  valida contra el último mensaje del transcript y se consume al servirla).
- `server/suggest.ts` — ventana de silencio de 60 s con `seq`: un turno nuevo mata la
  sugerencia pendiente y descarta una respuesta en vuelo.
- `server/pares.ts` — lectura del registro de parejas del supervisor (`~/.company/jira-trigger/autopilot-pares.json`, contrato
  `file.autopilot.pares.v1`, productor el supervisor de la compañía): `{version:1, pares:{[a_id]: Par}}`. Solo lectura: ausente =
  sin pareja; ilegible / no-JSON / v1 incompleto = estado desconocido sin romper la píldora. El plugin nunca escribe este fichero.
- `server/supervisor.ts` solo permite parar una pareja anterior (`DELETE /autopilot/par/<a_id>`). No crea sesiones ni decide el siguiente mensaje.
- `client/suggest-pill.tsx` — píldora en el composer; no pregunta nunca con reloj: una sola llamada `suggest.watch`
  retenida por app, que el servidor contesta cuando cambia algún agente y que se reabre al responder (tras un fallo, al siguiente
  cambio de turno o snapshot de agentes); el popover abierto del autopilot oye su pareja por suscripción. El texto se tira al salir de idle, al enviar y al pasarlo al prompt. Su icono es el ancla del puente. Nada entra en el prompt
  por su cuenta: una generación terminada se queda en la píldora de su ventana hasta que se pulsa su botón (Dani 02-11). El popover intenta
  primero el puente y solo pinta su tarjeta si no pudo: el propio campo más un botón pequeño de enviar a su derecha, sin caja ni
  bordes y con la altura del texto (el popover del host ya enmarca).
- `client/composer-bridge.ts` — **atajo declarado** (`shortcut:`): la SDK de Paseo trae `useComposer` desde 0.16, pero este puente aún no migra a ella,
  así que desde el icono de la píldora sube por el DOM hasta el primer ancestro que tenga un `textarea[data-composer-input]`
  y lo toma solo si es el único y está a la vista; le añade el texto como si se tecleara (`execCommand("insertText")`, y de respaldo el
  setter del prototipo más un evento
  `input`), de modo que el `onChangeText` del host sigue siendo el único que escribe el borrador. Con dos composers en ese ancestro, con
  el propio del panel oculto (la ventana del agente está detrás: seguir subiendo acabaría escribiendo en la ventana que Dani tiene
  delante, que es lo que pasaba el 02-11), con la píldora fuera de pantalla, sin DOM (iOS/Android), o en layout compacto (el panel puede
  ir en un sheet sin composer propio),
  devuelve `false` y la píldora abre su popover. Un update de Paseo que mueva `data-testid="message-input-root"` o
  `data-composer-input` produce el mismo respaldo, nunca una escritura en otro agente. **Retirada**: se borra al migrar a `useComposer`
  (discusión getpaseo/paseo#4688), o si dos updates seguidos de Paseo lo rompen.
- `index.server.ts` une los turnos de Paseo con `server/suggest.ts`. Sugerir entrega el texto a la píldora; en «Seguir en automático» el mismo generador toma el objetivo revisado y somete cada envío a `/v1/verdict`. Parar invalida cualquier respuesta pendiente. El seguimiento es por sesión y no se reanuda tras reiniciar el plugin.
- `server/vigilia.ts` notifica a la píldora por `suggest.watch` cuando cambia el estado.
- `client/estado-agentes.ts` + `client/workspace-badge.tsx` — la insignia de la fila de cada workspace en la barra lateral
  (`addWorkspaceRowBadgeItem`, SDK 0.16.2): cuántos de sus agentes están en autopilot o siguiendo ahora, en rojo si alguno
  pide a una persona (`humano` · `degradada`). Se pinta del mismo estado que ya empuja `suggest.watch`: la píldora lo escribe
  en ese almacén al aplicarlo y la insignia lo lee, así que no hay un segundo reloj ni una segunda llamada retenida. Sin
  nadie en marcha no pinta nada. El mapa agente → workspace sale de la lista de agentes del host, no del servidor.
- `client/suggest-settings.tsx` — pantalla de ajustes propia (`addSettingsScreen` + `useSettings`):
  interruptor y ventana de silencio (los topes del autopilot murieron con su bucle: los pasos los decide el supervisor); el documento compartido está en `shared/settings.ts`.

## Superficie

Los RPCs del plugin solo los consume su propio client. El servicio `sugiere` sí publica hacia otros repos: el supervisor de
la compañía (x86-host-runtime, `libexec/sugiere_puerta.py`) consume `/v1/suggest` y `/v1/verdict`; `/v1/autopilot` está
deprecada desde el 14-11-2026 (el plugin dejó de llamarla: el autopilot es la sesión auditora del supervisor, que produce
`file.autopilot.pares.v1` y sirve `http.supervisor.autopilot.v1`, los dos consumidos por el plugin). Esa superficie está en
`CONTRACTS.yaml` de la raíz.
`service/cierre.ts` es una copia declarada y permanente de la gramática del cierre del supervisor; el corpus
`test/fixtures/cierre.json` lo genera su Python (spec §12).

## Riesgos conocidos

- `requirements.paseo` pide `>=0.16.0`, sin tope: lo comprueba el cliente (no el daemon) al cargar el plugin, y con
  la app por detrás el plugin figura cargado pero no pinta nada (19-11). El badge de fila
  (`addWorkspaceRowBadgeItem`, 0.16.2) va tras `?.`: en un cliente anterior se pierde el badge, no la píldora. El
  tipado y los tests van contra 0.16.2.
- El ahorro por KV-cache (APC) es la hipótesis de diseño, no una medición en vivo.

## Publicación

El repo es público y está listado en el registro de Paseo (paseo.sh/plugins): su ficha es `plugins/pocharlies-org/paseo-sugiere.json` en
getpaseo/plugins y **fija un commit**. Fusionar aquí no cambia la ficha: las actualizaciones de un plugin por Git son manuales (PR nuevo al
registro con el commit nuevo). En esta casa un merge a `main` se despliega solo en el daemon de paseo-0: el supervisor de la compañía recibe el PR fusionado por Synapse y
ejecuta `paseo plugin update paseo-sugiere --ref <sha>` (x86-host-runtime); el plugin no sondea nada. `OVERVIEW.md` y las
capturas de `docs/media/` son lo que muestra la ficha; si cambia la interfaz de la píldora, se rehacen.
