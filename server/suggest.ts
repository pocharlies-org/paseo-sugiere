// The next-message suggestion: after a turn ends quietly for a minute, one small call to the resident proposes what the
// user should send next, and the composer pill shows it. Port of OpenChamber's session-assist: same 60 s quiet window, same rule
// that a finished conversation gets nothing. Nothing here touches the session: the call goes to the router with the local alias
// `qwen38-off`, so the resident only pays the decode of the answer once its prefix cache hits (unmeasured in vivo yet).
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

// The instruction the resident gets, in a file the plugin owns — the only way to change it (Dani 17-10: the in-pill editor was
// dead weight, the pill is for sending). "" = the built-in SUGGESTION_INSTRUCTION. Read with every generation, so a hand edit
// takes effect without restarting the host.
const PROMPT_FILE = join(homedir(), ".local", "state", "paseo-sugiere", "prompt.txt");

type Entry = { timer?: ReturnType<typeof setTimeout>; seq: number; text: string | null };
const agents = new Map<string, Entry>();

/** A turn ended completed: after the quiet window, one generation, unless anything happens first. */
export function arm(agentId: string, context: PluginHookContext): void {
  if (!enabled) return;
  const entry = agents.get(agentId) ?? { seq: 0, text: null };
  if (entry.timer) clearTimeout(entry.timer);
  entry.seq += 1;
  entry.text = null;
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
}

export function get(agentId: string): string | null {
  return enabled ? (agents.get(agentId)?.text ?? null) : null;
}

/** The user clicked the pill with nothing suggested: generate now, no quiet window. Never waits for the answer: the
 * generation can take longer than the host's 60 s RPC timeout (measured 19-10: «Plugin RPC timed out» on every slow router). */
export function force(agentId: string, context: PluginHandlerContext): boolean {
  console.log(`suggest: force pedido por la pill para ${agentId} (enabled=${enabled})`);
  if (!enabled) return false;
  const entry = agents.get(agentId) ?? { seq: 0, text: null };
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.seq += 1;
  entry.text = null;
  agents.set(agentId, entry);
  void generate(agentId, entry.seq, context);
  return true;
}

export function dispose(): void {
  for (const [id] of agents) cancel(id);
  agents.clear();
}

/** Silent by design: no transcript, a missing file, a refused call — there is simply no suggestion, and the pill shows nothing. */
async function generate(agentId: string, seq: number, context: PluginHandlerContext): Promise<void> {
  try {
    const lines = await locateSession(agentId, context.paseo);
    // Sync and read per generation: no override file is the normal case (built-in instruction), and the read adds no await, so the
    // seq guard stays built on the two awaits below. A hand edit of the file takes effect on the next suggestion.
    let instruction = "";
    try {
      instruction = readFileSync(PROMPT_FILE, "utf8");
    } catch {}
    const answer = await routerRequest(suggestBody(lines, instruction));
    if (answer.status !== 200) {
      console.warn(`suggest: el router respondió ${answer.status} para ${agentId}: ${answer.text.slice(0, 200)}`);
      return;
    }
    const text = suggestionAnswer(JSON.parse(answer.text), lastAssistantText(lines));
    if (!text) console.log(`suggest: respuesta vacía (nada que sugerir) para ${agentId}`);
    const entry = agents.get(agentId);
    if (entry && entry.seq === seq && text) {
      console.log(`suggest: generada para ${agentId}: ${JSON.stringify(text.slice(0, 60))}`);
      entry.text = text; // the session moved on while the resident answered
    } else if (entry && entry.seq !== seq) {
      console.log(`suggest: respuesta descartada para ${agentId} (la sesión se movió)`);
    }
  } catch (error) {
    // Silent for the user, visible in `paseo plugin logs`: which step refused (no-session, no-transcript, unreadable, router).
    console.warn(`suggest: no generation for ${agentId}: ${error instanceof SessionError ? error.message : error instanceof Error ? error.message : "unknown"}`);
  }
}
