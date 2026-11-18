// The sidebar row badge paints from the very state the ✦ already holds: the server's pushed `suggest.watch` (autopilot pair
// and follow-up of every agent) plus the host's agent list, which says what workspace each agent lives in. The pill writes
// here on every push; nobody asks the server for the badge, so there is one stream and no second watch (Dani 18-11).
import { useSyncExternalStore } from "react";
import type { EstadoAgente } from "../shared/contract.ts";

/** How many of a workspace's agents someone is working on right now, as the ✦ paints them: a legacy autopilot pair alive
 * (activa · pensando · esperando) or a follow-up that is active — `enMarcha`; a pair that needs a person (humano · degradada)
 * — `atencion`. A paused follow-up and a delivered pair count for nothing: nobody is working on them. */
type Cuenta ={ enMarcha: number; atencion: number };

const VACIO: Cuenta = { enMarcha: 0, atencion: 0 };
const EN_MARCHA = new Set(["activa", "pensando", "esperando"]);
const ATENCION = new Set(["humano", "degradada"]);

const estados = new Map<string, EstadoAgente>(); // what the server last pushed, by agent
const espacios = new Map<string, string>(); // the agent list's agent → workspace
const oyentes = new Set<() => void>();
let porEspacio = new Map<string, Cuenta>();

const igual = (a: Map<string, Cuenta>, b: Map<string, Cuenta>): boolean =>
  a.size === b.size &&
  [...a].every(([workspaceId, cuenta]) => {
    const otra = b.get(workspaceId);
    return otra !== undefined && otra.enMarcha === cuenta.enMarcha && otra.atencion === cuenta.atencion;
  });

function recalcula(): void {
  const siguiente = new Map<string, Cuenta>();
  for (const [agentId, workspaceId] of espacios) {
    const estado = estados.get(agentId);
    if (!estado) continue;
    // One agent counts once: a pair that needs a person is `atencion` even if a follow-up is also on.
    const atencion = ATENCION.has(estado.autopilot.estado) ? 1 : 0;
    const enMarcha = atencion ? 0 : (EN_MARCHA.has(estado.autopilot.estado) || estado.seguimiento?.activo) ? 1 : 0;
    if (!atencion && !enMarcha) continue;
    const actual = siguiente.get(workspaceId) ?? VACIO;
    siguiente.set(workspaceId, { enMarcha: actual.enMarcha + enMarcha, atencion: actual.atencion + atencion });
  }
  if (igual(siguiente, porEspacio)) return; // a push that changes nothing must not repaint the sidebar
  porEspacio = siguiente;
  for (const oye of [...oyentes]) oye();
}

/** The agent list placed this agent in a workspace (or moved it). */
export function agenteEn(agentId: string, workspaceId: string): void {
  if (espacios.get(agentId) === workspaceId) return;
  espacios.set(agentId, workspaceId);
  recalcula();
}

/** The agent is gone (removed or archived): its workspace stops counting it. */
export function agenteFuera(agentId: string): void {
  const estaba = espacios.delete(agentId);
  const tenia = estados.delete(agentId);
  if (estaba || tenia) recalcula();
}

/** A new agent-list snapshot replaced everything. */
export function sinAgentes(): void {
  espacios.clear();
  estados.clear();
  recalcula();
}

/** The server pushed this agent's state: the ✦'s maps and the badge's count move together. */
export function estadoAplicado(agentId: string, estado: EstadoAgente): void {
  estados.set(agentId, estado);
  recalcula();
}

/** What this workspace's row badge shows. Same object reference while nothing changed (useSyncExternalStore's contract). */
export function resumenDe(workspaceId: string): Cuenta {
  return porEspacio.get(workspaceId) ?? VACIO;
}

export function useResumen(workspaceId: string): Cuenta {
  return useSyncExternalStore((oye) => {
    oyentes.add(oye);
    return () => void oyentes.delete(oye);
  }, () => resumenDe(workspaceId));
}