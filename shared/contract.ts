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

/** The next-message suggestion of an agent, plus the state of the last force: the pill spins on `pending`, shows `error` once,
 * and says «nada que sugerir» on `nada` (the service answered empty on purpose: not a failure, SC-5616).
 * With «Garantizar plan» also what it pursues (`en_plan`, the badge) and the criterion, and `muted` after three «no es esto».
 * And the agent's autopilot pair, which paints the ✦ (yellow and turning while the auditor pilots it, red when a person is
 * needed, green when delivered), and the plan the popover can link (`plan`: the anchor's ticket and criterion count). */
export const suggestGet = defineRpc({
  name: "suggest.get",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({
    text: z.string().nullable(),
    pending: z.boolean(),
    error: z.string().nullable(),
    nada: z.boolean(),
    en_plan: z.string().nullable(),
    criterio: z.string().nullable(),
    muted: z.boolean(),
    autopilot: par,
    plan: z.object({ key: z.string(), criterios: z.number().int() }).nullable(),
  }),
});

/** «Empezar» in the ✦'s popover: the server POSTs `/autopilot/par` to the supervisor (`http.supervisor.autopilot.v1`), which
 * creates the auditor session B and registers the pair. The plugin only asks — with the plan the session is anchored to, or
 * with the prompt the user typed — and the supervisor decides everything else. `texto` is required with `prompt`, ignored
 * with `plan` (the server takes the key from the anchor); `modelo` is the auditor's, from A's provider. */
export const autopilotStart = defineRpc({
  name: "autopilot.start",
  input: z
    .object({
      agentId: z.string().min(1).max(64),
      modo: z.enum(["plan", "prompt"]),
      texto: z.string().trim().max(4000).optional(),
      modelo: z.string().max(120).optional(),
    })
    .strict(),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

/** The popover's stop button: `DELETE /autopilot/par/<agentId>` — the supervisor unregisters the pair and archives B. */
export const autopilotStop = defineRpc({
  name: "autopilot.stop",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

/** «no es esto» on an anchored suggestion, or the suggestion was used: three «no es esto» in a row and the ✦ goes quiet. */
export const suggestFeedback = defineRpc({
  name: "suggest.feedback",
  input: z.object({ agentId: z.string().min(1).max(64), verdict: z.enum(["no-es-esto", "usada"]) }).strict(),
  output: z.object({ muted: z.boolean() }),
});

/** Start the suggestion now, without the quiet window: the pill's force click (Dani 19-10). Returns immediately — the answer
 * can outlive the host's RPC timeout (60 s in @getpaseo/client), so the client polls for it with suggestGet. */
export const suggestForce = defineRpc({
  name: "suggest.force",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({ started: z.boolean() }),
});
