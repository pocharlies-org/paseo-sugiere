import { spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { autopilotGoal, autopilotStart, autopilotStop, suggestFeedback, suggestForce, suggestGet, suggestWatch, type Respuesta } from "./shared/contract.ts";
import { suggestSettings, type SuggestValues } from "./shared/settings.ts";
import { lectorParejas, rutaParejas, type Estado } from "./server/pares.ts";
import { apagarPar } from "./server/supervisor.ts";
import { arrancarEnPlazo, sesionConGoal } from "./server/goal.ts";
import * as suggest from "./server/suggest.ts";
import { vigia } from "./server/vigia.ts";

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
    }
  };
  settings.subscribe(apply);
  void settings.read().then(apply, () => apply({ status: "invalid" }));
  // The autopilot is not this plugin's loop anymore (auditor session + supervisor, 14-11): a completed turn only arms the
  // suggestion. A failed or canceled turn does nothing either way: the supervisor's RETOMA covers cuts, and an Esc pauses without switching off.
  server.on("agent.turn_ended", ({ agent, outcome }, context) => {
    if (outcome.kind !== "completed") return suggest.cancel(agent.id);
    suggest.arm(agent.id, context);
  });
  server.on("agent.turn_started", ({ agent }) => suggest.cancel(agent.id));
  // The ✦'s autopilot state is the supervisor's pair for this agent, read from the registry. `auditor` starts as B's id; the
  // title comes from the agent list, refreshed at most once a minute and never while answering.
  // SC-5805: the clients hold one `suggest.watch` each, woken by what can change an answer — a suggestion (suggest.ts), the
  // registry the supervisor rewrites in company-0 (inotify sees it: same volume, measured 16-11), a plan anchor, a new title.
  const vigilada = vigia<Respuesta>();
  suggest.alCambiar(vigilada.avisa);
  let titulos: { at: number; map: Map<string, string> } = { at: 0, map: new Map() };
  const titulosDe = (paseo: PluginHandlerContext["paseo"]) => {
    if (Date.now() - titulos.at < 60_000) return;
    titulos.at = Date.now();
    void paseo.agents.list({ page: { limit: 200 } }).then(
      ({ entries }) => {
        titulos = { at: Date.now(), map: new Map(entries.map(({ agent }) => [agent.id, agent.title ?? ""])) };
        vigilada.avisa();
      },
      () => {},
    );
  };
  const respuesta = (agentId: string, pareja: (id: string) => Estado, paseo: PluginHandlerContext["paseo"]): Respuesta => {
    const autopilot = pareja(agentId);
    if (autopilot.auditor) {
      titulosDe(paseo);
      const titulo = titulos.map.get(autopilot.auditor);
      if (titulo) autopilot.auditor = titulo;
    }
    return { text: suggest.get(agentId), ...suggest.state(agentId), ...suggest.anchor(agentId), autopilot, plan: suggest.planAnchor(agentId) };
  };
  server.handle(suggestGet, (input, context) => respuesta(input.agentId, lectorParejas(), context.paseo));
  server.handle(suggestWatch, (input, context) =>
    vigilada.espera(input.agentes, input.since, (agentes) => {
      const pareja = lectorParejas();
      return Object.fromEntries(agentes.map((id) => [id, respuesta(id, pareja, context.paseo)]));
    }));
  const vigilantes: FSWatcher[] = [];
  const vigila = (dir: string, cuenta: (nombre: string) => boolean) => {
    try {
      vigilantes.push(watch(dir, (_evento, nombre) => { if (!nombre || cuenta(String(nombre))) vigilada.avisa(); }));
    } catch (error) {
      // No directory yet: the held call still looks once more when its hold ends, so the change arrives within 20 s.
      console.warn(`suggest: no watch on ${dir}: ${(error as Error).message}`);
    }
  };
  const registro = basename(rutaParejas());
  vigila(dirname(rutaParejas()), (nombre) => nombre.startsWith(registro)); // written as `.tmp` and renamed (os.replace)
  vigila(suggest.ANCHOR_DIR, (nombre) => nombre.startsWith("anchor-"));
  server.handle(autopilotStart, (input, context) => arrancarEnPlazo(input, context.paseo));
  server.handle(autopilotStop, (input) => apagarPar(input.agentId));
  server.handle(autopilotGoal, (input, context) => sesionConGoal(input, context.paseo));
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
    for (const w of vigilantes) w.close();
    vigilada.cierra();
    suggest.dispose();
  };
}
