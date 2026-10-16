import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { suggestGet, suggestPromptSet } from "../shared/contract.ts";

// One composer pill per agent with the recommendation the resident would give for continuing, after its last turn. The pill
// is invisible while there is nothing to suggest; tapping it opens a card with the text already editable in place (Dani 16-10:
// «editar» must edit the suggestion, not open another screen) and two answers: send what is in the field as the next user
// message, or open the instruction the resident gets. The text lives in the plugin server — this only polls for idle agents,
// so a suggestion is never asked for while a turn is running.
type Agent = { id: string; workspaceId?: string | null; status: string; archivedAt?: string | null };

const POLL_MS = 10_000;

// Neutral host look (SDK: foreground text, muted labels, surface backgrounds, border — no accent fills).
// The instruction editor goes through the plugin's own rpc like the suggestion does: neither openSettings navigation
// (Dani 16-10) nor useSettings (measured 16-10: never resolves in this popover) work here.
function SuggestCard({ text, theme, close, send, prompt, savePrompt }: PluginButtonContentProps & { text: string; prompt: string; send: (text: string) => void; savePrompt: (prompt: string) => void }) {
  const [editingInstr, setEditingInstr] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null); // the edited suggestion, "" until the user touches the field
  const [instrDraft, setInstrDraft] = useState<string | null>(null);
  const styles = useMemo(
    () => ({
      card: { gap: 12, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, maxWidth: 420 },
      text: { color: theme.colors.foreground, fontSize: 14 },
      row: { flexDirection: "row" as const, gap: 8 },
      button: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 },
      buttonText: { color: theme.colors.foreground, fontSize: 13 },
      input: { minHeight: 120, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2, color: theme.colors.foreground, fontSize: 13, textAlignVertical: "top" as const },
    }),
    [theme],
  );
  const value = suggestion ?? text;
  return (
    <View style={styles.card}>
      {editingInstr ? (
        <>
          <Text style={styles.text}>Instrucción del plugin (vacío = la del plugin)</Text>
          <TextInput
            multiline
            defaultValue={prompt}
            onChangeText={setInstrDraft}
            placeholder="(instrucción del plugin)"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
          />
          <View style={styles.row}>
            <Pressable
              style={styles.button}
              onPress={() => {
                if (instrDraft !== null && instrDraft !== prompt) savePrompt(instrDraft);
                setInstrDraft(null);
                setEditingInstr(false);
              }}
            >
              <Text style={styles.buttonText}>Guardar instrucción</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={() => (setInstrDraft(null), setEditingInstr(false))}>
              <Text style={styles.buttonText}>Cancelar</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <TextInput multiline defaultValue={text} onChangeText={setSuggestion} style={styles.input} />
          <View style={styles.row}>
            <Pressable
              style={styles.button}
              onPress={() => {
                const t = value.trim();
                if (t) send(t);
                close();
              }}
            >
              <Text style={styles.buttonText}>Enviar</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={() => setEditingInstr(true)}>
              <Text style={styles.buttonText}>Editar instrucción del plugin</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

export function addSuggestPill(client: PluginClientContext): () => void {
  const agents = new Map<string, Agent>();
  const pills = new Map<string, ReturnType<PluginClientContext["addComposerPill"]>>();
  const texts = new Map<string, string | null>();
  let promptCache = ""; // the configured instruction, global to the plugin; refreshed with every poll and kept in step on save
  let stopped = false;
  const lifetime = new AbortController();

  const remove = (id: string) => {
    pills.get(id)?.remove();
    pills.delete(id);
    agents.delete(id);
    texts.delete(id);
  };
  const show = (agent: Agent) => {
    if (stopped) return;
    if (!agent.workspaceId || agent.archivedAt) return remove(agent.id);
    agents.set(agent.id, agent);
    if (agent.status !== "idle") texts.delete(agent.id); // a returning idle must not resurrect the previous suggestion
    const text = agent.status === "idle" ? (texts.get(agent.id) ?? null) : null;
    const pill = pills.get(agent.id);
    const button = {
      title: "Suggested next message",
      icon: "Sparkles",
      label: text ? `✦ ${text}` : "✦",
      visible: text !== null,
      behavior: {
        kind: "popover" as const,
        Content: (props: PluginButtonContentProps) => (
          <SuggestCard
            {...props}
            text={text ?? ""}
            send={(t) => {
              texts.delete(agent.id);
              void client.paseo.agents.ref(agent.id).send(t);
            }}
            prompt={promptCache}
            savePrompt={(prompt) => {
              promptCache = prompt;
              void client.rpc(suggestPromptSet, { prompt }).catch(() => {});
            }}
          />
        ),
      },
    };
    if (pill) pill.update(button);
    else pills.set(agent.id, client.addComposerPill({ id: "suggest", workspaceId: agent.workspaceId, agentId: agent.id, button }));
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const id of [...pills.keys()]) remove(id);
          for (const { agent } of entries) show(agent as Agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else show(update.agent as Agent);
        },
      });
    })
    .catch((error) => {
      if (!stopped) console.error("suggest: agent observation failed", error);
    });
  const poll = setInterval(() => {
    for (const agent of agents.values()) {
      if (agent.status !== "idle") continue;
      void client.rpc(suggestGet, { agentId: agent.id }).then(
        ({ text, prompt }) => {
          if (stopped) return;
          const changed = texts.get(agent.id) !== text;
          texts.set(agent.id, text);
          promptCache = prompt;
          if (changed) show(agent);
        },
        () => {},
      );
    }
  }, POLL_MS);

  return () => {
    stopped = true;
    lifetime.abort();
    clearInterval(poll);
    for (const id of [...pills.keys()]) remove(id);
  };
}
