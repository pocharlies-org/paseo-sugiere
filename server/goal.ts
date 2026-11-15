// «Goal» in a workspace's header: a new session born with its autopilot. The pair starts through the same
// `arrancarPar` as the ✦'s «Empezar»; this module only creates the session it pairs.
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { arrancarPar } from "./supervisor.ts";

type Paseo = PluginHandlerContext["paseo"];

/** A is created idle, without a first prompt — the auditor's first `SIGUIENTE:` is that prompt — and in bypassPermissions like
 * every session here (a permission prompt would stall the pair). If the pair does not start, A is archived: an empty session
 * left behind is only noise. */
export async function sesionConGoal(
  input: { workspaceId: string; texto: string; sesion: string; modelo?: string },
  paseo: Paseo,
): Promise<{ ok: boolean; error?: string; agentId?: string }> {
  let a: Awaited<ReturnType<Paseo["agents"]["create"]>>;
  try {
    a = await paseo.workspaces.ref(input.workspaceId).agents.create({
      config: { provider: input.sesion, modeId: "bypassPermissions" },
      title: input.texto.trim().split("\n")[0]!.slice(0, 60),
    });
  } catch (error) {
    return { ok: false, error: `no se pudo crear la sesión (${(error as Error).message})` };
  }
  const r = await arrancarPar({ agentId: a.id, modo: "prompt", texto: input.texto, ...(input.modelo ? { modelo: input.modelo } : {}) }, paseo);
  if (r.ok) return { ok: true, agentId: a.id };
  await a.archive().catch(() => {});
  return r;
}
