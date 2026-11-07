import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { autopilotSet, suggestFeedback, suggestForce, suggestGet } from "./shared/contract.ts";
import { suggestSettings, type SuggestValues } from "./shared/settings.ts";
import * as autopilot from "./server/autopilot.ts";
import * as suggest from "./server/suggest.ts";

// What is merged to trunk is what runs: the plugin checks GitHub every 5 min and, on a new commit, deploys that tree and reloads
// itself (scripts/autodeploy.sh — no clone, no credentials, nothing to remember after a merge). The path is the install layout that
// scripts/deploy.sh creates, not `import.meta.url`: the host loads the server without a usable module URL (medido 17-10: «Invalid
// URL» at load, the plugin came down).
const AUTODEPLOY = join(homedir(), ".local", "share", "paseo-sugiere", "paseo-plugin", "current", "scripts", "autodeploy.sh");

// The quiet window opens when a turn ends completed and closes with anything new; the answer comes from a separate call with the session's model, never from the session itself.
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(suggestSettings);
  const apply = (state: { status: string; values?: SuggestValues }) => {
    suggest.setEnabled(state.status === "ready" ? state.values?.enabled !== false : true);
    if (state.status === "ready" && state.values) {
      suggest.setAuto(state.values.auto);
      suggest.setQuietSeconds(state.values.quietSeconds);
      autopilot.setTopes(state.values.autopilotMaxSeguidos, state.values.autopilotMaxTotal);
    }
  };
  settings.subscribe(apply);
  void settings.read().then(apply, () => apply({ status: "invalid" }));
  // With the autopilot on, the turn's one generation is the autopilot's: no suggestion is armed (and no race for the native file).
  // A failed or canceled turn does nothing either way: the supervisor's RETOMA covers cuts, and an Esc pauses without switching off.
  server.on("agent.turn_ended", ({ agent, turnId, outcome }, context) => {
    void autopilot.resume(context.paseo);
    if (outcome.kind !== "completed") return suggest.cancel(agent.id);
    if (autopilot.on(agent.id)) return void autopilot.decide(agent.id, agent.cwd, context.paseo, turnId);
    suggest.arm(agent.id, context);
  });
  server.on("agent.turn_started", ({ agent }) => {
    suggest.cancel(agent.id);
    autopilot.turnStarted(agent.id);
  });
  server.handle(suggestGet, (input, context) => {
    void autopilot.resume(context.paseo);
    return { text: suggest.get(input.agentId), ...suggest.state(input.agentId), ...suggest.anchor(input.agentId), autopilot: autopilot.get(input.agentId) };
  });
  server.handle(autopilotSet, (input, context) => autopilot.set(input.agentId, input.on, context.paseo));
  server.handle(suggestFeedback, (input) => suggest.feedback(input.agentId, input.verdict));
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
