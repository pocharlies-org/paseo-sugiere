import type { PluginServerContext } from "@getpaseo/plugin/server";
import { suggestGet } from "./shared/contract.ts";
import { suggestSettings, type SuggestValues } from "./shared/settings.ts";
import * as suggest from "./server/suggest.ts";

// The quiet window opens when a turn ends completed and closes with anything new; the answer comes from the resident, never from the session.
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(suggestSettings);
  const apply = (state: { status: string; values?: SuggestValues }) => {
    suggest.setEnabled(state.status === "ready" ? state.values?.enabled !== false : true);
    if (state.status === "ready" && state.values) suggest.setQuietSeconds(state.values.quietSeconds);
  };
  settings.subscribe(apply);
  void settings.read().then(apply, () => apply({ status: "invalid" }));
  server.on("agent.turn_ended", ({ agent, outcome }, context) => (outcome.kind === "completed" ? suggest.arm(agent.id, context) : suggest.cancel(agent.id)));
  server.on("agent.turn_started", ({ agent }) => suggest.cancel(agent.id));
  server.handle(suggestGet, (input) => ({ text: suggest.get(input.agentId) }));
  return () => suggest.dispose();
}
