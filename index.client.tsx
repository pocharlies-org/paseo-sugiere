import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SuggestSettings } from "./client/suggest-settings.tsx";
import { addSuggestPill } from "./client/suggest-pill.tsx";

// The «Goal» header button (a new session born with its autopilot) is gone with 18-11: following a conversation is started
// from its own ✦ with «Seguir en automático», never by launching another session from the header.
export default function contribute(client: PluginClientContext) {
  const pill = addSuggestPill(client);
  const screen = client.addSettingsScreen({ id: "paseo-sugiere", title: "Sugerencia del siguiente mensaje", icon: "Sparkles", Component: SuggestSettings });
  return () => {
    pill();
    screen();
  };
}
