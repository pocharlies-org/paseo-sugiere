# ARCHITECTURE — paseo-sugiere

Qué es este repo y por qué está separado, según la evaluación del architect (13-10).

## Rol

Plugin de Paseo que sugiere el siguiente mensaje del usuario. No es parte de
claude-account-switcher: ese repo publica la extensión VS Code y el conmutador de
cuentas; este repo es un plugin de Paseo con otro ciclo de vida y otro público. La
única dependencia entre ambos es el router local (`claude-router-front`,
`127.0.0.1:18791`), y solo como servicio: **no se consume el contrato
`file.claude-cuentas.v1`** — medido 13-10, el router descarta el bearer para alias
locales (`qwen38-off` responde 200 con token falso), así que aquí no se lee
`~/.config/claude-cuentas`.

## Ficheros

- `shared/suggest.ts` — la instrucción fija, el cuerpo apéndice-estable y el parseo.
- `shared/transcript.ts` — aplanado del transcript. **Copia declarada** del
  aplanado de `paseo-plugin/shared/ask.ts` del repo hermano (hallazgo 6): se copió
  en vez de extraer un paquete común porque son dos repos con ciclos de release
  distintos y el aplanado son ~60 líneas estables. Si el de cuentas cambia, este no
  lo sabe; la duplicación es a propósito y `duplicados` (jscpd) no la ve porque es
  entre repos.
- `server/session.ts` — localizar el transcript y la única llamada al router (fetch;
  el router tolera las cabeceras de navegador, medido 13-10).
- `server/suggest.ts` — ventana de silencio de 60 s con `seq`: un turno nuevo mata la
  sugerencia pendiente y descarta una respuesta en vuelo.
- `client/suggest-pill.ts` — píldora en el composer; sondea 10 s solo agentes
  `idle`; el texto se tira al salir de idle y al enviar.
- `index.server.ts` / `index.client.tsx` — enganche a los hooks `agent.turn_ended` /
  `agent.turn_started` y a los RPCs `suggest.get` / `suggest.dismiss`.

## Superficie

Nada publicado hacia otros repos: los RPCs del plugin solo los consume su propio
client. El registro `CONTRACTS.yaml` vive en claude-account-switcher, no aquí.

## Riesgos conocidos

- `requirements.paseo` fija `>=0.11.2 <0.12.0`: un bump mayor de Paseo deja el
  plugin inactivo hasta adaptar el SDK (el `paseo-update.timer` del host puede
  traerlo; es un Task de empaquetado aparte, hallazgo 4 del architect).
- El ahorro por KV-cache (APC) es la hipótesis de diseño, no una medición en vivo.
