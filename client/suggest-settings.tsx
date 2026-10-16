import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, TextInput } from "react-native";
import { suggestSettings, type SuggestValues } from "../shared/settings.ts";

const QUIET_OPTIONS = [30, 60, 120, 300].map((s) => ({ label: `${s} segundos`, value: String(s) }));

// The plugin's own configuration screen: on/off, the silence window and the instruction the resident gets (empty = the built-in
// one). Values live in the host settings document — this screen edits it and the server obeys; the prompt keeps a local draft
// so a long text is saved with «Guardar», not on every keystroke.
export function SuggestSettings({ theme }: PluginSurfaceProps) {
  const state = useSettings(suggestSettings);
  const [draft, setDraft] = useState<string | null>(null);
  if (state.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>Cargando…</Text>;
  if (state.status === "error") return <Text style={{ color: theme.colors.statusDanger }}>No se pudieron leer los ajustes</Text>;
  const values: SuggestValues = state.status === "ready" ? state.values : { enabled: true, quietSeconds: 60, prompt: "" };
  const revision = state.status === "ready" ? state.revision : "0";
  const busy = state.saving;
  const change = (patch: Partial<SuggestValues>) => void state.save({ ...values, ...patch }, revision);
  const prompt = draft ?? values.prompt;
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
          <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>Prompt de la sugerencia</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            La instrucción que recibe el residente. Vacío = la del plugin. Se aplica a partir de la siguiente sugerencia.
          </Text>
          <TextInput
            multiline
            value={prompt}
            onChangeText={setDraft}
            editable={!busy}
            placeholder="(instrucción del plugin)"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              minHeight: 140,
              padding: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
              color: theme.colors.foreground,
              fontSize: 13,
              textAlignVertical: "top",
            }}
          />
          <Pressable
            disabled={busy || draft === null || draft === values.prompt}
            onPress={() => {
              change({ prompt });
              setDraft(null);
            }}
            style={{ alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2, opacity: busy || draft === null || draft === values.prompt ? 0.5 : 1 }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>Guardar prompt</Text>
          </Pressable>
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
