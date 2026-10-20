// Finding the agent's transcript and the one call to the model door. The suggestion goes to a local alias (`qwen38-off`, the resident
// pool). The house retired the loopback claude-router (18791, unit stopped and deleted 20-10): the door is now LiteLLM, whose url and key live in
// ~/.config/claude-local/env (`export NOMBRE=valor`, one per line) — the same file company_env.py reads. The key goes in the header, never in argv.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// The server runtime boundary forbids importing @getpaseo/client: the API type comes from the SDK's own context.
type PaseoApi = PluginHandlerContext["paseo"];

const TIMEOUT_MS = 120_000;
const MAX_BYTES = 4 * 1024 * 1024;

const FAILURE_TEXT = {
  "no-session": "this agent has no Claude session",
  "no-transcript": "the session's transcript is not on this machine",
  unreadable: "the session could not be read on this machine",
  router: "the model door (LiteLLM) did not answer",
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

/** The LiteLLM door of this machine: `{ url, token }` from `~/.config/claude-local/env`, `{}` if the file is missing or incomplete
(the same shape `company_env.litellm_env` returns). Read on every call: a rotation lands in the file and is picked up without a reload. */
export async function litellmDoor(): Promise<{ url: string; token: string }> {
  const path = process.env.CLAUDE_LOCAL_ENV || join(homedir(), ".config", "claude-local", "env");
  const text = await readFile(path, "utf8").catch(() => "");
  const value = (key: string) =>
    text
      .split("\n")
      .map((ln) => ln.trim().replace(/^export\s+/, "").split("="))
      .find(([k]) => k === key)?.slice(1).join("=").trim().replace(/^["']|["']$/g, "") ?? "";
  const url = value("ANTHROPIC_BASE_URL");
  const token = value("ANTHROPIC_AUTH_TOKEN");
  return url && token ? { url, token } : { url: "", token: "" };
}

/** The one call to the model door; the status stays the caller's decision. The key travels in the `authorization` header (the house
contract, `company_env.litellm_env`): the door in the env file is https LiteLLM or loopback, and this plugin trusts that file. */
export async function routerRequest(body: string): Promise<{ status: number; text: string }> {
  const { url, token } = await litellmDoor();
  if (!url || !token) throw new SessionError("router");
  const controller = new AbortController(); // AbortSignal.timeout is not in react-native's globals, which the client's types pull in
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${token}` },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text: text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text };
  } catch {
    throw new SessionError("router");
  } finally {
    clearTimeout(timer);
  }
}
