// The supervisor's autopilot API (contract `http.supervisor.autopilot.v1`): `POST /autopilot/par` starts the pair — the
// supervisor creates the auditor session B and registers it — and `DELETE /autopilot/par/<a_id>` stops it. The plugin only
// asks; it never pilots, sends or archives. Base: the cluster DNS of company-0 (env `SUPERVISOR_URL` to point elsewhere),
// authentication: `X-Company-Token` with the shared secret, the same home in paseo-0 and company-0.
// CONTRACT: http.supervisor.autopilot.v1
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { planAnchor } from "./suggest.ts";

type Paseo = PluginHandlerContext["paseo"];

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
async function llamar(metodo: "POST" | "DELETE", ruta: string, cabecera: string, cuerpo?: object): Promise<{ status: number; out: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base()}${ruta}`, {
      method: metodo,
      headers: { "content-type": "application/json", "X-Company-Token": cabecera },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
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

/** «Empezar» in the popover. The body is the contract's: A with its cwd, workspace and title, the objective (the anchored plan's key,
 * or the prompt the user typed), the auditor's model and `origen: "paseo"`. A 409 (A already paired, A is a B, or the rutador
 * holds A) and a 503 (B could not be created) come back as the supervisor's own reason. */
export async function arrancarPar(
  input: { agentId: string; modo: "plan" | "prompt"; texto?: string; modelo?: string },
  paseo: Paseo,
): Promise<{ ok: boolean; error?: string }> {
  const agent = (await paseo.agents.ref(input.agentId).refresh())?.agent;
  if (!agent) return { ok: false, error: "esta sesión ya no existe en Paseo" };
  const plan = planAnchor(input.agentId);
  if (input.modo === "plan" && !plan) return { ok: false, error: "no hay plan vinculado: elige Prompt" };
  if (input.modo === "prompt" && !input.texto?.trim()) return { ok: false, error: "escribe el objetivo en Prompt" };
  const objetivo = input.modo === "plan" ? { modo: "plan", key: plan!.key } : { modo: "prompt", texto: input.texto!.trim() };
  const cuerpo = {
    // The workspace of A: the supervisor creates the auditor B there, right after A and named after it (Dani, 16-11).
    a: { id: input.agentId, tipo: "paseo", cwd: agent.cwd, workspace: agent.workspaceId, ...(agent.title ? { titulo: agent.title } : {}) },
    objetivo,
    ...(input.modelo ? { modelo: input.modelo } : {}),
    origen: "paseo",
  };
  const cabecera = token();
  if (!cabecera) return { ok: false, error: `falta el token del supervisor (${secret()})` };
  try {
    const respuesta = await llamar("POST", "/autopilot/par", cabecera, cuerpo);
    return respuesta.status === 201 ? { ok: true } : { ok: false, error: motivo(respuesta) };
  } catch (error) {
    return { ok: false, error: `el supervisor no respondió (${(error as Error).message})` };
  }
}

/** The popover's stop button. A pair that is already gone (404) is the state the user asked for: ok. */
export async function apagarPar(agentId: string): Promise<{ ok: boolean; error?: string }> {
  const cabecera = token();
  if (!cabecera) return { ok: false, error: `falta el token del supervisor (${secret()})` };
  try {
    const respuesta = await llamar("DELETE", `/autopilot/par/${agentId}`, cabecera);
    return respuesta.status === 200 || respuesta.status === 404 ? { ok: true } : { ok: false, error: motivo(respuesta) };
  } catch (error) {
    return { ok: false, error: `el supervisor no respondió (${(error as Error).message})` };
  }
}
