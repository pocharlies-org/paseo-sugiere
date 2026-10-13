// The next-message suggestion: after a turn ends quietly for a minute, one small call to the resident proposes what the
// user should send next, and the composer pill shows it. Port of OpenChamber's session-assist: same 60 s quiet window, same rule
// that a finished conversation gets nothing. Nothing here touches the session: the call goes to the router with the account's
// bearer and the model `qwen38-off`, so it costs the resident's cache hit and ~40 tokens of decode.
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { suggestBody, suggestionAnswer } from "../shared/suggest.ts";
import { SessionError, locateSession, routerRequest } from "./session.ts";

const QUIET_MS = 60_000;

type Entry = { timer?: ReturnType<typeof setTimeout>; seq: number; text: string | null };
const agents = new Map<string, Entry>();

/** A turn ended completed: after the quiet window, one generation, unless anything happens first. */
export function arm(agentId: string, context: PluginHookContext): void {
  const entry = agents.get(agentId) ?? { seq: 0, text: null };
  if (entry.timer) clearTimeout(entry.timer);
  entry.seq += 1;
  entry.text = null;
  const seq = entry.seq;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void generate(agentId, seq, context);
  }, QUIET_MS);
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
  return agents.get(agentId)?.text ?? null;
}

export function dispose(): void {
  for (const [id] of agents) cancel(id);
  agents.clear();
}

/** Silent by design: no transcript, no account, a refused call — there is simply no suggestion, and the pill shows nothing. */
async function generate(agentId: string, seq: number, context: PluginHookContext): Promise<void> {
  try {
    const { lines, configDir } = await locateSession(agentId, context.paseo);
    const answer = await routerRequest(suggestBody(lines), configDir);
    if (answer.status !== 200) return;
    const text = suggestionAnswer(JSON.parse(answer.text));
    const entry = agents.get(agentId);
    if (entry && entry.seq === seq && text) entry.text = text; // the session moved on while the resident answered
  } catch (error) {
    if (!(error instanceof SessionError)) console.warn("suggest: generation failed for one agent", error instanceof Error ? error.message : "");
  }
}
