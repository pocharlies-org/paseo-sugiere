// «Goal» in a workspace's header: a new session born with its autopilot. The pair starts through the same
// `arrancarPar` as the ✦'s «Empezar»; this module only creates the session it pairs.
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { arrancarPar } from "./supervisor.ts";

type Paseo = PluginHandlerContext["paseo"];

// The host cuts a plugin RPC at 30 s (the daemon's plugin runtime, REQUEST_TIMEOUT_MS), and creating A (~16 s) plus the
// supervisor creating B (~32 s, both measured 15-11) does not fit. Past this deadline the RPC answers with A created and the
// pair still starting: A's ✦ reads the supervisor's registry and says how it ends.
const PLAZO_MS = 25_000;

/** A is created idle, without a first prompt — the auditor's first `SIGUIENTE:` is that prompt — and in bypassPermissions like
 * every session here (a permission prompt would stall the pair). A is never archived here: an answer that did not arrive is
 * not a refusal (15-11, live: archiving on the supervisor's timeout left B piloting an archived A). On a real refusal A stays,
 * and its ✦ can start the pair again. */
export async function sesionConGoal(
  input: { workspaceId: string; texto: string; sesion: string; modelo?: string },
  paseo: Paseo,
  plazoMs = PLAZO_MS,
): Promise<{ ok: boolean; error?: string; agentId?: string }> {
  const fin = Date.now() + plazoMs;
  let agentId: string;
  try {
    ({ id: agentId } = await paseo.workspaces.ref(input.workspaceId).agents.create({
      config: { provider: input.sesion, modeId: "bypassPermissions" },
      title: input.texto.trim().split("\n")[0]!.slice(0, 60),
    }));
  } catch (error) {
    return { ok: false, error: `no se pudo crear la sesión (${(error as Error).message})` };
  }
  const par = arrancarPar({ agentId, modo: "prompt", texto: input.texto, ...(input.modelo ? { modelo: input.modelo } : {}) }, paseo);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([par, new Promise<null>((listo) => { timer = setTimeout(() => listo(null), Math.max(0, fin - Date.now())); })]);
  clearTimeout(timer);
  if (!r) {
    void par.then((tarde) => { if (!tarde.ok) console.error(`goal: la pareja de ${agentId} no arrancó: ${tarde.error}`); });
    return { ok: true, agentId };
  }
  return r.ok ? { ok: true, agentId } : { ok: false, agentId, error: `${r.error}. La sesión queda creada: reinténtalo desde su ✦` };
}
