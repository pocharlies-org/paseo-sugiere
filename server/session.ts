// Finding the agent's transcript and the one call to the model door. The suggestion goes with the session's own model. The house retired the loopback claude-router (18791, unit stopped and deleted 20-10): the door is now LiteLLM, whose url and key live in
// ~/.config/claude-local/env (`export NOMBRE=valor`, one per line) — the same file company_env.py reads. The key goes in the header, never in argv.
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// The server runtime boundary forbids importing @getpaseo/client: the API type comes from the SDK's own context.
type PaseoApi = PluginHandlerContext["paseo"];

const TIMEOUT_MS = 120_000;
const SUGIERE_TIMEOUT_MS = 150_000;   // el servicio espera al residente hasta 60 s; aquí se le da margen
const MAX_BYTES = 4 * 1024 * 1024;

const FAILURE_TEXT = {
  "no-session": "this agent has no Claude session",
  "no-transcript": "the session's transcript is not on this machine",
  unreadable: "the session could not be read on this machine",
  router: "the model door (LiteLLM) did not answer",
  servicio: "the cluster's sugiere service did not answer",
} as const;

export class SessionError extends Error {
  constructor(kind: keyof typeof FAILURE_TEXT) {
    super(FAILURE_TEXT[kind]);
  }
}

/** The transcript of an agent: the Claude providers of Paseo's config, each resuming from its own projects folder. */
export async function locateSession(agentId: string, paseo: PaseoApi): Promise<string[]> {
  try {
    const { entries } = await paseo.agents.list({ page: { limit: 200 } });
    const agent = entries.find(({ agent }) => agent.id === agentId)?.agent;
    const sessionId = (agent as { persistence?: { sessionId?: string } } | undefined)?.persistence?.sessionId;
    if (!sessionId) throw new SessionError("no-session");
    const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    const providers: Record<string, any> = { claude: {}, ...config?.agents?.providers };
    for (const p of Object.values(providers)) {
      if (p?.enabled === false) continue;
      const projects = join(p?.env?.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
      const found = await findIn(projects, `${sessionId}.jsonl`);
      if (found) return (await readFile(found, "utf8")).split("\n");
    }
    throw new SessionError("no-transcript");
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw new SessionError("unreadable");
  }
}

/** El servicio `sugiere` del clúster: la única puerta de la sugerencia, la misma que usa la compañía (Dani, 05-11). En el
 * pod de Paseo se resuelve por el DNS del clúster; fuera, `SUGIERE_URL` apunta a su IP. Su plazo es mayor que el del
 * servicio (60 s esperando al residente), o toda sugerencia lenta se perdería aquí. */
export async function sugiereRequest(
  sid: string,
  turno: number,
  lines: string[],
  instruccion: string,
): Promise<{ status: number; sugerencia: string; modelo: string }> {
  const base = (process.env.SUGIERE_URL || "http://sugiere.llm.svc:8080").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUGIERE_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/v1/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid, turno, transcript: lines.join("\n"), contexto: instruccion ? { instruccion } : {} }),
      signal: controller.signal,
    });
    const out = response.ok ? ((await response.json().catch(() => ({}))) as Record<string, unknown>) : {};
    return {
      status: response.status,
      sugerencia: typeof out.sugerencia === "string" ? out.sugerencia.trim() : "",
      modelo: typeof out.modelo === "string" ? out.modelo : "",
    };
  } catch {
    throw new SessionError("servicio");
  } finally {
    clearTimeout(timer);
  }
}

/** The native suggestion of the session : the patched Paseo daemon writes the `prompt_suggestion` the CLI forks
from the session's own cached prefix to `$PASEO_HOME/suggest/<claude-session-id>.json`. Consumed on read (one suggestion
per turn) and only while fresh (15 min): a stale file belongs to a turn the user already answered. Null on anything else —
the caller then makes its own call as before. */
export async function nativeSuggestion(agentId: string, paseo: PaseoApi): Promise<string | null> {
  try {
    const { entries } = await paseo.agents.list({ page: { limit: 200 } });
    const sessionId = (entries.find(({ agent }) => agent.id === agentId)?.agent as { persistence?: { sessionId?: string } } | undefined)?.persistence?.sessionId;
    if (!sessionId) return null;
    const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
    const file = join(home, "suggest", `${sessionId}.json`);
    const raw = await readFile(file, "utf8").catch(() => "");
    if (!raw) return null;
    await rm(file, { force: true }).catch(() => {});
    const { text, at } = JSON.parse(raw) as { text?: unknown; at?: unknown };
    if (typeof text !== "string" || typeof at !== "number" || Date.now() - at > 15 * 60_000) return null;
    return text.trim() || null;
  } catch {
    return null;
  }
}

async function findIn(projectsDir: string, name: string): Promise<string | null> {
  for (const project of await readdir(projectsDir).catch(() => [])) {
    const candidate = join(projectsDir, project, name);
    if (await stat(candidate).then((s) => s.isFile(), () => false)) return candidate;
  }
  return null;
}
