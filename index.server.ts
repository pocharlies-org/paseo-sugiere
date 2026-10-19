import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { suggestForce, suggestGet } from "./shared/contract.ts";
import { suggestSettings, type SuggestValues } from "./shared/settings.ts";
import * as suggest from "./server/suggest.ts";

// What is merged to trunk is what runs: the plugin checks GitHub every 5 min and, on a new commit, deploys that tree and reloads
// itself (scripts/autodeploy.sh — no clone, no credentials, nothing to remember after a merge). The path is the install layout that
// scripts/deploy.sh creates, not `import.meta.url`: the host loads the server without a usable module URL (medido 17-10: «Invalid
// URL» at load, the plugin came down).
const AUTODEPLOY = join(homedir(), ".local", "share", "paseo-sugiere", "paseo-plugin", "current", "scripts", "autodeploy.sh");

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
  server.handle(suggestGet, (input) => ({ text: suggest.get(input.agentId), ...suggest.state(input.agentId) }));
  server.handle(suggestForce, (input, context) => ({ started: suggest.force(input.agentId, context) }));
  const check = () => spawn("bash", [AUTODEPLOY], { detached: true, stdio: "ignore" }).unref();
  let autodeploy: ReturnType<typeof setInterval> | undefined;
  if (existsSync(AUTODEPLOY)) {
    check(); // a merge that landed while the host was down is picked up on start
    autodeploy = setInterval(check, 5 * 60_000);
  } else console.warn(`suggest: no autodeploy script at ${AUTODEPLOY}`);
  return () => {
    if (autodeploy) clearInterval(autodeploy);
    suggest.dispose();
  };
}
