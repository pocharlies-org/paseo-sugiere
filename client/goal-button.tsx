import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { autopilotGoal } from "../shared/contract.ts";

// «Goal» in each workspace's header (Dani 15-11: «crear un goal en una sesión nueva, básicamente una sesión con
// autopilot en la ventana de Paseo»): the goal, the new session's model and the auditor's. «Empezar» creates the session in this
// workspace already paired with its auditor B, which turns the goal into a plan and writes the session's first message. A header
// button and not a composer pill: a workspace just created has no session yet, and that is exactly when the goal is set.
// shortcut: models come from the `claude` provider, the only one sessions and the auditor use here; list the providers if another appears.
const PROVEEDOR = "claude";
const OPUS = "claude-opus-5-5";
const LINE = 18;

type Modelo = { id: string; label: string };
type Props = PluginButtonContentProps & {
  models: () => Promise<Modelo[]>;
  empezar: (input: { texto: string; sesion: string; modelo?: string }) => Promise<{ ok: boolean; error?: string }>;
};

function GoalPanel({ theme, close, models, empezar }: Props) {
  const [texto, setTexto] = useState("");
  const [modelos, setModelos] = useState<Modelo[]>([]);
  const [sesion, setSesion] = useState<string | null>(null);
  const [auditor, setAuditor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void models().then((ms) => {
      const porDefecto = ms.some((m) => m.id === OPUS) ? OPUS : ms[0]?.id ?? null;
      setModelos(ms);
      setSesion((prev) => prev ?? porDefecto);
      setAuditor((prev) => prev ?? porDefecto);
    }, () => {});
  }, []);
  const opciones = modelos.map((m) => ({ label: m.label, value: m.id }));
  const pedir = () => {
    setBusy(true);
    setError(null);
    void empezar({ texto, sesion: `${PROVEEDOR}/${sesion}`, ...(auditor ? { modelo: auditor } : {}) })
      .then((r) => (r.ok ? close() : setError(r.error ?? "el supervisor no respondió")),
        (e: unknown) => setError(e instanceof Error ? e.message : "el supervisor no respondió"))
      .finally(() => setBusy(false));
  };
  return (
    <View style={{ gap: 4, minWidth: 260, maxWidth: 340 }}>
      <TextInput
        accessibilityLabel="Goal de la sesión nueva"
        multiline
        defaultValue={texto}
        onChangeText={setTexto}
        placeholder="Qué debe conseguir la sesión nueva, con sus criterios"
        style={{ height: LINE * 4, padding: 6, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, color: theme.colors.foreground, fontSize: 13, lineHeight: LINE, outlineWidth: 0, outlineColor: "transparent" }}
      />
      <SettingsSelect
        label="Modelo de la sesión"
        hint="Con el que trabaja la sesión nueva"
        value={sesion ?? ""}
        options={opciones}
        disabled={busy || opciones.length === 0}
        onValueChange={setSesion}
      />
      <SettingsSelect
        label="Modelo del auditor"
        hint="El de la sesión B que la pilota: planifica, audita y escribe su siguiente mensaje; nunca implementa"
        value={auditor ?? ""}
        options={opciones}
        disabled={busy || opciones.length === 0}
        onValueChange={setAuditor}
      />
      <SettingsAction
        label="Sesión con goal"
        hint="Crea la sesión en este workspace con su autopilot encendido"
        actionLabel="Empezar"
        onPress={pedir}
        disabled={busy || !texto.trim() || !sesion}
      />
      {error ? <Text style={{ color: "#ef4444", fontSize: 13, maxWidth: 300 }}>{error}</Text> : null}
    </View>
  );
}

export function addGoalButton(client: PluginClientContext): () => void {
  const botones = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  let release = () => {};
  const models = async (): Promise<Modelo[]> => {
    try {
      const list = await client.paseo.providers.listModels(PROVEEDOR);
      return (list.models ?? []).map((m) => ({ id: m.id, label: m.label ?? m.id }));
    } catch {
      return [];
    }
  };
  const poner = (workspaceId: string) => {
    if (stopped || botones.has(workspaceId)) return;
    const empezar = (input: { texto: string; sesion: string; modelo?: string }) => client.rpc(autopilotGoal, { workspaceId, ...input });
    botones.set(workspaceId, client.addHeaderButton({
      id: "goal",
      workspaceId,
      button: {
        title: "Nueva sesión con goal: nace con su autopilot",
        icon: "Target",
        label: "Goal",
        behavior: { kind: "popover", Content: (props: PluginButtonContentProps) => <GoalPanel {...props} models={models} empezar={empezar} /> },
      },
    }));
  };
  const quitar = (workspaceId: string) => {
    botones.get(workspaceId)?.remove();
    botones.delete(workspaceId);
  };
  void client.paseo.workspaces
    .list({ subscribe: {}, page: { limit: 200 } })
    .then(({ subscription }) => {
      release = () => void subscription.release();
      if (stopped) return release();
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const id of [...botones.keys()]) if (!entries.some((w) => w.id === id)) quitar(id);
          for (const w of entries) poner(w.id);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          if (message.payload.kind === "remove") quitar(message.payload.id);
          else poner(message.payload.workspace.id);
        },
      });
    })
    .catch((error) => {
      if (!stopped) console.error("goal: workspace observation failed", error);
    });
  return () => {
    stopped = true;
    release();
    for (const id of [...botones.keys()]) quitar(id);
  };
}
