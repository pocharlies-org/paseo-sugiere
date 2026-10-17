import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { TextInput } from "react-native";
import { suggestGet } from "../shared/contract.ts";

// One composer pill per agent with the recommendation the resident would give for continuing, after its last turn. The pill
// is invisible while there is nothing to suggest; tapping it opens the text already editable in place, and Enter sends it as the
// next user message (Dani 16-10: «editar» must edit the suggestion in place; 17-10: the two buttons were dead weight — the field
// is the whole card). The instruction the resident gets is not edited here: it is the file the server reads. The text lives in
// the plugin server — this only polls for idle agents, so a suggestion is never asked for while a turn is running.
type Agent = { id: string; workspaceId?: string | null; status: string; archivedAt?: string | null };

const POLL_MS = 10_000;

// The popover of the host is already the frame: the card adds no border, no fill and no fixed height — the field grows with the
// text and stops at the width of the popover (Dani 17-10: «la ventana es muy grande, más minimalista»).
// Enter sends: with `blurOnSubmit` on a multiline field react-native-web fires onSubmitEditing on Enter and swallows the newline,
// Shift+Enter still wraps. The card is the field — no buttons (Dani 17-10).
function SuggestCard({ text, theme, close, send }: PluginButtonContentProps & { text: string; send: (text: string) => void }) {
  const [suggestion, setSuggestion] = useState<string | null>(null); // the edited suggestion, null until the user touches the field
  const [height, setHeight] = useState<number>(); // the field is as tall as its text: one line for a short suggestion, no dead space
  const styles = useMemo(
    () => ({
      input: { padding: 0, color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
    }),
    [theme],
  );
  return (
    <TextInput
      multiline
      rows={1}
      blurOnSubmit
      defaultValue={text}
      onChangeText={setSuggestion}
      onContentSizeChange={(event) => setHeight(event.nativeEvent.contentSize.height)}
      onSubmitEditing={() => {
        const t = (suggestion ?? text).trim();
        if (t) send(t);
        close();
      }}
      style={[styles.input, height ? { height } : undefined]}
    />
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
            send={(t) => {
              texts.delete(agent.id);
              void client.paseo.agents.ref(agent.id).send(t);
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
        ({ text }) => {
          if (stopped) return;
          const changed = texts.get(agent.id) !== text;
          texts.set(agent.id, text);
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
