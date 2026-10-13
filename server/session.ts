// Finding the agent's transcript and whose account it is, and the one call to the local router. Same rules as the account plugin's
// side questions (contract file.claude-cuentas.v1, read-only here): the token of the account is read on every call, never kept, and
// goes only as the bearer of one call to the router on 127.0.0.1; no path of that directory and no token may reach a message.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import * as http from "./http.ts";

const ROUTER = { host: "127.0.0.1", port: 18791 };
const TIMEOUT_MS = 120_000;
const MAX_BYTES = 4 * 1024 * 1024;

const FAILURE_TEXT = {
  "no-session": "this agent has no Claude session",
  "no-transcript": "the session's transcript is not on this machine",
  "no-account": "the session's account is not one of the accounts on this machine",
  unreadable: "the session or its account could not be read on this machine",
  router: "the local router did not answer",
} as const;

export class SessionError extends Error {
  constructor(kind: keyof typeof FAILURE_TEXT) {
    super(FAILURE_TEXT[kind]);
  }
}

/** The transcript of an agent: the Claude providers of Paseo's config, each resuming from its own projects folder. */
export async function locateSession(agentId: string, paseo: PaseoApi): Promise<{ lines: string[]; configDir: string | null }> {
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
      if (found) return { lines: (await readFile(found, "utf8")).split("\n"), configDir: p?.env?.CLAUDE_CONFIG_DIR ?? null };
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

/** The account that owns a transcript: the provider's `CLAUDE_CONFIG_DIR` is the account's `configDir` (contract file.claude-cuentas.v1). */
async function accountOf(configDir: string | null): Promise<string> {
  const dir = process.env.CLAUDE_CUENTAS_DIR || join(homedir(), ".config/claude-cuentas");
  const accounts = JSON.parse(await readFile(join(dir, "accounts.json"), "utf8").catch(() => '{"accounts":[]}'));
  const found = accounts.accounts.find((a: any) => a?.configDir === configDir);
  if (typeof found?.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(found.id)) throw new SessionError("no-account");
  return found.id;
}

async function token(account: string): Promise<string> {
  const dir = process.env.CLAUDE_CUENTAS_DIR || join(homedir(), ".config/claude-cuentas");
  const text = await readFile(join(dir, `${account}.token`), "utf8").catch(() => null);
  if (text === null) throw new SessionError("no-account");
  return text.trim();
}

/** The one call to the local router with the bearer of the account that owns the transcript; the status stays the caller's decision. */
export async function routerRequest(body: string, configDir: string | null): Promise<{ status: number; text: string }> {
  try {
    return await http.send(
      ROUTER,
      "POST",
      "/v1/messages",
      {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${await token(await accountOf(configDir))}`,
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
      TIMEOUT_MS,
      MAX_BYTES,
    );
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw new SessionError("router");
  }
}
