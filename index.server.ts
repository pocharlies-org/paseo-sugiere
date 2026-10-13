import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { suggestDismiss, suggestGet } from "./shared/contract.ts";
import * as suggest from "./server/suggest.ts";

// The quiet window opens when a turn ends completed and closes with anything new; the answer comes from the resident, never from the session.
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings({
    id: "paseo-sugiere",
    scope: "host",
    version: 1,
    schema: z.object({ enabled: z.boolean() }),
  });
  const apply = (state: { status: string; values?: { enabled?: boolean } }) => suggest.setEnabled(state.status === "ready" ? state.values?.enabled !== false : true);
  settings.subscribe(apply);
  void settings.read().then(apply, () => apply({ status: "invalid" }));
  server.on("agent.turn_ended", ({ agent, outcome }, context) => (outcome.kind === "completed" ? suggest.arm(agent.id, context) : suggest.cancel(agent.id)));
  server.on("agent.turn_started", ({ agent }) => suggest.cancel(agent.id));
  server.handle(suggestGet, (input) => ({ text: suggest.get(input.agentId) }));
  server.handle(suggestDismiss, (input) => (suggest.cancel(input.agentId), {}));
  return () => suggest.dispose();
}
