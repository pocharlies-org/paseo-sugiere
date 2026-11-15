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
  entre repos.
- `server/session.ts` — localizar el transcript y la única llamada a LiteLLM (fetch).
- `server/suggest.ts` — ventana de silencio de 60 s con `seq`: un turno nuevo mata la
  sugerencia pendiente y descarta una respuesta en vuelo.
- `server/pares.ts` — lectura del registro de parejas del supervisor (`~/.company/jira-trigger/autopilot-pares.json`, contrato
  `file.autopilot.pares.v1`, productor el supervisor de la compañía): `{version:1, pares:{[a_id]: Par}}`. Solo lectura: ausente =
  sin pareja; ilegible / no-JSON / v1 incompleto = estado desconocido sin romper la píldora. El plugin nunca escribe este fichero.
- `server/supervisor.ts` — la mitad del plugin de la API de autopilot del supervisor (contrato `http.supervisor.autopilot.v1`):
  `POST /autopilot/par` (cuerpo del contrato: id/cwd/título de A, objetivo — la `key` del ancla de paseo-plan o un prompt —,
  modelo del auditor, `origen: "paseo"`) y `DELETE /autopilot/par/<a_id>`, con `X-Company-Token` de
  `~/.company/jira-trigger/secret` y base `http://company.paseo.svc.cluster.local:19911` (env `SUPERVISOR_URL`). La respuesta se
  convierte en `{ok, error?}` y el error se enseña una vez en el popover. El plugin no pilota ni decide: eso es de la sesión
  auditora B, que crea el supervisor.
- `client/suggest-pill.tsx` — píldora en el composer; sondea 10 s solo agentes
  `idle`; el texto se tira al salir de idle, al enviar y al pasarlo al prompt. Su icono es el ancla del puente. Nada entra en el prompt
  por su cuenta: una generación terminada se queda en la píldora de su ventana hasta que se pulsa su botón (Dani 02-11). El popover intenta
  primero el puente y solo pinta su tarjeta si no pudo: el propio campo más un botón pequeño de enviar a su derecha, sin caja ni
  bordes y con la altura del texto (el popover del host ya enmarca).
- `client/composer-bridge.ts` — **atajo declarado** (`shortcut:`): la SDK de Paseo (hasta 0.15.4; 0.16 trae `useComposer`) no tiene API del borrador
  del composer, así que desde el icono de la píldora sube por el DOM hasta el primer ancestro que tenga un `textarea[data-composer-input]`
  y lo toma solo si es el único y está a la vista; le añade el texto como si se tecleara (`execCommand("insertText")`, y de respaldo el
  setter del prototipo más un evento
  `input`), de modo que el `onChangeText` del host sigue siendo el único que escribe el borrador. Con dos composers en ese ancestro, con
  el propio del panel oculto (la ventana del agente está detrás: seguir subiendo acabaría escribiendo en la ventana que Dani tiene
  delante, que es lo que pasaba el 02-11), con la píldora fuera de pantalla, sin DOM (iOS/Android), o en layout compacto (el panel puede
  ir en un sheet sin composer propio),
  devuelve `false` y la píldora abre su popover. Un update de Paseo que mueva `data-testid="message-input-root"` o
  `data-composer-input` produce el mismo respaldo, nunca una escritura en otro agente. **Retirada**: se borra cuando la SDK exponga el
  borrador (discusión getpaseo/paseo#4688), o si dos updates seguidos de Paseo lo rompen sin esa API.
- `index.server.ts` / `index.client.tsx` — enganche a los hooks `agent.turn_ended` /
  `agent.turn_started`, al RPC `suggest.get` y al ajuste `enabled`
  (`registerSettings`, host): al desactivar, `setEnabled(false)` tira pendientes y mostradas y
  `arm` deja de programar generaciones; `quietSeconds` es la ventana de silencio. La instrucción del modelo no
  pasa por aquí: vive solo en el servicio (decisión 5). Con «Garantizar plan» (`anchor-<agentId>.json` de paseo-plan con
  `guard` y criterios) `arm` genera al acabar el turno, sin ventana, y manda el ancla en `contexto.plan`; `suggest.feedback` cuenta
  los «no es esto» (tres seguidos callan la ✦ hasta un clic). El autopilot ya no cuelga de aquí (14-11-2026): con pareja viva la
  píldora pinta el estado del registro y la única generación por turno la decide el supervisor; `agent.turn_ended` va a `arm` y
  `agent.turn_started` a `cancel`, como sin autopilot. El RPC `suggest.get` añade la pareja leída por `pares.ts` (con el auditor
  mejorado al título de B vía `paseo.agents.list`) y el plan del ancla para el formulario; `autopilot.start` y `autopilot.stop`
  atienden el formulario y llaman a `supervisor.ts`.
  Arranca además `scripts/autodeploy.sh` cada 5 min: el plugin se redespliega solo cuando el tronco de GitHub
  trae un commit nuevo (`deploy.sh` acepta un árbol sin git por `DEPLOY_SHA`).
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

- `requirements.paseo` pide `>=0.15.4`, sin tope: `deploy.sh` no despliega en un host más viejo, pero un Paseo
  nuevo que rompa el SDK solo se ve al cargar el plugin; el tipado y los tests van contra 0.15.4.
- El ahorro por KV-cache (APC) es la hipótesis de diseño, no una medición en vivo.

## Publicación

El repo es público y está listado en el registro de Paseo (paseo.sh/plugins): su ficha es `plugins/pocharlies-org/paseo-sugiere.json` en
getpaseo/plugins y **fija un commit**. Fusionar aquí no cambia la ficha: las actualizaciones de un plugin por Git son manuales (PR nuevo al
registro con el commit nuevo). El autodeploy de arriba es de esta casa y no forma parte de lo que instala el registro. `OVERVIEW.md` y las
capturas de `docs/media/` son lo que muestra la ficha; si cambia la interfaz de la píldora, se rehacen.
