import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The next-message suggestion of an agent, or null, plus the configured prompt: the pill reads them; `suggest.dismiss` throws one away. */
export const suggestGet = defineRpc({
  name: "suggest.get",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({ text: z.string().nullable(), prompt: z.string() }),
});
/** The instruction the resident gets ("" = the built-in one). It lives in a file the server owns, not in the host settings
document: `useSettings` was measured (16-10) never to resolve inside a composer-pill popover, and the popover is where Dani edits it. */
export const suggestPromptSet = defineRpc({
  name: "suggest.prompt-set",
  input: z.object({ prompt: z.string().max(4000) }).strict(),
  output: z.object({}).strict(),
});
export const suggestDismiss = defineRpc({
  name: "suggest.dismiss",
  input: z.object({ agentId: z.string().min(1).max(64) }).strict(),
  output: z.object({}).strict(),
});
