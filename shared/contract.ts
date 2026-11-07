import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The next-message suggestion of an agent, plus the state of the last force: the pill spins on `pending` and shows `error` once.
 * With «Garantizar plan» also what it pursues (`en_plan`, the badge) and the criterion, and `muted` after three «no es esto». */
export const suggestGet = defineRpc({
  name: "suggest.get",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({
    text: z.string().nullable(),
    pending: z.boolean(),
    error: z.string().nullable(),
    en_plan: z.string().nullable(),
    criterio: z.string().nullable(),
    muted: z.boolean(),
  }),
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
