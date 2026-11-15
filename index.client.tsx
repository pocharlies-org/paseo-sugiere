import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SuggestSettings } from "./client/suggest-settings.tsx";
import { addSuggestPill } from "./client/suggest-pill.tsx";
import { addGoalButton } from "./client/goal-button.tsx";

export default function contribute(client: PluginClientContext) {
  const pill = addSuggestPill(client);
  const goal = addGoalButton(client);
  const screen = client.addSettingsScreen({ id: "paseo-sugiere", title: "Sugerencia del siguiente mensaje", icon: "Sparkles", Component: SuggestSettings });
  return () => {
    pill();
    goal();
    screen();
  };
}
