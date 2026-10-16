import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { suggestSettings, type SuggestValues } from "../shared/settings.ts";

const QUIET_OPTIONS = [30, 60, 120, 300].map((s) => ({ label: `${s} segundos`, value: String(s) }));

// The plugin's own configuration screen: on/off and the silence window. Values live in the host settings document —
// this screen edits it and the server obeys; nothing is kept here beyond the revision the screen displays.
export function SuggestSettings({ theme }: PluginSurfaceProps) {
  const state = useSettings(suggestSettings);
  if (state.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>Cargando…</Text>;
  if (state.status === "error") return <Text style={{ color: theme.colors.statusDanger }}>No se pudieron leer los ajustes</Text>;
  const values: SuggestValues = state.status === "ready" ? state.values : { enabled: true, quietSeconds: 60 };
  const revision = state.status === "ready" ? state.revision : "0";
  const busy = state.saving;
  const change = (patch: Partial<SuggestValues>) => void state.save({ ...values, ...patch }, revision);
  return (
    <>
      {state.saveError ? <Text style={{ color: theme.colors.statusDanger }}>El host no aceptó el cambio</Text> : null}
      <SettingsSection title="Sugerencia del siguiente mensaje">
        <SettingsCard>
          <SettingsSwitch
            label="Sugerir el siguiente mensaje"
            hint="Al acabar un turno y pasar la sesión en silencio, el residente propone qué enviar a continuación"
            value={values.enabled}
            disabled={busy}
            onValueChange={(enabled) => change({ enabled })}
          />
          <SettingsSelect
            label="Silencio antes de sugerir"
            hint="Cuánto debe estar la sesión sin moverse tras el último turno"
            value={String(values.quietSeconds)}
            options={QUIET_OPTIONS}
            disabled={busy || !values.enabled}
            onValueChange={(quietSeconds) => change({ quietSeconds: Number(quietSeconds) })}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
