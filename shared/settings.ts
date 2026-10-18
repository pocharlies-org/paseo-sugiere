// The plugin's settings document, shared by the server (which obeys it) and the client screen (which edits it).
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const suggestSettings = defineSettings({
  id: "paseo-sugiere",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean(),
    quietSeconds: z.number().int().min(0).max(600),
  }),
});

export type SuggestValues = { enabled: boolean; quietSeconds: number };
