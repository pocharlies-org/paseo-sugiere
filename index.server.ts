import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { autopilotGoal, autopilotStart, autopilotStop, suggestFeedback, suggestForce, suggestWatch, type EstadoAgente } from "./shared/contract.ts";
import { suggestSettings, type SuggestValues } from "./shared/settings.ts";
import { registro, rutaPorDefecto } from "./server/pares.ts";
import { apagarPar } from "./server/supervisor.ts";
import { arrancarEnPlazo, sesionConGoal } from "./server/goal.ts";
import * as suggest from "./server/suggest.ts";
import { observa, vigilia } from "./server/vigilia.ts";

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
  // What each pill shows is pushed to the apps: the server marks an agent when its suggestion state changes
  // (suggest.ts), when the supervisor rewrites the pairs registry or paseo-plan an anchor (one inotify watch per directory), and
  // each app's held `suggest.watch` gets only what moved. `auditor` is B's title when its session was found, else its id.
  const rutaPares = rutaPorDefecto();
  let pares = registro(rutaPares);
  const titulos = new Map<string, string>();
  const preguntados = new Set<string>(); // B's title is set when it is created: each id is looked up once
  let paseo: PluginHandlerContext["paseo"] | null = null;
  const lee = (agentId: string): EstadoAgente => {
    const autopilot = pares.de(agentId);
    const titulo = autopilot.auditor ? titulos.get(autopilot.auditor) : undefined;
    return {
      text: suggest.get(agentId),
      ...suggest.state(agentId),
      ...suggest.anchor(agentId),
      autopilot: titulo ? { ...autopilot, auditor: titulo } : autopilot,
      plan: suggest.planAnchor(agentId),
    };
  };
  const vigia = vigilia(lee);
  suggest.alCambiar(vigia.marca);
  const nombraAuditores = () => {
    const nuevos = pares.ids.map((id) => pares.de(id).auditor).filter((b): b is string => !!b && !preguntados.has(b));
    if (!paseo || nuevos.length === 0) return;
    for (const b of nuevos) preguntados.add(b);
    void paseo.agents.list({ page: { limit: 200 } }).then(({ entries }) => {
      for (const { agent } of entries) if (nuevos.includes(agent.id) && agent.title) titulos.set(agent.id, agent.title);
      for (const id of pares.ids) vigia.marca(id);
    }, () => {});
  };
  const releePares = () => {
    const antes = pares.ids;
    pares = registro(rutaPares);
    for (const id of new Set([...antes, ...pares.ids])) vigia.marca(id); // a pair that left the registry goes back to sin-par
    nombraAuditores();
  };
  const anclaDe = (nombre: string | null) => nombre?.match(/^anchor-(.+)\.json$/)?.[1];
  const anclas = (): string[] => {
    try {
      return readdirSync(suggest.ANCHOR_DIR);
    } catch {
      return [];
    }
  };
  for (const id of [...pares.ids, ...anclas().map(anclaDe)]) if (id) vigia.marca(id);
  const vigilantes = [
    observa(dirname(rutaPares), (nombre) => {
      if (nombre === null || nombre === basename(rutaPares)) releePares();
    }),
    observa(suggest.ANCHOR_DIR, (nombre) => {
      const id = anclaDe(nombre);
      if (id) vigia.marca(id);
    }),
  ];
  server.handle(suggestWatch, (input, context) => {
    paseo = context.paseo;
    nombraAuditores();
    return vigia.espera(input.since);
  });
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
    suggest.dispose();
    for (const vigilante of vigilantes) vigilante?.close();
    vigia.cierra();
  };
}
