import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SuggestSettings } from "./client/suggest-settings.tsx";
import { addSuggestPill } from "./client/suggest-pill.tsx";
import { BadgeFila } from "./client/workspace-badge.tsx";

// The «Goal» header button (a new session born with its autopilot) is gone with 18-11: following a conversation is started
// from its own ✦ with «Seguir en automático», never by launching another session from the header.
// Since 18-11 the sidebar row of each workspace also carries how many of its agents are being piloted, painted from the ✦'s
// own pushed state (client/estado-agentes.ts): one stream, no second watch.
export default function contribute(client: PluginClientContext) {
  const pill = addSuggestPill(client);
  // El badge de fila es de 0.16.2: un cliente anterior se queda con la píldora y sin badge, no sin plugin (Dani 19-11).
  const badge = client.addWorkspaceRowBadgeItem?.({ id: "autopilot", title: "Autopilot en marcha", icon: "Sparkles", Component: BadgeFila }) ?? (() => {});
  const screen = client.addSettingsScreen({ id: "paseo-sugiere", title: "Sugerencia del siguiente mensaje", icon: "Sparkles", Component: SuggestSettings });
  return () => {
    pill();
    badge();
    screen();
  };
}