# Eval dorado del sugeridor

Mide qué propone `/v1/suggest` del servicio `sugiere` en momentos decisivos de una sesión con plan, ANTES de cambiar el
sugeridor y después de cada cambio: un cambio cada vez, y se mira qué casos voltean, no solo la puntuación.

```
scripts/eval --vivo   # cada caso ×3 contra el servicio real; escribe eval/resultados/<fecha>.json y el informe
scripts/eval          # el informe de la última corrida grabada frente a la anterior, sin red
npm test              # test/eval.test.ts: los casos, D0-D14 y la última corrida grabada, sin modelo
```

`SUGIERE_URL` apunta a otro servicio (por defecto `http://sugiere.llm.svc:8080`, el del clúster); `SUGIERE_TOKEN` si la ruta
lo pide. Para medir un cambio antes de desplegarlo: el servicio de la rama en local (`node service/server.ts` con
`RESIDENTE_URL`/`RESIDENTE_KEY`) y `SUGIERE_URL=http://localhost:8080 scripts/eval --vivo`.

## Un caso: `eval/casos/<id>.json`

| Campo | Qué es |
|---|---|
| `id`, `origen` | nombre del fichero; de dónde sale el caso (el ticket real, descrito sin su clave) |
| `plan` | el ancla del ticket: `ticket`, `objetivo`, `criterios` (`texto`, `como_se_verifica`, `status`, `evidencia`), `fuera_de_alcance`. Viaja en `contexto.plan`, que el servicio usa desde «Garantizar plan» (uno anterior lo ignora) |
| `contexto` | lo que recibe `/v1/verdict`: `cwd` y, si toca, `key`, `resumen`, `criterio` |
| `transcript` | la sesión hasta el momento decisivo: `{usuario}`, `{asistente, herramientas: [{Nombre: entrada}]}` y `{resultados: [...]}` (uno por herramienta del turno anterior). Se convierte al `.jsonl` de Claude Code |
| `espera` | `conducta` (`verificar`, `en-plan`, `trabajo-nuevo`, `entregar`, `esperar`); `debe`: regex que deben casar TODAS; `no_debe`: ninguna; `vacia`: si la sugerencia vacía es correcta; `autoenvio` (opcional): el `ok` que debe dar la puerta |
| `ejemplos` | sugerencias que pasan y que fallan: `npm test` comprueba que la puntuación las separa |

Las regex se escriben en minúsculas y sin acentos (la sugerencia se compara sin ellos). Los casos se guionizan a partir de
las sesiones reales: el repo es público y `scripts/check-internal.sh` rechaza claves de ticket, IPs privadas, hosts `*.lan.*`
y correos, así que las claves son ficticias con letra tras el guion (`ALARMA-H1`) y los hosts, `*.example` o DNS del clúster.

## La puntuación y el informe

Un caso pasa si pasa la mayoría de sus corridas. El informe repuntúa la corrida anterior con los casos de hoy y lista los que
voltean (▲ a pasa, ▼ a falla). En cada corrida se comprueban las reglas que nunca se rompen: `PARA DANI` nunca se autoenvía
(la puerta no da `ok` a `dinero` ni a una sugerencia que va a Dani) y D0-D14 siguen en el servicio (una sonda por regla) y
en `service/rules.ts` (su huella, en el test).
