import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { suggestDismiss, suggestGet } from "../shared/contract.ts";

// One composer pill per agent with the message the resident suggests after its last turn. The pill is invisible while there
// is nothing to suggest; tapping it opens a dark card with the full text and the two answers: send it as the next user
// message, or throw it away. The text lives in the plugin server — this only polls for idle agents, so a suggestion is
// never asked for while a turn is running.
type Agent = { id: string; workspaceId?: string | null; status: string; archivedAt?: string | null };

const POLL_MS = 10_000;

function SuggestCard({ text, theme, close, send, dismiss }: PluginButtonContentProps & { text: string; send: () => void; dismiss: () => void }) {
  const styles = useMemo(
    () => ({
      card: { gap: 12, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
      text: { color: theme.colors.foreground, fontSize: 14 },
      send: { alignSelf: "flex-start" as const, padding: 10, borderRadius: 8, backgroundColor: theme.colors.accent },
      sendText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
      dismiss: { padding: 6 },
      dismissText: { color: theme.colors.foregroundMuted },
    }),
    [theme],
  );
  return (
    <View style={styles.card}>
      <Text style={styles.text}>{text}</Text>
      <Pressable style={styles.send} onPress={send}>
        <Text style={styles.sendText}>Enviar como siguiente mensaje</Text>
      </Pressable>
      <Pressable style={styles.dismiss} onPress={dismiss}>
        <Text style={styles.dismissText}>Descartar</Text>
      </Pressable>
    </View>
  );
}

export function addSuggestPill(client: PluginClientContext): () => void {
  const agents = new Map<string, Agent>();
  const pills = new Map<string, ReturnType<PluginClientContext["addComposerPill"]>>();
  const texts = new Map<string, string | null>();
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
            send={() => {
              texts.delete(agent.id);
              void client.paseo.agents.ref(agent.id).send(text ?? "");
              props.close();
            }}
            dismiss={() =>
              void client
                .rpc(suggestDismiss, { agentId: agent.id })
                .then(() => texts.delete(agent.id))
                .catch(() => {})
            }
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
        ({ text }) => {
          if (stopped || texts.get(agent.id) === text) return;
          texts.set(agent.id, text);
          show(agent);
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
