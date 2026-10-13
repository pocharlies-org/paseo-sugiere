// Finding the agent's transcript and the one call to the local router. The suggestion goes to a local alias (`qwen38-off`): the router
// discards the bearer for those (measured 13-10: 200 with a dummy token), so this plugin reads no account and no token of
// ~/.config/claude-cuentas — it is not a consumer of that contract.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// The server runtime boundary forbids importing @getpaseo/client: the API type comes from the SDK's own context.
type PaseoApi = PluginHandlerContext["paseo"];

const ROUTER = { host: "127.0.0.1", port: 18791 };
const TIMEOUT_MS = 120_000;
const MAX_BYTES = 4 * 1024 * 1024;

const FAILURE_TEXT = {
  "no-session": "this agent has no Claude session",
  "no-transcript": "the session's transcript is not on this machine",
  unreadable: "the session could not be read on this machine",
  router: "the local router did not answer",
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

async function findIn(projectsDir: string, name: string): Promise<string | null> {
  for (const project of await readdir(projectsDir).catch(() => [])) {
    const candidate = join(projectsDir, project, name);
    if (await stat(candidate).then((s) => s.isFile(), () => false)) return candidate;
  }
  return null;
}

/** The one call to the local router; the status stays the caller's decision. fetch is enough here: the refusal of `Sec-Fetch-*`
belongs to the account service, and the router answers 200 with those headers (measured 13-10). */
export async function routerRequest(body: string): Promise<{ status: number; text: string }> {
  try {
    const response = await fetch(`http://${ROUTER.host}:${ROUTER.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: "Bearer paseo-sugiere" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    return { status: response.status, text: text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text };
  } catch {
    throw new SessionError("router");
  }
}
