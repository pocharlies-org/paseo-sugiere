// The state of the ✦ comes from the supervisor's autopilot registry: the pair of this agent, if it has one. The plugin no
// longer pilots anything itself — the auditor session B does, driven by the supervisor — so this module only reads what the
// single writer wrote and hands the popover something to paint. Absent file = no pairs; unreadable or corrupt = `desconocido`,
// never a crash and never a state the registry does not actually say.
// CONTRACT: file.autopilot.pares.v1
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What `suggest.get` answers for the autopilot: `sin-par` (no record), `desconocido` (the registry could not be read) or the
 * Par's own estado — activa · pensando · esperando · humano · degradada · entregada — with the lines the popover shows. */
export type Estado = {
  estado: string;
  motivo: string;
  desde?: string;
  actualizado?: string;
  pasos?: { seguidos: number; total: number };
  ultimo_envio?: string;
  auditor?: string;
  key?: string | null;
  modelo?: string;
};

const SIN_PAR: Estado = { estado: "sin-par", motivo: "" };
const rutaPorDefecto = () => join(homedir(), ".company", "jira-trigger", "autopilot-pares.json");

/** The Par's epoch seconds (1763100000.0) as ISO, so the popover's `hace()` can format them; anything else passes through. */
const iso = (segundos: unknown): string | undefined =>
  typeof segundos === "number" && Number.isFinite(segundos) ? new Date(segundos * 1000).toISOString() : undefined;

/** The pair of `agentId` in the registry, ready for the pill and the popover. The entry is matched by key or by `a_id`;
 * extra Par fields pass. `auditor` starts as B's id — the server upgrades it to B's title when it can find the session. */
export function estadoPareja(agentId: string, ruta: string = rutaPorDefecto()): Estado {
  let raw: string;
  try {
    raw = readFileSync(ruta, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return SIN_PAR;
    return { estado: "desconocido", motivo: `el registro de parejas no se pudo leer (${(error as Error).message})` };
  }
  let store: { version?: unknown; pares?: unknown };
  try {
    store = JSON.parse(raw);
  } catch {
    return { estado: "desconocido", motivo: "el registro de parejas no es JSON" };
  }
  if (store?.version !== 1 || typeof store.pares !== "object" || store.pares === null || Array.isArray(store.pares)) {
    return { estado: "desconocido", motivo: "el registro de parejas no es un v1 {version, pares}" };
  }
  for (const [aId, value] of Object.entries(store.pares as Record<string, unknown>)) {
    const par = (value ?? {}) as Record<string, unknown>;
    if (aId !== agentId && par.a_id !== agentId) continue;
    const seguidos = (par.pasos as { seguidos?: unknown } | undefined)?.seguidos;
    const total = (par.pasos as { total?: unknown } | undefined)?.total;
    return {
      estado: typeof par.estado === "string" ? par.estado : "desconocido",
      motivo: typeof par.motivo === "string" ? par.motivo : "",
      ...(iso(par.desde) ? { desde: iso(par.desde) } : {}),
      ...(iso(par.actualizado) ? { actualizado: iso(par.actualizado) } : {}),
      ...(Number.isInteger(seguidos) && Number.isInteger(total) ? { pasos: { seguidos: seguidos as number, total: total as number } } : {}),
      ...(typeof par.ultimo_envio === "string" && par.ultimo_envio ? { ultimo_envio: par.ultimo_envio } : {}),
      ...(typeof par.b_id === "string" && par.b_id ? { auditor: par.b_id } : {}),
      ...(typeof par.key === "string" || par.key === null ? { key: par.key as string | null } : {}),
      ...(typeof par.modelo === "string" && par.modelo ? { modelo: par.modelo } : {}),
    };
  }
  return SIN_PAR;
}
