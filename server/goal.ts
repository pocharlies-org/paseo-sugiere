// «Goal» in a workspace's header: a new session born with its autopilot, and the start of a pair within the host's RPC
// deadline, shared with the ✦'s «Empezar» (both call the supervisor's `POST /autopilot/par`, which outlasts that deadline).
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { arrancarPar } from "./supervisor.ts";

type Paseo = PluginHandlerContext["paseo"];

// The host cuts a plugin RPC at 30 s (the daemon's plugin runtime, REQUEST_TIMEOUT_MS), and the supervisor creating B alone
// takes ~32 s (measured 15-11), before Goal even adds creating A (~16 s). Past this deadline the RPC answers with the pair
// still starting: the supervisor reserved it as `activa` before creating B, so A's ✦ reads its registry and says how it ends.
const PLAZO_MS = 25_000;

/** `arrancarPar` answered within `plazoMs`: the supervisor's own answer when it comes in time, ok when it does not (its late
 * refusal only reaches the log; the ✦ shows the registry, which drops the reservation if B was not born). */
export async function arrancarEnPlazo(input: Parameters<typeof arrancarPar>[0], paseo: Paseo, plazoMs = PLAZO_MS): Promise<{ ok: boolean; error?: string }> {
  const par = arrancarPar(input, paseo);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([par, new Promise<null>((listo) => { timer = setTimeout(() => listo(null), Math.max(0, plazoMs)); })]);
  clearTimeout(timer);
  if (r) return r;
  void par.then((tarde) => { if (!tarde.ok) console.error(`autopilot: la pareja de ${input.agentId} no arrancó: ${tarde.error}`); });
  return { ok: true };
}

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
  const r = await arrancarEnPlazo({ agentId, modo: "prompt", texto: input.texto, ...(input.modelo ? { modelo: input.modelo } : {}) }, paseo, fin - Date.now());
  return r.ok ? { ok: true, agentId } : { ok: false, agentId, error: `${r.error}. La sesión queda creada: reinténtalo desde su ✦` };
}
