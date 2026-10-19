import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The next-message suggestion of an agent, or null: the pill reads it. */
export const suggestGet = defineRpc({
  name: "suggest.get",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({ text: z.string().nullable() }),
});

/** Start the suggestion now, without the quiet window: the pill's force click (Dani 19-10). Returns immediately — the answer
 * can outlive the host's RPC timeout (60 s in @getpaseo/client), so the client polls for it with suggestGet. */
export const suggestForce = defineRpc({
  name: "suggest.force",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({ started: z.boolean() }),
});
