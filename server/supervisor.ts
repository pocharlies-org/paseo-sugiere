// CONTRACT: http.supervisor.autopilot.v1
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const TIMEOUT_MS = 30_000; // under the host's 60 s RPC timeout: the supervisor creates B before answering
const base = () => (process.env.SUPERVISOR_URL || "http://company.paseo.svc.cluster.local:19911").replace(/\/+$/, "");
const secret = () => join(homedir(), ".company", "jira-trigger", "secret");

/** The shared secret, or null when this home has none (then the call would only earn a 401: say it plainly instead). */
function token(): string | null {
  try {
    return readFileSync(secret(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** One call to the supervisor with the shared token. No answer in time is an error, not a silent success. */
async function llamar(ruta: string, cabecera: string): Promise<{ status: number; out: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base()}${ruta}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "X-Company-Token": cabecera },
      signal: controller.signal,
    });
    return { status: response.status, out: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  } finally {
    clearTimeout(timer);
  }
}

/** Why the supervisor refused, in one line: its `{error}` body when it sent one, the status when it did not. */
const motivo = ({ status, out }: { status: number; out: Record<string, unknown> }) =>
  typeof out.error === "string" && out.error ? out.error.slice(0, 200) : `el supervisor respondió ${status}`;

/** The popover's stop button. A pair that is already gone (404) is the state the user asked for: ok. */
export async function apagarPar(agentId: string): Promise<{ ok: boolean; error?: string }> {
  const cabecera = token();
  if (!cabecera) return { ok: false, error: `falta el token del supervisor (${secret()})` };
  try {
    const respuesta = await llamar(`/autopilot/par/${encodeURIComponent(agentId)}`, cabecera);
    return respuesta.status === 200 || respuesta.status === 404 ? { ok: true } : { ok: false, error: motivo(respuesta) };
  } catch (error) {
    return { ok: false, error: `el supervisor no respondió (${(error as Error).message})` };
  }
}
