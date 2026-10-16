import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { suggestDismiss, suggestGet, suggestPromptSet } from "../shared/contract.ts";

// One composer pill per agent with the recommendation the resident would give for continuing, after its last turn. The pill
// is invisible while there is nothing to suggest; tapping it opens a card with the full text and two answers: copy it to the
// clipboard to paste and edit in the composer (the SDK has no composer-text API), or send it as the next user message as-is.
// The text lives in the plugin server — this only polls for idle agents, so a suggestion is never asked for while a turn
// is running.
type Agent = { id: string; workspaceId?: string | null; status: string; archivedAt?: string | null };

const POLL_MS = 10_000;

// Neutral host look (SDK: foreground text, muted labels, surface backgrounds, border — no accent fills).
// «Editar prompt» expands the card into the instruction editor. It goes through the plugin's own rpc like the suggestion does:
// neither openSettings navigation (Dani 16-10) nor useSettings (measured 16-10: never resolves in this popover) work here.
function SuggestCard({ text, theme, copy, send, prompt, savePrompt }: PluginButtonContentProps & { text: string; prompt: string; copy: () => void; send: () => void; savePrompt: (prompt: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
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
  const save = () => {
    if (draft !== null && draft !== prompt) savePrompt(draft);
    setDraft(null);
    setEditing(false);
  };
  return (
    <View style={styles.card}>
      {editing ? (
        <>
          <Text style={styles.text}>Prompt de la sugerencia (vacío = el del plugin)</Text>
          <TextInput
            multiline
            defaultValue={prompt}
            onChangeText={setDraft}
            placeholder="(instrucción del plugin)"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
          />
          <View style={styles.row}>
            <Pressable style={styles.button} onPress={save}>
              <Text style={styles.buttonText}>Guardar prompt</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={() => (setDraft(null), setEditing(false))}>
              <Text style={styles.buttonText}>Cancelar</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.text}>{text}</Text>
          <View style={styles.row}>
            <Pressable style={styles.button} onPress={copy}>
              <Text style={styles.buttonText}>Copiar para editar</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={send}>
              <Text style={styles.buttonText}>Enviar</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={() => setEditing(true)}>
              <Text style={styles.buttonText}>Editar prompt</Text>
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
            copy={() =>
              void copyText(text ?? "").then(() => {
                void client.rpc(suggestDismiss, { agentId: agent.id }).catch(() => {});
                texts.delete(agent.id);
                props.close();
              })
            }
            send={() => {
              texts.delete(agent.id);
              void client.paseo.agents.ref(agent.id).send(text ?? "");
              props.close();
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
