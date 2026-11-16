// The state of the ✦ comes from the supervisor's autopilot registry: the pair of this agent, if it has one. The plugin no
// longer pilots anything itself — the auditor session B does, driven by the supervisor — so this module only reads what the
// single writer wrote and hands the popover something to paint. Absent file = no pairs; unreadable or corrupt = `desconocido`,
// never a crash and never a state the registry does not actually say.
// CONTRACT: file.autopilot.pares.v1
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What `suggest.watch` answers for the autopilot: `sin-par` (no record), `desconocido` (the registry could not be read) or the
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
export const rutaPorDefecto = () => join(homedir(), ".company", "jira-trigger", "autopilot-pares.json");

/** The Par's epoch seconds (1763100000.0) as ISO, so the popover's `hace()` can format them; anything else passes through. */
const iso = (segundos: unknown): string | undefined =>
  typeof segundos === "number" && Number.isFinite(segundos) ? new Date(segundos * 1000).toISOString() : undefined;

/** The registry read once: the agents it pairs (`ids`, by key and by `a_id`) and the pair of any agent, ready for the pill and
 * the popover. Extra Par fields pass. `auditor` starts as B's id — the server upgrades it to B's title when it can find the
 * session. Read again only when the file changes (the server watches its directory), never per pill. */
export function registro(ruta: string = rutaPorDefecto()): { ids: string[]; de: (agentId: string) => Estado } {
  const todos = (estado: Estado) => ({ ids: [], de: () => estado });
  let raw: string;
  try {
    raw = readFileSync(ruta, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return todos(SIN_PAR);
    return todos({ estado: "desconocido", motivo: `el registro de parejas no se pudo leer (${(error as Error).message})` });
  }
  let store: { version?: unknown; pares?: unknown };
  try {
    store = JSON.parse(raw);
  } catch {
    return todos({ estado: "desconocido", motivo: "el registro de parejas no es JSON" });
  }
  if (store?.version !== 1 || typeof store.pares !== "object" || store.pares === null || Array.isArray(store.pares)) {
    return todos({ estado: "desconocido", motivo: "el registro de parejas no es un v1 {version, pares}" });
  }
  const pares = Object.entries(store.pares as Record<string, unknown>).map(([aId, value]) => [aId, (value ?? {}) as Record<string, unknown>] as const);
  const ids = [...new Set(pares.flatMap(([aId, par]) => (typeof par.a_id === "string" ? [aId, par.a_id] : [aId])))];
  const de = (agentId: string): Estado => {
    const par = pares.find(([aId, p]) => aId === agentId || p.a_id === agentId)?.[1];
    if (!par) return SIN_PAR;
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
  };
  return { ids, de };
}

