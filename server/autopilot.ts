// The autopilot: with it on for an agent, every completed turn asks the `sugiere` service what to do and obeys — send the next
// message, wait, call a person, or archive (Dani 07-11). All the reasoning is the service's (`POST /v1/autopilot`,
// docs/servicio-sugiere.md §12); this only switches it on and off, asks, and obeys. Different from the `auto` setting, which only
// generates suggestions for the user to send.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { transcriptMessages } from "../shared/transcript.ts";
import { bloqueoDelegacion } from "./delegation.ts";
import { SessionError, locateSession, nativeSuggestion, sugierePost } from "./session.ts";
import { anchorKey, guardedPlan, turn } from "./suggest.ts";

type Paseo = PluginHandlerContext["paseo"];
type Agent = { id: string; cwd: string; status?: string; archivedAt?: string | null };
// What the ✦'s popover shows besides the state (Dani 08-11: «ver si está en marcha, cuántas lleva»): when the service last
// decided, its step count, and the last message it sent.
type Estado = { on: boolean; desde: string; estado: string; motivo: string; decidido?: string; pasos?: { seguidos: number; total: number }; enviado?: string };

const TIMEOUT_MS = 330_000; // the service waits on the session's model and the gate: its slowest answer, plus margin
const RETRY_MS = 60_000; // a 503, or a failed read of the session, is retried once, after this
const ACCIONES = new Set(["enviar", "esperar", "humano", "cerrar"]);

// Per agent, on the home PVC so it survives a restart of the pod: `{agentId: {on, desde, estado, motivo, decidido?, pasos?, enviado?}}`.
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
export function get(agentId: string): Partial<Estado> & { on: boolean; estado: string; motivo: string } {
  return all()[agentId] ?? { on: false, estado: "apagado", motivo: "" };
}

// The caps from the settings document, sent with every call (0 = no cap; the service decides with them).
let topes = { max_seguidos: 0, max_total: 0 };
export function setTopes(max_seguidos: number, max_total: number): void {
  topes = { max_seguidos, max_total };
}

/** The switch. Turning it on over an idle session that is waiting on the user starts piloting right away.
 * coordinación de sesiones: an agent the rutador holds as a producer (any active record, `paused` included) cannot be piloted from here —
 * the RPC fails saying the delegation must be released first. Fence before and after the write: the rutador checks
 * `autopilot.json` before claiming, so a claim that lands between our read and our write is caught on the second read. */
