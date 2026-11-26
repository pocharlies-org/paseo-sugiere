// Finding the agent's transcript and the one call to the model door. The suggestion goes with the session's own model. The house retired the loopback claude-router (18791, unit stopped and deleted 20-10): the door is now LiteLLM, whose url and key live in
// ~/.config/claude-local/env (`export NOMBRE=valor`, one per line) — the same file company_env.py reads. The key goes in the header, never in argv.
import { open, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { SUGGEST_WAIT_MS } from "../shared/suggest.ts";
import { forService, newestMessage } from "../shared/transcript.ts";

// The server runtime boundary forbids importing @getpaseo/client: the API type comes from the SDK's own context.
type PaseoApi = PluginHandlerContext["paseo"];

const TIMEOUT_MS = 120_000;
const SUGIERE_TIMEOUT_MS = SUGGEST_WAIT_MS + 15_000; // lo que espera el servicio al residente, y margen
const VERDICT_TIMEOUT_MS = 75_000; // la rúbrica mantiene 60 s (docs §3); el seguimiento la espera en segundo plano, sin RPC
const MAX_BYTES = 4 * 1024 * 1024;

const FAILURE_TEXT = {
  "no-session": "this agent has no Claude session",
  "no-transcript": "the session's transcript is not on this machine",
  unreadable: "the session could not be read",
  router: "the model door (LiteLLM) did not answer",
  servicio: "the cluster's sugiere service did not answer",
} as const;

export class SessionError extends Error {
  constructor(kind: keyof typeof FAILURE_TEXT, cause?: unknown) {
    super(cause instanceof Error ? `${FAILURE_TEXT[kind]} (${cause.message})` : FAILURE_TEXT[kind]);
  }
}

/** The transcript of an agent: the Claude providers of Paseo's config, each resuming from its own projects folder. */
export async function locateSession(agentId: string, paseo: PaseoApi): Promise<string[]> {
  try {
    const { entries } = await paseo.agents.list({ page: { limit: 200 } });
    const agent = entries.find(({ agent }) => agent.id === agentId)?.agent;
    const sessionId = (agent as { persistence?: { sessionId?: string } } | undefined)?.persistence?.sessionId;
    if (!sessionId) throw new SessionError("no-session");
    const found = await findTranscript(sessionId);
    if (found) return forService((await readFile(found, "utf8")).split("\n"));
    throw new SessionError("no-transcript");
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw new SessionError("unreadable", error);
  }
}

/** The file of a session's transcript, or null if no provider has it. Throws if Paseo's config cannot be read. */
async function findTranscript(sessionId: string): Promise<string | null> {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  const providers: Record<string, any> = { claude: {}, ...config?.agents?.providers };
  for (const p of Object.values(providers)) {
    if (p?.enabled === false) continue;
    const projects = join(p?.env?.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
    const found = await findIn(projects, `${sessionId}.jsonl`);
    if (found) return found;
  }
  return null;
}

/** El servicio `sugiere` del clúster: la única puerta de la sugerencia, la misma que usa la compañía (Dani, 05-11). En el
 * pod de Paseo se resuelve por el DNS del clúster; fuera, `SUGIERE_URL` apunta a su IP. Su plazo es mayor que el del
 * servicio (`SUGGEST_WAIT_MS` esperando al residente), o toda sugerencia lenta se perdería aquí.
 * Con `objetivo` («Seguir en automático») el objetivo conversacional viaja como turno sintético de
 * usuario al final del transcript: sin plan de Jira y sin el sistema de entrega de Jira — el mismo /v1/suggest de la ✦,
 * un motor para los dos. Sin objetivo, la llamada es byte a byte la de siempre. */
export async function sugiereRequest(
  sid: string,
  turno: number,
  lines: string[],
  plan: object | null,
  objetivo = "",
): Promise<{ status: number; sugerencia: string; modelo: string; en_plan: string | null; criterio: string | null }> {
  const contexto = { kind: "live", ...(plan ? { plan } : {}) };
  const sintetica = objetivo.trim()
    ? JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: objetivo.trim() }] } })
    : null;
  const transcript = sintetica ? [...lines, sintetica].join("\n") : lines.join("\n");
  const { status, out } = await sugierePost("/v1/suggest", { sid, turno, transcript, contexto }, SUGIERE_TIMEOUT_MS);
  return {
    status,
    sugerencia: typeof out.sugerencia === "string" ? out.sugerencia.trim() : "",
    modelo: typeof out.modelo === "string" ? out.modelo : "",
    en_plan: typeof out.en_plan === "string" ? out.en_plan : null,
    criterio: typeof out.criterio === "string" && out.criterio ? out.criterio : null,
  };
}

/** El dictamen del juez sobre un mensaje a punto de enviarse (`POST /v1/verdict`, docs/servicio-sugiere.md §3): la puerta
 * juzga exactamente el texto que el llamante va a mandar. La rúbrica tarda hasta 60 s; sin respuesta a tiempo es
 * `SessionError("servicio")` y el llamante lo trata como veto — fail closed, como manda el contrato. */
export async function verdictRequest(
  sid: string,
  turno: number,
  sugerencia: string,
  contexto: object,
): Promise<{ status: number; out: Record<string, unknown> }> {
  return sugierePost("/v1/verdict", { sid, turno, sugerencia, contexto }, VERDICT_TIMEOUT_MS);
}

