import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The next-message suggestion of an agent, or null: the pill reads it; `suggest.dismiss` throws one away. */
export const suggestGet = defineRpc({
  name: "suggest.get",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({ text: z.string().nullable() }),
});
export const suggestDismiss = defineRpc({
  name: "suggest.dismiss",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({}).strict(),
});
