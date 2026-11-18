// The next-message suggestion: after a turn ends quietly for a minute, one small call proposes what the user should send next,
// and the composer pill shows it. Port of OpenChamber's session-assist: same 60 s quiet window, same rule that a finished
// conversation gets nothing. Nothing here touches the session: the suggestion comes from the cluster's `sugiere` service
// (Dani 05-11), the same place the company uses, so there is one mechanism and not two.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext, PluginHookContext } from "@getpaseo/plugin/server";
import type { Plan } from "../shared/suggest.ts";
import { transcriptMessages } from "../shared/transcript.ts";
import { bloqueoDelegacion } from "./delegation.ts";
import { rutaPorDefecto } from "./pares.ts";
import { SessionError, locateSession, nativeSuggestion, sugiereRequest, verdictRequest } from "./session.ts";

// The settings document in force: off drops every pending and shown suggestion; auto gates only the quiet window (the pill's
// force works without it); quiet is the silence window.
let enabled = true;
let auto = false;
let quietMs = 60_000;
export function setEnabled(value: boolean): void {
  if (enabled && !value) dispose();
  enabled = value;
}
export function setAuto(value: boolean): void {
  auto = value;
}
export function setQuietSeconds(seconds: number): void {
  quietMs = seconds * 1000;
}

// Who hears that an agent's state may have changed: the server's vigilia, which pushes it to the pills.
let avisa: (agentId: string) => void = () => {};
export function alCambiar(listener: (agentId: string) => void): void {
  avisa = listener;
}

// The instruction is the service's alone (Dani's decision 5): the plugin sends none. The old hand-edited
// ~/.local/state/paseo-sugiere/prompt.txt is no longer read.

// The plan anchor paseo-plan writes per agent (paseo-plan's file contract). Read with every turn end and generation, so «Garantizar
// plan» switched in the pill takes effect on the next turn without restarting the host.
export const ANCHOR_DIR = join(homedir(), ".local", "state", "paseo-plan");