/** One POST to the `sugiere` service: the status and the JSON body (empty if it is not JSON). No answer in time is `SessionError("servicio")`. */
async function sugierePost(path: string, body: object, timeoutMs: number): Promise<{ status: number; out: Record<string, unknown> }> {
  const base = (process.env.SUGIERE_URL || "http://sugiere.llm.svc:8080").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Also on a refusal: its `{error}` says why; callers read only typed fields, so an error body is inert.
    return { status: response.status, out: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    throw new SessionError("servicio");
  } finally {
    clearTimeout(timer);
  }
}

// Only when the transcript cannot be read: then the age of the file is all there is to go by.
const NATIVE_FALLBACK_MS = 15 * 60_000;
// The tail of the transcript is read, not all of it: a session open for weeks is tens of MB, and its last message is at the end.
const TAIL_START = 256 * 1024;
const TAIL_MAX = 32 * 1024 * 1024;

// CONTRACT: file.paseo.suggest-native.v1
/** The native suggestion of the session : the patched Paseo daemon writes the `prompt_suggestion` the CLI forks
from the session's own cached prefix to `$PASEO_HOME/.paseo/suggest/<claude-session-id>.json` as `{text, at}`, once per turn,
overwriting the last one. It is valid until the session's next message: the file must be newer than the newest conversation
message of the transcript, and that message must close a turn (`isCurrent`), however long ago that was. The file is checked first
and consumed only when its text is served (one native suggestion per turn: the next force of the turn goes to the service). A file
that is stale, malformed or empty is never deleted by a read — the next turn overwrites it. Null on anything else, and the caller
then makes its own call as before. */
export async function nativeSuggestion(agentId: string, paseo: PaseoApi): Promise<string | null> {
  try {
    const { entries } = await paseo.agents.list({ page: { limit: 200 } });
    const sessionId = (entries.find(({ agent }) => agent.id === agentId)?.agent as { persistence?: { sessionId?: string } } | undefined)?.persistence?.sessionId;
    if (!sessionId) return null;
    // The same expression the daemon patch writes with: with PASEO_HOME set it lands one `.paseo` deeper (measured 06-11, 311 files
    // there and none where this used to read).
    const file = join(process.env.PASEO_HOME || process.env.HOME || homedir(), ".paseo", "suggest", `${sessionId}.json`);
    const raw = await readFile(file, "utf8").catch(() => "");
    if (!raw) return null;
    const { text, at } = JSON.parse(raw) as { text?: unknown; at?: unknown };
    if (typeof text !== "string" || !text.trim() || typeof at !== "number") return null;
    if (!(await isCurrent(sessionId, at))) return null;
    await consumeNative(file, at);
    return text.trim();
  } catch {
    return null;
  }
}

/** Deletes the native file that was just served, but only if it still is that one (same `at`): the daemon may have written the fork
 * of the next turn while the transcript was being read, and that one must survive. Anything unreadable is left alone. Exported for
 * its test: the window between the check and the delete cannot be hit from outside. */
export async function consumeNative(file: string, at: number): Promise<void> {
  try {
    if ((JSON.parse(await readFile(file, "utf8")) as { at?: unknown }).at === at) await rm(file, { force: true });
  } catch {
    // gone, being rewritten or not JSON: nothing to consume
  }
}

/** Whether a native file written at `at` still belongs to the end of the session's last turn: it must be newer than the newest
 * conversation message of the main transcript, and that message must be the assistant's closing one. A new user message — the
 * user's, Seguir's, a task notification — makes it stale; so does a fork that landed after the next turn had started (the
 * newest line is then a user message or a tool step, not a closing answer). With no readable transcript (no session file, no
 * message, an error) the old rule: valid only if at most 15 minutes old. */
async function isCurrent(sessionId: string, at: number): Promise<boolean> {
  const newest = await newestMessageOf(sessionId).catch(() => null);
  if (!newest) return Date.now() - at <= NATIVE_FALLBACK_MS;
  return newest.endsTurn && at > newest.at;
}

/** `newestMessage` of the session's transcript, read from the back in growing windows until one holds a message. */
async function newestMessageOf(sessionId: string): Promise<{ at: number; endsTurn: boolean } | null> {
  const file = await findTranscript(sessionId);
  if (!file) return null;
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    for (let bytes = TAIL_START; ; bytes = Math.min(bytes * 4, TAIL_MAX)) {
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
      if (start > 0) lines.shift(); // the first line is cut by the window
      const found = newestMessage(lines);
      if (found || start === 0 || bytes >= TAIL_MAX) return found;
    }
  } finally {
    await handle.close();
  }
}

/** A session copied to another project keeps its id: the live copy is the last one written, never the first one listed (10-11:
 * the autopilot read a stale copy with no `[AUTOPILOT]` in it, counted zero steps and resent its start 1.299 times). */
async function findIn(projectsDir: string, name: string): Promise<string | null> {
  let found: { path: string; mtime: number } | null = null;
  for (const project of await readdir(projectsDir).catch(() => [])) {
    const path = join(projectsDir, project, name);
    const s = await stat(path).catch(() => null);
    if (s?.isFile() && (!found || s.mtimeMs > found.mtime)) found = { path, mtime: s.mtimeMs };
  }
  return found?.path ?? null;
}
