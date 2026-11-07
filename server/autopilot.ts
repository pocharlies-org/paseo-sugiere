// The autopilot: with it on for an agent, every completed turn asks the `sugiere` service what to do and obeys — send the next
// message, wait, call a person, or archive (Dani 07-11). All the reasoning is the service's (`POST /v1/autopilot`,
// docs/servicio-sugiere.md §12); this only switches it on and off, asks, and obeys. Different from the `auto` setting, which only
// generates suggestions for the user to send.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { transcriptMessages } from "../shared/transcript.ts";
import { SessionError, locateSession, nativeSuggestion, sugierePost } from "./session.ts";
import { anchorKey, guardedPlan, turn } from "./suggest.ts";

type Paseo = PluginHandlerContext["paseo"];
type Agent = { id: string; cwd: string; status?: string; archivedAt?: string | null };
export type Estado = { on: boolean; desde: string; estado: string; motivo: string };

const TIMEOUT_MS = 330_000; // the service waits on the session's model and the gate: its slowest answer, plus margin
const RETRY_MS = 60_000; // a 503 is retried once, after this
const ACCIONES = new Set(["enviar", "esperar", "humano", "cerrar"]);

// Per agent, on the home PVC so it survives a restart of the pod: `{agentId: {on, desde, estado, motivo}}`.
// estado: activo (working) · pensando (asking the service) · esperando · humano · entregado · apagado.
const file = () => join(homedir(), ".local", "state", "paseo-sugiere", "autopilot.json");
let estados: Record<string, Estado> | null = null;
function all(): Record<string, Estado> {
  if (!estados) {
    try {
      estados = JSON.parse(readFileSync(file(), "utf8")) as Record<string, Estado>;
    } catch {
      estados = {};
    }
  }
  return estados;
}
function put(agentId: string, patch: Partial<Estado>): void {
  const next = all();
  const blank: Estado = { on: false, desde: new Date().toISOString(), estado: "apagado", motivo: "" };
  next[agentId] = { ...blank, ...next[agentId], ...patch };
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2));
}

/** Fire and forget, never an unhandled rejection: one would bring the plugin's process down. */
export function background(work: Promise<void>): void {
  work.catch((error) => console.warn(`autopilot: ${(error as Error).message}`));
}

export const on = (agentId: string): boolean => all()[agentId]?.on === true;
export function get(agentId: string): { on: boolean; estado: string; motivo: string } {
  const { on = false, estado = "apagado", motivo = "" } = all()[agentId] ?? {};
  return { on, estado, motivo };
}

// The caps from the settings document, sent with every call (0 = no cap; the service decides with them).
let topes = { max_seguidos: 0, max_total: 0 };
export function setTopes(max_seguidos: number, max_total: number): void {
  topes = { max_seguidos, max_total };
}

/** The switch. Turning it on over an idle session that is waiting on the user starts piloting right away. */
export async function set(agentId: string, value: boolean, paseo: Paseo): Promise<{ on: boolean; estado: string; motivo: string }> {
  put(agentId, { on: value, desde: new Date().toISOString(), estado: value ? "activo" : "apagado", motivo: "" });
  decided.delete(agentId);
  console.log(`autopilot: ${value ? "encendido" : "apagado"} para ${agentId}`);
  if (value) {
    const { entries } = await paseo.agents.list({ page: { limit: 200 } });
    const agent = entries.find(({ agent }) => agent.id === agentId)?.agent as Agent | undefined;
    if (agent) background(decideIfWaiting(agent, paseo));
  }
  return get(agentId);
}

/** Anything that starts a turn — the user's next message, an EVENTO — clears «esperando» and the red: the autopilot asks again when it ends. */
export function turnStarted(agentId: string): void {
  const e = all()[agentId];
  if (e?.on && e.estado !== "activo") put(agentId, { estado: "activo", motivo: "" });
}

let resumed = false;
/** Once per plugin start: the agents with the autopilot on that sat idle waiting on the user while the plugin was down.
 * shortcut: the SDK hands the plugin no PaseoApi at start, only with a hook or an RPC, so this runs on the first of them;
 * upgrade when the SDK exposes `paseo` at contribute time. */
export async function resume(paseo: Paseo): Promise<void> {
  if (resumed) return;
  resumed = true;
  if (!Object.values(all()).some((e) => e.on)) return;
  const { entries } = await paseo.agents.list({ page: { limit: 200 } });
  for (const { agent } of entries) if (on(agent.id)) await decideIfWaiting(agent as Agent, paseo);
}

