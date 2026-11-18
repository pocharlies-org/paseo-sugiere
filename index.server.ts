import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { seguir, autopilotStop, planLeer, suggestFeedback, suggestForce, suggestWatch, type EstadoAgente } from "./shared/contract.ts";
import { suggestSettings, type SuggestValues } from "./shared/settings.ts";
import { registro, rutaPorDefecto } from "./server/pares.ts";
import { apagarPar } from "./server/supervisor.ts";
import { objetivoDeAgente } from "./server/objetivo.ts";
import * as suggest from "./server/suggest.ts";
import { observa, vigilia } from "./server/vigilia.ts";

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
  // Only a completed turn can advance automatic following.
  server.on("agent.turn_ended", ({ agent, outcome }, context) => {
    if (outcome.kind !== "completed") return suggest.finFallido(agent.id);
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
      seguimiento: suggest.seguimiento(agentId),
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
  server.handle(seguir, (input, context) => suggest.seguir(input.agentId, input.objetivo, context));
  server.handle(autopilotStop, (input) => apagarPar(input.agentId));
  server.handle(planLeer, (input, context) => objetivoDeAgente(input.agentId, context.paseo));
  server.handle(suggestFeedback, (input) => suggest.feedback(input.agentId, input.verdict));
  server.handle(suggestForce, (input, context) => ({ started: suggest.force(input.agentId, context) }));
  return () => {
    suggest.dispose();
    for (const vigilante of vigilantes) vigilante?.close();
    vigia.cierra();
  };
}
