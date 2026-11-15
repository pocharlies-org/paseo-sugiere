// The plugin's settings document, shared by the server (which obeys it) and the client screen (which edits it).
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const suggestSettings = defineSettings({
  id: "paseo-sugiere",
  scope: "host",
  version: 1,
  // Defaults are load-bearing: with no document stored the host parses `{}`, and a required field would make the read
  // `invalid` — the screen then sends revision "0" while the store holds "missing" and the first save always conflicts.
  schema: z.object({
    enabled: z.boolean().default(true),
    // Auto is off by default (Dani 25-10): every automatic suggestion re-sends the whole transcript of its session (~100k tokens
    // measured 173 calls in one day). With auto off the ✦ stays in the composer and suggests only when the user clicks it.
    auto: z.boolean().default(false),
    quietSeconds: z.number().int().min(0).max(600).default(60),
  }),
});

export type SuggestValues = { enabled: boolean; auto: boolean; quietSeconds: number };