/** Idle, not archived, and the last message is the assistant's: a turn ended and nobody answered it. A `RETOMA` or an
 * unanswered `[AUTOPILOT]` are user messages, so they never get a second send. */
async function decideIfWaiting(agent: Agent, paseo: Paseo): Promise<void> {
  if (agent.status !== "idle" || agent.archivedAt) return;
  const lines = await locateSession(agent.id, paseo).catch(() => []);
  if (transcriptMessages(lines).messages.at(-1)?.role === "assistant") await decide(agent.id, agent.cwd, paseo);
}

const decided = new Map<string, number>(); // the last turn asked for: the turn hook and the start pass never ask twice

/** A turn ended completed with the autopilot on: ask the service once and obey, unless a newer turn started meanwhile. */
export async function decide(agentId: string, cwd: string, paseo: Paseo, turnId?: string | null): Promise<void> {
  const seq = turn(agentId);
  if (!on(agentId) || decided.get(agentId) === seq) return;
  decided.set(agentId, seq);
  const current = () => on(agentId) && turn(agentId) === seq;
  put(agentId, { estado: "pensando", motivo: "" });
  let body: object;
  try {
    // The same reads generate() makes: the transcript, and the plan anchor; the native suggestion only without a guarded plan.
    const lines = await locateSession(agentId, paseo);
    const plan = guardedPlan(agentId);
    const key = anchorKey(agentId);
    const nativa = plan ? null : await nativeSuggestion(agentId, paseo);
    const contexto = { kind: "live", cwd, topes, ...(key ? { key } : {}), ...(plan ? { plan } : {}) };
    body = { sid: agentId, turno: turnId || String(seq), transcript: lines.join("\n"), contexto, ...(nativa ? { nativa } : {}) };
  } catch (error) {
    if (current()) stop(agentId, `autopilot sin transcript: ${(error as Error).message}`);
    return;
  }
  let answer = await ask(body);
  if (!current()) return;
  if (answer.status !== 200) {
    console.warn(`autopilot: el servicio respondió ${answer.status} para ${agentId}; reintento en ${RETRY_MS / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    if (!current()) return;
    answer = await ask(body);
    if (!current()) return;
  }
  if (answer.status !== 200) return stop(agentId, `autopilot sin servicio (${answer.status || "sin respuesta"})`);
  const { accion, mensaje, motivo, fase } = answer.out as { accion?: string; mensaje?: string; motivo?: string; fase?: string };
  const why = typeof motivo === "string" ? motivo : "";
  if (!accion || !ACCIONES.has(accion) || (accion === "enviar" && !(typeof mensaje === "string" && mensaje.trim()))) {
    return stop(agentId, `respuesta del autopilot inválida: ${JSON.stringify(answer.out).slice(0, 120)}`);
  }
  console.log(`autopilot: ${agentId} turno ${seq} → ${accion}${fase ? ` (${fase})` : ""}: ${why.slice(0, 120)}`);
  if (accion === "enviar") {
    put(agentId, { estado: "activo", motivo: why });
    await paseo.agents.ref(agentId).send(mensaje!).catch((error) => stop(agentId, `no se pudo enviar: ${(error as Error).message}`));
  } else if (accion === "esperar") put(agentId, { estado: "esperando", motivo: why });
  else if (accion === "humano") stop(agentId, why);
  else {
    put(agentId, { on: false, estado: "entregado", motivo: why });
    await paseo.agents.ref(agentId).archive().catch((error) => console.warn(`autopilot: no se pudo archivar ${agentId}: ${(error as Error).message}`));
  }
}

/** The red ✦: a person is needed. The autopilot stays on and asks again when the next turn ends. */
function stop(agentId: string, motivo: string): void {
  console.warn(`autopilot: ${agentId} necesita a una persona: ${motivo}`);
  put(agentId, { estado: "humano", motivo });
}

async function ask(body: object): Promise<{ status: number; out: Record<string, unknown> }> {
  try {
    return await sugierePost("/v1/autopilot", body, TIMEOUT_MS);
  } catch (error) {
    if (error instanceof SessionError) return { status: 0, out: {} }; // no answer in time: retried like a 503
    throw error;
  }
}