export async function set(agentId: string, value: boolean, paseo: Paseo): Promise<ReturnType<typeof get>> {
  if (value) {
    const bloqueo = bloqueoDelegacion(agentId);
    if (bloqueo) throw new Error(`autopilot: ${bloqueo}; libera la delegación antes de encenderlo`);
  }
  // A new run starts its own count: what the last one decided and sent goes.
  put(agentId, { on: value, desde: new Date().toISOString(), estado: value ? "activo" : "apagado", motivo: "", decidido: undefined, pasos: undefined, enviado: undefined });
  decided.delete(agentId);
  console.log(`autopilot: ${value ? "encendido" : "apagado"} para ${agentId}`);
  if (value) {
    const tras = bloqueoDelegacion(agentId);
    if (tras) {
      put(agentId, { on: false, estado: "apagado", motivo: "" });
      throw new Error(`autopilot: ${tras}; libera la delegación antes de encenderlo`);
    }
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
  // coordinación de sesiones: con delegación activa del rutador no se pilota — se para a rojo con el motivo, sin preguntar ni enviar.
  const bloqueo = bloqueoDelegacion(agentId);
  if (bloqueo) return stop(agentId, `${bloqueo}: el rutador lleva esta sesión; libera la delegación para pilotarla`);
  decided.set(agentId, seq);
  const current = () => on(agentId) && turn(agentId) === seq;
  put(agentId, { estado: "pensando", motivo: "pidiendo el siguiente paso al servicio" });
  // A failed read is retried once, like a 503: a saturated daemon fails it for a minute (09-11).
  let body: object | undefined;
  for (let intento = 1; !body; intento++) {
    try {
      body = await readBody(agentId, cwd, paseo, turnId || String(seq));
    } catch (error) {
      if (!current()) return;
      const why = `no se pudo leer la sesión: ${(error as Error).message}`;
      if (intento > 1) return stop(agentId, why);
      console.warn(`autopilot: ${why} para ${agentId}; reintento en ${RETRY_MS / 1000} s`);
      put(agentId, { motivo: `${why}; reintento en ${RETRY_MS / 1000} s` });
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      if (!current()) return;
    }
  }
  let answer = await ask(body);
  if (!current()) return;
  if (answer.status !== 200) {
    const why = `el servicio respondió ${answer.status || "nada"}${refusal(answer)}`;
    console.warn(`autopilot: ${why} para ${agentId}; reintento en ${RETRY_MS / 1000} s`);
    put(agentId, { motivo: `${why}; reintento en ${RETRY_MS / 1000} s` });
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    if (!current()) return;
    answer = await ask(body);
    if (!current()) return;
  }
  if (answer.status !== 200) return stop(agentId, `autopilot sin servicio (${answer.status || "sin respuesta"})${refusal(answer)}`);
  const { accion, mensaje, motivo, fase, pasos } = answer.out as { accion?: string; mensaje?: string; motivo?: string; fase?: string; pasos?: { seguidos?: unknown; total?: unknown } };
  const why = typeof motivo === "string" ? motivo : "";
  if (!accion || !ACCIONES.has(accion) || (accion === "enviar" && !(typeof mensaje === "string" && mensaje.trim()))) {
    return stop(agentId, `respuesta del autopilot inválida: ${JSON.stringify(answer.out).slice(0, 120)}`);
  }
  // Owner fence (coordinación de sesiones): a delegation can land while the service request is in flight — recheck right before the side
  // effect: nothing is sent or archived over an active record.
  if (accion === "enviar" || accion === "cerrar") {
    const enlace = bloqueoDelegacion(agentId);
    if (enlace) return stop(agentId, `${enlace}: el rutador enlazó la sesión mientras el servicio pensaba; no se envía ni archiva`);
  }
  console.log(`autopilot: ${agentId} turno ${seq} → ${accion}${fase ? ` (${fase})` : ""}: ${why.slice(0, 120)}`);
  const counted = Number.isInteger(pasos?.seguidos) && Number.isInteger(pasos?.total);
  put(agentId, { decidido: new Date().toISOString(), ...(counted ? { pasos: { seguidos: pasos!.seguidos as number, total: pasos!.total as number } } : {}) });
  if (accion === "enviar") {
    put(agentId, { estado: "activo", motivo: why, enviado: mensaje!.slice(0, 280) });
    // coordinación de sesiones: el autoenvío se declara `steer` (si el turno arrancó mientras el servicio pensaba, no lo interrumpe). La SDK
    // 0.11.2 aún no expone `sourceAgentId` en `send` (solo messageId/activeTurnBehavior/images/attachments): la procedencia
    // del mensaje queda pendiente de la SDK; no se fuerza con cast.
    await paseo.agents.ref(agentId).send(mensaje!, { activeTurnBehavior: "steer" }).catch((error) => stop(agentId, `no se pudo enviar: ${(error as Error).message}`));
  } else if (accion === "esperar") put(agentId, { estado: "esperando", motivo: why });
  else if (accion === "humano") stop(agentId, why);
  else {
    put(agentId, { on: false, estado: "entregado", motivo: why });
    await paseo.agents.ref(agentId).archive().catch((error) => console.warn(`autopilot: no se pudo archivar ${agentId}: ${(error as Error).message}`));
  }
}

/** What the service is asked with — the same reads generate() makes: the transcript, and the plan anchor; the native
 * suggestion only without a guarded plan. */
async function readBody(agentId: string, cwd: string, paseo: Paseo, turno: string): Promise<object> {
  const lines = await locateSession(agentId, paseo);
  const plan = guardedPlan(agentId);
  const key = anchorKey(agentId);
  const nativa = plan ? null : await nativeSuggestion(agentId, paseo);
  const contexto = { kind: "live", cwd, topes, ...(key ? { key } : {}), ...(plan ? { plan } : {}) };
  return { sid: agentId, turno, transcript: lines.join("\n"), contexto, ...(nativa ? { nativa } : {}) };
}

/** The red ✦: a person is needed. The autopilot stays on and asks again when the next turn ends. */
function stop(agentId: string, motivo: string): void {
  console.warn(`autopilot: ${agentId} necesita a una persona: ${motivo}`);
  put(agentId, { estado: "humano", motivo });
}

/** The service's own reason for refusing (its `{error}` body), for the log and the popover. */
const refusal = ({ out }: { out: Record<string, unknown> }) => (typeof out.error === "string" ? `: ${out.error.slice(0, 120)}` : "");

async function ask(body: object): Promise<{ status: number; out: Record<string, unknown> }> {
  try {
    return await sugierePost("/v1/autopilot", body, TIMEOUT_MS);
  } catch (error) {
    if (error instanceof SessionError) return { status: 0, out: {} }; // no answer in time: retried like a 503
    throw error;
  }
}