function anchorOf(agentId: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(ANCHOR_DIR, `anchor-${agentId}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** The anchored plan of an agent, only with `guard` on and at least one criterion (Dani's decision 2: a guard without criteria does
 * not arm). Null on anything else — no file, unreadable, guard off — and then everything is as before plans existed. */
export function guardedPlan(agentId: string): object | null {
  const anchor = anchorOf(agentId);
  return anchor?.guard === true && Array.isArray(anchor.criterios) && anchor.criterios.length ? anchor : null;
}

/** The plan the ✦'s popover can link to the auditor: an anchor with `ticketKey` and at least one criterion, shown as
 * «SC-… · n criterios» and sent as `objetivo.key`. Unlike `guardedPlan` it does not require `guard`: the auditor gets the
 * plan whether or not the pill's guard is on. Null without a file, without a key or without criteria. */
export function planAnchor(agentId: string): { key: string; criterios: number } | null {
  const anchor = anchorOf(agentId);
  const key = typeof anchor?.ticketKey === "string" ? anchor.ticketKey : "";
  const criterios = Array.isArray(anchor?.criterios) ? anchor.criterios.length : 0;
  return key && criterios ? { key, criterios } : null;
}

/** The anchor of an agent as the `Plan` the service reads (paseo-plan's file contract), tolerant: null without a file or on
 * non-JSON. `objetivoDeAgente` builds the conversation's objective from its own words — never the ticket key alone. */
export function planDe(agentId: string): Plan | null {
  return anchorOf(agentId) as Plan | null;
}

/** Three «no es esto» in a row and the ✦ goes quiet: no guarded generation until the user clicks it (the plan, «Deriva»).
 * shortcut: the count lives in memory, so a host restart forgets it; persist it if that turns out to matter. */
const MAX_NOES = 3;

// pending/error/nada describe only the last FORCE (the pill spins on pending, shows error once, says «nada que sugerir» on nada);
// the quiet window stays silent by design.
// en_plan/criterio come with an anchored suggestion; noes/muted survive turns (the streak is across turns) and only reset on use or click.
type Entry = {
  timer?: ReturnType<typeof setTimeout>;
  seq: number;
  text: string | null;
  en_plan: string | null;
  criterio: string | null;
  pending: boolean;
  error: string | null;
  nada: boolean;
  noes: number;
  muted: boolean;
};
const agents = new Map<string, Entry>();
const fresh = (): Entry => ({ seq: 0, text: null, en_plan: null, criterio: null, pending: false, error: null, nada: false, noes: 0, muted: false });
const clear = (entry: Entry) => Object.assign(entry, { text: null, en_plan: null, criterio: null, pending: false, error: null, nada: false });

/** A turn ended completed: after the quiet window, one generation, unless anything happens first. Only with `auto` —
off by default (Dani 25-10): each automatic suggestion pays the whole transcript of its session; without auto the user's click forces it.
With «Garantizar plan» on for this agent it generates right away at every turn end, auto or not; sending stays the user's tap.
With «Seguir» on for this agent the completed event re-evaluates the follow-up instead: the same engine decides the
next step and, passing every gate, the plugin sends it — the pill does not also generate for a turn that is about to be sent. */
export function arm(agentId: string, context: PluginHookContext): void {
  const seguiendo = seguimientos.get(agentId);
  if (seguiendo?.activo) {
    void reevaluar(agentId, context);
    return;
  }
  const guarded = guardedPlan(agentId) !== null;
  if (!enabled || (!auto && !guarded)) return;
  const entry = agents.get(agentId) ?? fresh();
  agents.set(agentId, entry);
  if (entry.muted) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.seq += 1;
  clear(entry);
  avisa(agentId);
  const seq = entry.seq;
  if (guarded) {
    void generate(agentId, seq, context);
    return;
  }
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void generate(agentId, seq, context);
  }, quietMs);
}

/** Anything new — a turn started, a failed end, a dismissal: the pending suggestion is gone and an in-flight answer will not land.
 * It also invalidates an in-flight follow-up evaluation (the seq bump): if the user typed, the session is theirs, not ours. */
export function cancel(agentId: string): void {
  const entry = agents.get(agentId);
  const seguiendo = seguimientos.get(agentId);
  if (seguiendo) seguiendo.seq += 1;
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.seq += 1;
  clear(entry);
  avisa(agentId);
}

/** A turn ended failed or canceled (index.server.ts routes every non-completed end here): the pending suggestion goes and
 * the «Seguir» pauses with its reason — never a send after a stop. Only a new «Seguir» re-arms it. */
export function finFallido(agentId: string): void {
  cancel(agentId); // the seq bump it carries: an evaluation in flight will not send
  if (seguimientos.get(agentId)?.activo) pararSeguimiento(agentId, "el turno se canceló o falló: el seguimiento se para; «Seguir» lo reanuda");
}

export function get(agentId: string): string | null {
  return enabled ? (agents.get(agentId)?.text ?? null) : null;
}

/** The state of the last force for the pill: spin while pending, show the error once when it failed, «nada que sugerir» on nada. */
export function state(agentId: string): { pending: boolean; error: string | null; nada: boolean } {
  const entry = enabled ? agents.get(agentId) : undefined;
  return { pending: entry?.pending ?? false, error: entry?.error ?? null, nada: entry?.nada ?? false };
}

/** With «Garantizar plan»: the badge and criterion of the suggestion shown, and whether the ✦ went quiet. */
export function anchor(agentId: string): { en_plan: string | null; criterio: string | null; muted: boolean } {
  const entry = enabled ? agents.get(agentId) : undefined;
  return { en_plan: entry?.text ? entry.en_plan : null, criterio: entry?.text ? entry.criterio : null, muted: entry?.muted ?? false };
}

/** «no es esto» drops the suggestion and counts toward going quiet; a used suggestion breaks the streak. */
export function feedback(agentId: string, verdict: "no-es-esto" | "usada"): { muted: boolean } {
  const entry = agents.get(agentId) ?? fresh();
  agents.set(agentId, entry);
  if (verdict === "usada") entry.noes = 0;
  else {
    entry.noes += 1;
    entry.muted = entry.noes >= MAX_NOES;
    entry.text = entry.en_plan = entry.criterio = null;
  }
  avisa(agentId);
  return { muted: entry.muted };
}

/** The user clicked the pill with nothing suggested: generate now, no quiet window. Never waits for the answer: the
 * generation can take longer than the host's 60 s RPC timeout (measured 19-10: «Plugin RPC timed out» on every slow router). */
export function force(agentId: string, context: PluginHandlerContext): boolean {
  console.log(`suggest: force pedido por la pill para ${agentId} (enabled=${enabled})`);
  if (!enabled) return false;
  const entry = agents.get(agentId) ?? fresh();
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.seq += 1;
  clear(entry);
  entry.pending = true;
  entry.noes = 0; // the user asked: a quiet ✦ speaks again
  entry.muted = false;
  agents.set(agentId, entry);
  avisa(agentId);
  void generate(agentId, entry.seq, context, true);
  return true;
}

export function dispose(): void {
  const ids = [...new Set([...agents.keys(), ...seguimientos.keys(), ...arranques.keys()])];
  for (const id of ids) {
    generaciones.set(id, (generaciones.get(id) ?? 0) + 1); // a start in flight aborts: dispose never leaves a follow-up installed
    cancel(id);
  }
  agents.clear();
  seguimientos.clear(); // en reinicio apagado: el seguimiento vive solo en memoria; nada se reanuda solo
  arranques.clear();
  for (const id of ids) avisa(id); // the streak and the quiet ✦ went with the entries
}

/** Silent by design: no transcript, a missing file, a refused call — there is simply no suggestion, and the pill shows nothing. */
async function generate(agentId: string, seq: number, context: PluginHandlerContext, forced = false): Promise<void> {
  const settle = (error: string | null): Entry | undefined => {
    const entry = agents.get(agentId);
    if (!entry || entry.seq !== seq) return entry; // the session moved on: the entry belongs to a newer generation
    entry.pending = false;
    entry.error = forced ? error : null;
    return entry;
  };
  try {
    // The daemon's native suggestion  first: it is the CLI's own fork, which hits the session's cached prefix and
    // costs only the decode. Without the patched daemon there is no file and the call below is the normal path. With a guarded
    // plan it is skipped: the native one never saw the plan. Sync read, so the seq guard stays built on the awaits below.
    const plan = guardedPlan(agentId);
    const native = plan ? null : await nativeSuggestion(agentId, context.paseo);
    if (native) {
      const entry = settle(null);
      if (entry && entry.seq === seq) {
        console.log(`suggest: nativa  para ${agentId}: ${JSON.stringify(native.slice(0, 60))}`);
        entry.text = native;
      }
      return;
    }
    const lines = await locateSession(agentId, context.paseo);
    // Sin modelo real (sin turno del asistente, o solo `<synthetic>`) no hay nada que pedir: ni llamada ni reserva (Dani 22-10).
    if (!transcriptMessages(lines).model) throw new Error("la sesión aún no tiene modelo");
    // La sugerencia la genera el servicio `sugiere` del clúster, el mismo sitio que usa la compañía (Dani, 05-11).
    const answer = await sugiereRequest(agentId, seq, lines, plan);
    if (answer.status !== 200) {
      console.warn(`suggest: el servicio sugiere respondió ${answer.status} para ${agentId}`);
      settle("el servicio sugiere no respondió bien");
      return;
    }
    const text = answer.sugerencia;
    if (!text) console.log(`suggest: respuesta vacía (nada que sugerir) para ${agentId}`);
    const entry = settle(null);
    if (entry && entry.seq === seq && text) {
      console.log(`suggest: generada para ${agentId} con ${answer.modelo}${plan ? ` (${answer.en_plan} · ${answer.criterio})` : ""}: ${JSON.stringify(text.slice(0, 60))}`);
      entry.text = text;
      entry.en_plan = answer.en_plan;
      entry.criterio = answer.criterio;
    } else if (entry && entry.seq === seq) {
      entry.nada = forced; // vacía a propósito (trabajo hecho o lo siguiente es del usuario): la ✦ lo dice, no es un fallo (Dani 15-11)
    } else if (forced && entry && entry.seq !== seq && !entry.pending && !entry.text) {
      // Solo si de verdad empezó otro turno (seq nuevo): una respuesta vacía de esta misma generación ya dejó «nada que sugerir».
      console.log(`suggest: respuesta descartada para ${agentId} (la sesión se movió)`);
      entry.error = "la sesión se movió mientras se generaba"; // only if no newer generation is in flight to settle itself
    }
  } catch (error) {
    // Silent for the quiet window, visible in `paseo plugin logs`: which step refused (no-session, no-transcript, unreadable, router).
    const message = error instanceof SessionError ? error.message : error instanceof Error ? error.message : "unknown";
    console.warn(`suggest: no generation for ${agentId}: ${message}`);
    settle(message);
  } finally {
    avisa(agentId); // whatever the generation left — text, nada, error, or nothing because the session moved on
  }
}

// ---- «Seguir en automático» ---------------------------------------------------------------------------
// With «Seguir» on for an agent, every completed turn re-evaluates (arm → reevaluar) and the plugin sends the next step
// itself, through the SAME engine as the pill (sugiereRequest → /v1/suggest): no auditor session, no cron, no ticket. The
// objective is conversational — the text the user edited, which rides to the service as a synthetic user turn and reaches
// A inside the sent message (objective + scope, not just the model's text); the anchor's plan is NOT read here (it belongs
// to another flow). `seguir(agentId, null)` is STOP (the contract's meaning): it pauses at once, even mid-start or with an
// evaluation in flight, and nothing that was in flight is ever sent. Before every send everything is fail closed — the real
// /v1/verdict on exactly the message being sent, then the world re-checked (idle / not archived / no permission open, the
// rutador's delegation fence from server/delegation.ts, the supervisor's current pair registry: a pair's B or an A the
// supervisor pilots is not followed). Nothing is silently truncated: an objective or a step over the contract's cap is
// refused. Any veto, external driver, cancellation, repeated step or ambiguous verdict pauses the follow-up with its
// reason; only a new «Seguir» resumes it. The state is memory-only: a host restart leaves it off.

type Seguimiento = {
  activo: boolean;
  objetivo: string; // the real objective A receives and the engine is asked with
  alcance: string; // the scope line A receives with it
  motivo: string; // what the popover paints: why it is running, or why it paused
  seq: number; // bumps when the session moves on: invalidates an evaluation in flight (never send after stop)
  enCurso: boolean; // dedup concurrente: one evaluation at a time per agent
  ultimo: string | null; // the exact message last sent: the same one again is repetition
};
const seguimientos = new Map<string, Seguimiento>();
const arranques = new Map<string, Promise<{ ok: boolean; error?: string }>>(); // two «Seguir» at once share one start
const generaciones = new Map<string, number>(); // «Seguir» off bumps it: a start in flight aborts and never installs an entry

const OBJETIVO_MAX = 3_000; // the verdict caps the whole message at 4 000 (docs §3): no silent truncation, longer is refused
const MENSAJE_MAX = 4_000;
const ALCANCE = "Solo este objetivo; no amplíes el alcance ni abras trabajo nuevo fuera de él.";
type Paseo = PluginHandlerContext["paseo"];
type Agente = { id: string; cwd?: string; status?: string; archivedAt?: string | null; pendingPermissions?: unknown };

/** What the pill paints for this agent: active or paused, the objective it follows and why. undefined = never followed. */
export function seguimiento(agentId: string): { activo: boolean; objetivo: string; motivo: string } | undefined {
  const s = seguimientos.get(agentId);
  return s ? { activo: s.activo, objetivo: s.objetivo, motivo: s.motivo } : undefined;
}

/** «Seguir» in the popover. The contract's meaning of the two shapes: a text `objetivo` starts (or keeps) the
 * follow-up — the text the user edited, never a Jira key and never read from the anchor — and `objetivo === null` STOPS it:
 * immediate pause, invalidating a start or an evaluation in flight so nothing in flight is ever sent. Starting refuses
 * without touching anything: plugin off, an objective over the cap (never truncated), the rutador holding the session, or
 * the supervisor's registry saying this agent is a pair's B or an A it already pilots. Concurrent starts dedup: the second
 * gets the first's result. On success, an idle session is evaluated right away. */
export function seguir(agentId: string, objetivo: string | null, context: PluginHandlerContext): Promise<{ ok: boolean; error?: string }> {
  if (objetivo === null) {
    pararSeguimiento(agentId, "parado a petición");
    return Promise.resolve({ ok: true });
  }
  const enMarcha = arranques.get(agentId);
  if (enMarcha) return enMarcha;
  const arranque = arrancarSeguimiento(agentId, objetivo, context).finally(() => arranques.delete(agentId));
  arranques.set(agentId, arranque);
  return arranque;
}

/** The stop: bumps the generation (a start in flight aborts and installs nothing), bumps the entry's seq (an evaluation in
 * flight never sends) and leaves the paused entry with its reason for the pill. Idempotent: stopping what is not running is ok. */
function pararSeguimiento(agentId: string, motivo: string): void {
  generaciones.set(agentId, (generaciones.get(agentId) ?? 0) + 1);
  const s = seguimientos.get(agentId);
  if (s) {
    s.seq += 1;
    s.activo = false;
    s.motivo = motivo;
    avisa(agentId);
  }
}

async function arrancarSeguimiento(agentId: string, objetivo: string, context: PluginHandlerContext): Promise<{ ok: boolean; error?: string }> {
  const gen = generaciones.get(agentId) ?? 0;
  const parado = () => (generaciones.get(agentId) ?? 0) !== gen; // «Seguir» off arrived while we were checking
  if (!enabled) return { ok: false, error: "Sugerir está apagado en los ajustes" };
  const previo = seguimientos.get(agentId);
  if (previo?.activo) return { ok: true }; // already following: a second «Seguir» never duplicates the loop
  const texto = objetivo.trim();
  if (!texto) return { ok: false, error: "escribe el objetivo que hay que seguir" };
  if (texto.length > OBJETIVO_MAX) return { ok: false, error: `el objetivo excede ${OBJETIVO_MAX} caracteres: acótalo (no se trunca)` };
  const agent = await buscarAgente(agentId, context.paseo);
  if (parado()) return { ok: false, error: "el seguimiento se paró durante el arranque" };
  if (!agent) return { ok: false, error: "esta sesión ya no existe en Paseo" };
  if (agent.archivedAt) return { ok: false, error: "la sesión está archivada" };
  const bloqueo = bloqueoDelegacion(agentId);
  if (bloqueo) return { ok: false, error: `${bloqueo}: libera la delegación antes de seguir` };
  const reg = registroSupervisor(agentId);
  if (reg.error) return { ok: false, error: `${reg.error} (fail closed)` };
  if (reg.esB) return { ok: false, error: "esta sesión es la auditora B de una pareja del supervisor: el seguimiento no la pilota" };
  if (reg.par) return { ok: false, error: `el supervisor ya pilota esta sesión (${reg.par}): para la pareja antes de seguirla` };
  if (!enabled) return { ok: false, error: "Sugerir está apagado en los ajustes" }; // the plugin went off while the checks ran
  if (parado()) return { ok: false, error: "el seguimiento se paró durante el arranque" };
  const s: Seguimiento = {
    activo: true,
    objetivo: texto,
    alcance: ALCANCE,
    motivo: "siguiendo",
    seq: 0,
    enCurso: false,
    ultimo: null, // a restart of «Seguir» is a new intent: the old last message does not count as repetition
  };
  seguimientos.set(agentId, s);
  avisa(agentId);
  console.log(`suggest: seguimiento encendido para ${agentId}: ${JSON.stringify(s.objetivo.slice(0, 80))}`);
  if (agent.status === "idle") void reevaluar(agentId, context); // waiting on the user: the first step now, not after a turn
  return { ok: true };
}

async function buscarAgente(agentId: string, paseo: Paseo): Promise<Agente | null> {
  const { entries } = await paseo.agents.list({ page: { limit: 200 } });
  return (entries.find(({ agent }) => agent.id === agentId)?.agent as Agente | undefined) ?? null;
}

/** The message A receives and the judge rules on, byte for byte: the real objective and the scope, not only the model's text.
 * The `[SEGUIMIENTO]` marker keeps it out of `objetivoDeAgente`'s human-message filter (objetivo.ts). Nothing is truncated:
 * a message over the verdict's cap (docs §3, 4 000) is refused by the caller, never sent cut short. */
const mensajeDe = (s: Seguimiento, paso: string) => `[SEGUIMIENTO] Objetivo: ${s.objetivo}\nAlcance: ${s.alcance}\n\n${paso}`;

const permisosAbiertos = (ag: Agente): number =>
  Array.isArray(ag.pendingPermissions) ? ag.pendingPermissions.length : Object.keys((ag.pendingPermissions as object | undefined) ?? {}).length;

/** Why this session cannot receive an automatic send right now — null if it can. Checked before the verdict and again, with
 * the same eyes, immediately before the send: idle, not archived, and no permission open (the follow-up never authorizes). */
function motivoSesion(ag: Agente | null): string | null {
  if (!ag) return "la sesión ya no existe en Paseo: en pausa";
  if (ag.archivedAt) return "la sesión está archivada: en pausa";
  if (ag.status !== "idle") return `la sesión no está libre (status ${ag.status}): en pausa`;
  if (permisosAbiertos(ag)) return "la sesión espera un permiso: es decisión tuya; el seguimiento nunca autoriza permisos";
  return null;
}

/** The supervisor's registry (`file.autopilot.pares.v1`), read fresh — the plugin must not send over a pair the supervisor
 * owns, and a session that is a pair's B is the auditor, not a followed session. Fail closed: unreadable or non-v1 = error. */
function registroSupervisor(agentId: string): { esB: boolean; par: string | null; error: string | null } {
  let raw: string;
  try {
    raw = readFileSync(rutaPorDefecto(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { esB: false, par: null, error: null }; // no registry: no pairs
    return { esB: false, par: null, error: `el registro de parejas del supervisor no se pudo leer (${(error as Error).message})` };
  }
  let store: { version?: unknown; pares?: unknown };
  try {
    store = JSON.parse(raw);
  } catch {
    return { esB: false, par: null, error: "el registro de parejas del supervisor no es JSON" };
  }
  if (store?.version !== 1 || typeof store.pares !== "object" || store.pares === null || Array.isArray(store.pares)) {
    return { esB: false, par: null, error: "el registro de parejas del supervisor no es un v1 {version, pares}" };
  }
  for (const [clave, valor] of Object.entries(store.pares as Record<string, unknown>)) {
    const par = (valor ?? {}) as { a_id?: unknown; b_id?: unknown; key?: unknown };
    if (par.b_id === agentId) return { esB: true, par: null, error: null };
    if (clave === agentId || par.a_id === agentId) {
      return { esB: false, par: typeof par.key === "string" && par.key ? par.key : clave, error: null };
    }
  }
  return { esB: false, par: null, error: null };
}

function pausar(s: Seguimiento, agentId: string, motivo: string): void {
  if (seguimientos.get(agentId) !== s) return; // a newer «Seguir» owns the agent now: this evaluation belongs to an old run
  s.activo = false;
  s.motivo = motivo;
  console.warn(`suggest: seguimiento de ${agentId} en pausa: ${motivo}`);
  avisa(agentId);
}

/** A completed turn with «Seguir» on (arm), or the session idle at start: one evaluation, deduped, all gates fail closed.
 * Anything that is not a clear green light pauses — veto, external driver, cancellation, repetition, ambiguity — and a stop
 * (finFallido / a turn started) bumps seq so an answer arriving late never sends. */
async function reevaluar(agentId: string, context: PluginHookContext | PluginHandlerContext): Promise<void> {
  const s = seguimientos.get(agentId);
  if (!s || !s.activo || s.enCurso) return; // dedup concurrente: one evaluation at a time per agent
  s.enCurso = true;
  const seq = ++s.seq;
  const viva = () => s.activo && s.seq === seq && enabled && seguimientos.get(agentId) === s;
  try {
    s.motivo = "pensando el siguiente paso";
    avisa(agentId);
    const lines = await locateSession(agentId, context.paseo);
    if (!viva()) return;
    const { messages, model } = transcriptMessages(lines);
    if (!model) return pausar(s, agentId, "la sesión aún no tiene modelo: nada que seguir");
    if (messages.at(-1)?.role !== "assistant") return pausar(s, agentId, "ha hablado alguien de fuera (la sesión no espera al asistente): en pausa");
    // The same engine as the pill: sugiereRequest → /v1/suggest, with the objective as a synthetic user turn — no Jira plan.
    const answer = await sugiereRequest(agentId, seq, lines, null, s.objetivo);
    if (!viva()) return;
    if (answer.status !== 200) return pausar(s, agentId, `el servicio sugiere respondió ${answer.status} (fail closed): en pausa`);
    const paso = answer.sugerencia;
    // An empty answer is the engine declining: pause without claiming the work is delivered — it only saw no next step.
    if (!paso) return pausar(s, agentId, "el motor no propuso ningún paso: en pausa");
    const mensaje = mensajeDe(s, paso);
    if (mensaje.length > MENSAJE_MAX) {
      return pausar(s, agentId, `el paso propuesto excede el tope del dictamen (${MENSAJE_MAX}): rechazado, no se trunca`);
    }
    if (mensaje === s.ultimo) return pausar(s, agentId, "el paso se repite: es exactamente el mensaje ya enviado; en pausa");
    // The gates before asking the judge, all fail closed.
    const agent = await buscarAgente(agentId, context.paseo);
    if (!viva()) return;
    const motivoAgente = motivoSesion(agent);
    if (motivoAgente) return pausar(s, agentId, motivoAgente);
    const bloqueo = bloqueoDelegacion(agentId);
    if (bloqueo) return pausar(s, agentId, `${bloqueo}: el rutador lleva la sesión; en pausa`);
    const reg = registroSupervisor(agentId);
    if (reg.error) return pausar(s, agentId, `${reg.error} (fail closed)`);
    if (reg.esB) return pausar(s, agentId, "el supervisor hizo de esta sesión su auditora B: en pausa");
    if (reg.par) return pausar(s, agentId, `el supervisor pilota esta sesión (${reg.par}): en pausa`);
    // The real verdict, on exactly the message about to be sent (docs/servicio-sugiere.md §3): no clear `ok` is a veto.
    let dictamen: { status: number; out: Record<string, unknown> } | null = null;
    try {
      dictamen = await verdictRequest(agentId, seq, mensaje, { kind: "live", ...(agent?.cwd ? { cwd: agent.cwd } : {}) });
    } catch {
      dictamen = null; // no answer in time: fail closed, nothing goes out
    }
    if (!viva()) return;
    if (!dictamen || dictamen.status !== 200 || typeof dictamen.out.ok !== "boolean") {
      return pausar(s, agentId, "dictamen ausente o ambiguo (fail closed): no se envía");
    }
    if (dictamen.out.ok !== true) {
      const riesgo = typeof dictamen.out.riesgo === "string" && dictamen.out.riesgo ? ` (${dictamen.out.riesgo})` : "";
      const porQue = typeof dictamen.out.motivo === "string" && dictamen.out.motivo ? dictamen.out.motivo : "el juez no lo ve enviable";
      return pausar(s, agentId, `veto del juez${riesgo}: ${porQue}`);
    }
    // The world may have moved while the judge thought: re-validate idle/permissions/ownership right before the send.
    const trasAgente = await buscarAgente(agentId, context.paseo);
    if (!viva()) return;
    const motivoTras = motivoSesion(trasAgente);
    if (motivoTras) return pausar(s, agentId, `${motivoTras} (cambió mientras dictaminaba el juez)`);
    const tras = bloqueoDelegacion(agentId);
    if (tras) return pausar(s, agentId, `${tras}: el rutador enlazó la sesión mientras el juez pensaba; no se envía`);
    const regTras = registroSupervisor(agentId);
    if (regTras.error) return pausar(s, agentId, `${regTras.error} (fail closed)`);
    if (regTras.esB) return pausar(s, agentId, "el supervisor hizo de esta sesión su auditora B mientras dictaminaba: en pausa");
    if (regTras.par) return pausar(s, agentId, `el supervisor piloto esta sesión (${regTras.par}) mientras dictaminaba: en pausa`);
    if (!viva()) return;
    try {
      await context.paseo.agents.ref(agentId).send(mensaje, { activeTurnBehavior: "steer" });
    } catch (error) {
      return pausar(s, agentId, `no se pudo enviar: ${(error as Error).message}`);
    }
    s.ultimo = mensaje;
    s.motivo = `enviado: ${paso.slice(0, 120)}`;
  } catch (error) {
    // A failed read of the session, a refused service call: pause with its cause — never a blind send.
    if (viva()) pausar(s, agentId, `no se pudo evaluar el siguiente paso: ${error instanceof Error ? error.message : "unknown"}`);
  } finally {
    if (seguimientos.get(agentId) === s) {
      s.enCurso = false;
      avisa(agentId);
    }
  }
}
