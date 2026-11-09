// The router owns linked producers until release, including paused ones; this read-only fence prevents a second driver.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// CONTRACT: file.paseo.delegations.v1
export const FICHERO = "rutador-coordinaciones.json";
const rutaPorDefecto = () => join(process.env.PASEO_HOME || join(homedir(), ".paseo"), FICHERO);

/** Por qué el autopilot no puede llevar a este agente; `null` = libre. Store ausente = normal. Si existe y no se puede leer,
 * no es JSON o no es un v1 entero (`{version:1, delegations:{…}}`), FAIL CLOSED: sin garantías de que no haya delegación,
 * no se reclama nada. Un registro con la clave del agente reserva sea cual sea su estado; la entrada se valida floja —
 * `ownerId`/`producerId`/`state` se usan para el motivo si están, y los campos extra del contrato (ownerActivity,
 * producerActivity, sentIds…) pasan sin exigir la forma exacta. */
export function bloqueoDelegacion(agentId: string, ruta: string = rutaPorDefecto()): string | null {
  let raw: string;
  try {
    raw = readFileSync(ruta, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return `store de delegaciones del rutador ilegible (${(error as Error).message})`;
  }
  let store: { version?: unknown; delegations?: unknown };
  try {
    store = JSON.parse(raw);
  } catch {
    return "store de delegaciones del rutador corrupto (no es JSON)";
  }
  if (store?.version !== 1 || typeof store.delegations !== "object" || store.delegations === null || Array.isArray(store.delegations)) {
    return "store de delegaciones del rutador corrupto (no es v1 {version, delegations})";
  }
  for (const [producerId, entrada] of Object.entries(store.delegations as Record<string, unknown>)) {
    const e = (entrada ?? {}) as { ownerId?: unknown; producerId?: unknown; state?: unknown };
    if (producerId !== agentId && e.producerId !== agentId) continue;
    const owner = typeof e.ownerId === "string" && e.ownerId ? e.ownerId : "sin dueño";
    const estado = typeof e.state === "string" && e.state ? e.state : "activo";
    return `delegación del rutador: dueño ${owner}, estado ${estado}`;
  }
  return null;
}
