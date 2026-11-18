import type { PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useResumen } from "./estado-agentes.ts";

/** One item on every workspace row of the sidebar: how many of its agents are being piloted right now (a legacy autopilot
 * pair or «Seguir en automático»), red when one of them needs a person. Silent when there is none, so a workspace with
 * nothing under way looks as it always did. */
export function BadgeFila({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
  const { enMarcha, atencion } = useResumen(workspaceId);
  const total = enMarcha + atencion;
  if (!total) return null;
  return (
    <WorkspaceRowBadge
      icon="Sparkles"
      tone={atencion ? "danger" : "info"}
      label={String(total)}
      accessibilityLabel={`${total} en autopilot${atencion ? `, ${atencion} pide a una persona` : ""}`}
    />
  );
}