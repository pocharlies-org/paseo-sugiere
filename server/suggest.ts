// The next-message suggestion: after a turn ends quietly for a minute, one small call proposes what the user should send next,
// and the composer pill shows it. Port of OpenChamber's session-assist: same 60 s quiet window, same rule that a finished
// conversation gets nothing. Nothing here touches the session: the call goes to LiteLLM with the session's own model (Dani 22-10),
// without sharing the session's cache — each suggestion pays for the conversation (up to ~100k tokens).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext, PluginHookContext } from "@getpaseo/plugin/server";
import { lastAssistantText, suggestBody, suggestionAnswer } from "../shared/suggest.ts";
import { SessionError, locateSession, routerRequest } from "./session.ts";

// The settings document in force: off drops every pending and shown suggestion; quiet is the silence window.
let enabled = true;
let quietMs = 60_000;
export function setEnabled(value: boolean): void {
  if (enabled && !value) dispose();
  enabled = value;
}
export function setQuietSeconds(seconds: number): void {
  quietMs = seconds * 1000;
}

// The instruction the model gets, in a file the plugin owns — the only way to change it (Dani 17-10: the in-pill editor was
// dead weight, the pill is for sending). "" = the built-in SUGGESTION_INSTRUCTION. Read with every generation, so a hand edit
// takes effect without restarting the host.
const PROMPT_FILE = join(homedir(), ".local", "state", "paseo-sugiere", "prompt.txt");

// pending/error describe only the last FORCE (the pill spins on pending and shows error once); the quiet window stays silent by design.
type Entry = { timer?: ReturnType<typeof setTimeout>; seq: number; text: string | null; pending: boolean; error: string | null };
const agents = new Map<string, Entry>();
const fresh = (): Entry => ({ seq: 0, text: null, pending: false, error: null });

/** A turn ended completed: after the quiet window, one generation, unless anything happens first. */
export function arm(agentId: string, context: PluginHookContext): void {
  if (!enabled) return;
  const entry = agents.get(agentId) ?? fresh();
  if (entry.timer) clearTimeout(entry.timer);
  entry.seq += 1;
  entry.text = null;
  entry.pending = false;
  entry.error = null;
  const seq = entry.seq;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void generate(agentId, seq, context);
  }, quietMs);
  agents.set(agentId, entry);
}

/** Anything new — a turn started, a failed end, a dismissal: the pending suggestion is gone and an in-flight answer will not land. */
export function cancel(agentId: string): void {
  const entry = agents.get(agentId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.seq += 1;
  entry.text = null;
  entry.pending = false;
  entry.error = null;
}

export function get(agentId: string): string | null {
  return enabled ? (agents.get(agentId)?.text ?? null) : null;
}

/** The state of the last force for the pill: spin while pending, show the error once when it failed. */
export function state(agentId: string): { pending: boolean; error: string | null } {
  const entry = enabled ? agents.get(agentId) : undefined;
  return { pending: entry?.pending ?? false, error: entry?.error ?? null };
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
  entry.text = null;
  entry.pending = true;
  entry.error = null;
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
    const lines = await locateSession(agentId, context.paseo);
    // Sync and read per generation: no override file is the normal case (built-in instruction), and the read adds no await, so the
    // seq guard stays built on the two awaits below. A hand edit of the file takes effect on the next suggestion.
    let instruction = "";
    try {
      instruction = readFileSync(PROMPT_FILE, "utf8");
    } catch {}
    const call = suggestBody(lines, instruction);
    if (!call) throw new Error("la sesión aún no tiene modelo"); // no real model, no call, no fallback: logged and shown by the catch below
    const answer = await routerRequest(call.body);
    if (answer.status !== 200) {
      console.warn(`suggest: el router respondió ${answer.status} para ${agentId} con ${call.model}: ${answer.text.slice(0, 200)}`);
      settle("el router no respondió bien");
      return;
    }
    const text = suggestionAnswer(JSON.parse(answer.text), lastAssistantText(lines));
    if (!text) console.log(`suggest: respuesta vacía (nada que sugerir) para ${agentId}`);
    const entry = settle(text ? null : "nada que sugerir");
    if (entry && entry.seq === seq && text) {
      console.log(`suggest: generada para ${agentId} con ${call.model}: ${JSON.stringify(text.slice(0, 60))}`);
      entry.text = text;
    } else if (forced && entry && !entry.pending && !entry.text) {
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
