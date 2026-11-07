// The next-message suggestion: after a turn ends quietly for a minute, one small call proposes what the user should send next,
// and the composer pill shows it. Port of OpenChamber's session-assist: same 60 s quiet window, same rule that a finished
// conversation gets nothing. Nothing here touches the session: the suggestion comes from the cluster's `sugiere` service
// (Dani 05-11), the same place the company uses, so there is one mechanism and not two.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext, PluginHookContext } from "@getpaseo/plugin/server";
import { transcriptMessages } from "../shared/transcript.ts";
import { SessionError, locateSession, nativeSuggestion, sugiereRequest } from "./session.ts";

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

// The instruction is the service's alone (Dani's decision 5): the plugin sends none. The old hand-edited
// ~/.local/state/paseo-sugiere/prompt.txt is no longer read.

// The plan anchor paseo-plan writes per agent (paseo-plan's file contract). Read with every turn end and generation, so «Garantizar
// plan» switched in the pill takes effect on the next turn without restarting the host.
const ANCHOR_DIR = join(homedir(), ".local", "state", "paseo-plan");

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

/** The ticket the agent is anchored to, guard or not: the autopilot sends it as `contexto.key`. */
export function anchorKey(agentId: string): string {
  const key = anchorOf(agentId)?.ticketKey;
  return typeof key === "string" ? key : "";
}

/** Three «no es esto» in a row and the ✦ goes quiet: no guarded generation until the user clicks it (the plan, «Deriva»).
 * shortcut: the count lives in memory, so a host restart forgets it; persist it if that turns out to matter. */
const MAX_NOES = 3;

// pending/error describe only the last FORCE (the pill spins on pending and shows error once); the quiet window stays silent by design.
// en_plan/criterio come with an anchored suggestion; noes/muted survive turns (the streak is across turns) and only reset on use or click.
type Entry = {
  timer?: ReturnType<typeof setTimeout>;
  seq: number;
  text: string | null;
  en_plan: string | null;
  criterio: string | null;
  pending: boolean;
  error: string | null;
  noes: number;
  muted: boolean;
};
const agents = new Map<string, Entry>();
const fresh = (): Entry => ({ seq: 0, text: null, en_plan: null, criterio: null, pending: false, error: null, noes: 0, muted: false });
const clear = (entry: Entry) => Object.assign(entry, { text: null, en_plan: null, criterio: null, pending: false, error: null });

/** A turn ended completed: after the quiet window, one generation, unless anything happens first. Only with `auto` —
off by default (Dani 25-10): each automatic suggestion pays the whole transcript of its session; without auto the user's click forces it.
With «Garantizar plan» on for this agent it generates right away at every turn end, auto or not; sending stays the user's tap. */
export function arm(agentId: string, context: PluginHookContext): void {
  const guarded = guardedPlan(agentId) !== null;
  if (!enabled || (!auto && !guarded)) return;
  const entry = agents.get(agentId) ?? fresh();
  agents.set(agentId, entry);
  if (entry.muted) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.seq += 1;
  clear(entry);
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

/** Anything new — a turn started, a failed end, a dismissal: the pending suggestion is gone and an in-flight answer will not land. */
export function cancel(agentId: string): void {
  const entry = agents.get(agentId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.seq += 1;
  clear(entry);
}

/** The agent's turn counter (the `seq`): every turn start bumps it, so the autopilot drops an answer that lands after one. */
export function turn(agentId: string): number {
  const entry = agents.get(agentId) ?? fresh();
  agents.set(agentId, entry);
  return entry.seq;
}

export function get(agentId: string): string | null {
  return enabled ? (agents.get(agentId)?.text ?? null) : null;
}

/** The state of the last force for the pill: spin while pending, show the error once when it failed. */
export function state(agentId: string): { pending: boolean; error: string | null } {
  const entry = enabled ? agents.get(agentId) : undefined;
  return { pending: entry?.pending ?? false, error: entry?.error ?? null };
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
  void generate(agentId, entry.seq, context, true);
  return true;
}

export function dispose(): void {
  for (const [id] of agents) cancel(id);
  agents.clear();
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
    const entry = settle(text ? null : "nada que sugerir");
    if (entry && entry.seq === seq && text) {
      console.log(`suggest: generada para ${agentId} con ${answer.modelo}${plan ? ` (${answer.en_plan} · ${answer.criterio})` : ""}: ${JSON.stringify(text.slice(0, 60))}`);
      entry.text = text;
      entry.en_plan = answer.en_plan;
      entry.criterio = answer.criterio;
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
  }
}
