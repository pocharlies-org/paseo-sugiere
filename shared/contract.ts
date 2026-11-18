import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The autopilot pair of an agent, as the supervisor's registry reports it (`file.autopilot.pares.v1`): `sin-par` when there is
 * no record, `desconocido` when the registry could not be read, and otherwise the Par's estado (activa · pensando · esperando ·
 * humano · degradada · entregada) with its reason, step count, last send, the ticket and the auditor (B's title, or its id).
 * The ✦ paints from this: the plugin no longer pilots anything itself. */
const par = z.object({
  estado: z.string(),
  motivo: z.string(),
  desde: z.string().optional(),
  actualizado: z.string().optional(),
  pasos: z.object({ seguidos: z.number().int(), total: z.number().int() }).optional(),
  ultimo_envio: z.string().optional(),
  auditor: z.string().optional(),
  key: z.string().nullable().optional(),
  modelo: z.string().optional(),
});

/** What the pill of one agent shows: the next-message suggestion, plus the state of the last force — the pill spins on
 * `pending`, shows `error` once, and says «nada que sugerir» on `nada` (the service answered empty on purpose: not a failure,
 * Dani 15-11). With «Garantizar plan» also what it pursues (`en_plan`, the badge) and the criterion, and `muted` after three
 * «no es esto». And the agent's autopilot pair, which paints the ✦ (yellow and turning while the auditor pilots it, red when a
 * person is needed, green when delivered), and the plan the popover can link (`plan`: the anchor's ticket and criterion count). */
const estadoAgente = z.object({
  text: z.string().nullable(),
  pending: z.boolean(),
  error: z.string().nullable(),
  nada: z.boolean(),
  en_plan: z.string().nullable(),
  criterio: z.string().nullable(),
  muted: z.boolean(),
  seguimiento: z.object({ activo: z.boolean(), objetivo: z.string(), motivo: z.string() }).optional(),
  autopilot: par,
  plan: z.object({ key: z.string(), criterios: z.number().int() }).nullable(),
});
export type EstadoAgente = z.infer<typeof estadoAgente>;
/** An agent the server has nothing for: no suggestion, no pair, no plan. Same key order as the server builds, so it compares as JSON. */
export const ESTADO_VACIO: EstadoAgente = {
  text: null,
  pending: false,
  error: null,
  nada: false,
  en_plan: null,
  criterio: null,
  muted: false,
  autopilot: { estado: "sin-par", motivo: "" },
  plan: null,
};

/** The pills' state, pushed and never polled: the server holds the call until some agent's state changes, or the hold
 * expires (empty answer at the same version), and answers only the agents that changed after `since`. `completo` — first call,
 * or a `since` from before the plugin (re)started — brings every agent with something to show; the rest are `ESTADO_VACIO`. */
export const suggestWatch = defineRpc({
  name: "suggest.watch",
  input: z.object({ since: z.number().int() }).strict(),
  output: z.object({ version: z.number().int(), completo: z.boolean(), agentes: z.record(z.string(), estadoAgente) }),
});

export const seguir = defineRpc({
  name: "suggest.seguir",
  input: z.object({ agentId: z.string().min(1).max(64), objetivo: z.string().trim().min(1).max(4000).nullable() }).strict(),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

/** The popover's stop button: `DELETE /autopilot/par/<agentId>` — the supervisor unregisters the pair and archives B. */
export const autopilotStop = defineRpc({
  name: "autopilot.stop",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

export const planLeer = defineRpc({
  name: "plan.leer",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({ objetivo: z.string().nullable() }),
});

/** «no es esto» on an anchored suggestion, or the suggestion was used: three «no es esto» in a row and the ✦ goes quiet. */
export const suggestFeedback = defineRpc({
  name: "suggest.feedback",
  input: z.object({ agentId: z.string().min(1).max(64), verdict: z.enum(["no-es-esto", "usada"]) }).strict(),
  output: z.object({ muted: z.boolean() }),
});

/** Start the suggestion now, without the quiet window: the pill's force click (Dani 19-10). Returns immediately — the answer
 * can outlive the host's RPC timeout — and arrives through `suggest.watch` when the generation settles. */
export const suggestForce = defineRpc({
  name: "suggest.force",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({ started: z.boolean() }),
});
