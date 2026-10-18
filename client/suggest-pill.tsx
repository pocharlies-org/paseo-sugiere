import type { PluginButtonContentProps, PluginButtonIconProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { suggestGet } from "../shared/contract.ts";
import { insertSuggestion, registerPillAnchor } from "./composer-bridge.ts";

// One composer pill per agent with the recommendation the resident would give for continuing, after its last turn. The pill
// is invisible while there is nothing to suggest; tapping it puts the text in the agent's prompt (composer-bridge.ts, web and
// desktop; Dani 18-10) and, where that cannot be done, opens the text already editable in place, and Enter sends it as the
// next user message (Dani 16-10: «editar» must edit the suggestion in place; 17-10: the two buttons were dead weight — the field
// is the whole card). The instruction the resident gets is not edited here: it is the file the server reads. The text lives in
// the plugin server — this only polls for idle agents, so a suggestion is never asked for while a turn is running.
type Agent = { id: string; workspaceId?: string | null; status: string; archivedAt?: string | null };

const POLL_MS = 10_000;
const LINE = 18; // one row of the field; `rows` is not in the host's react-native types, so the height is set from here

// The popover of the host is already the frame: the card adds no border, no fill and no fixed height — the field grows with the
// text and stops at the width of the popover (Dani 17-10: «la ventana es muy grande, más minimalista»).
// Enter sends: with `blurOnSubmit` on a multiline field react-native-web fires onSubmitEditing on Enter and swallows the newline,
// Shift+Enter still wraps. The card is the field plus one small send button on its right (Dani 18-10: click + Enter was two steps).
// It is the fallback: on mount it first tries the prompt, draws nothing while it decides, and shows up only if the bridge could not.
function SuggestCard({
  text,
  theme,
  close,
  send,
  agentId,
  onInserted,
}: PluginButtonContentProps & { text: string; send: (text: string) => void; agentId: string; onInserted: () => void }) {
  const [inserted, setInserted] = useState<boolean | null>(null); // null while the bridge decides
  useEffect(() => {
    const done = text !== "" && insertSuggestion(agentId, text);
    setInserted(done);
    if (done) {
      close();
      onInserted();
    }
  }, []);
  const [suggestion, setSuggestion] = useState<string | null>(null); // the edited suggestion, null until the user touches the field
  const [height, setHeight] = useState(LINE); // starts at one line; the field grows with its text and never leaves dead space
  const styles = useMemo(
    () => ({
      // outlineWidth 0 + outlineColor transparent: el anillo de foco del host se pinta con `outline`, y así lo apagan también los
      // inputs propios de Paseo (composer, buscar del panel, revisión). Medido 17-10: sin esto, rectángulo verde alrededor (Dani: «cutre»).
      row: { flexDirection: "row" as const, alignItems: "flex-end" as const, gap: 8 },
      input: { flex: 1, padding: 0, color: theme.colors.foreground, fontSize: 13, lineHeight: LINE, outlineWidth: 0, outlineColor: "transparent" },
      send: { width: 20, height: 20, borderRadius: 10, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor: theme.colors.accent },
      arrow: { color: theme.colors.accentForeground, fontSize: 13, lineHeight: 16 },
    }),
    [theme],
  );
  const submit = () => {
    const t = (suggestion ?? text).trim();
    if (t) send(t);
    close();
  };
  if (inserted !== false) return null;
  return (
    <View style={styles.row}>
      <TextInput
        multiline
        blurOnSubmit
        defaultValue={text}
        onChangeText={setSuggestion}
        onContentSizeChange={(event) => setHeight(event.nativeEvent.contentSize.height)}
        onSubmitEditing={submit}
        style={[styles.input, { height }]}
      />
      <Pressable accessibilityLabel="Send" onPress={submit} style={styles.send}>
        <Text style={styles.arrow}>↑</Text>
      </Pressable>
    </View>
  );
}

// The pill's icon is also the anchor of the composer bridge: the popover's content is portaled to body, the icon sits in the pane.
function SuggestIcon(props: PluginButtonIconProps) {
  const node = useRef<View>(null);
  const agentId = props.context === "agent" ? props.agentId : null;
  const { compact } = props.layout;
  useEffect(() => {
    // A compact layout can host the agent in a sheet with no composer of its own, where the climb could meet another agent's.
    if (!agentId || compact || !node.current) return;
    return registerPillAnchor(agentId, node.current as unknown as Element);
  }, [agentId, compact]);
  return (
    <View ref={node}>
      <Icon name="Sparkles" size={props.size} color={props.color} />
    </View>
  );
}

export function addSuggestPill(client: PluginClientContext): () => void {
  const agents = new Map<string, Agent>();
  const pills = new Map<string, ReturnType<PluginClientContext["addComposerPill"]>>();
  const texts = new Map<string, string | null>();
  const consumed = new Map<string, string>(); // the suggestion already put in the prompt: the poll must not bring it back until the next turn
  let stopped = false;
  const lifetime = new AbortController();

  const remove = (id: string) => {
    pills.get(id)?.remove();
    pills.delete(id);
    agents.delete(id);
    texts.delete(id);
    consumed.delete(id);
  };
  const show = (agent: Agent) => {
    if (stopped) return;
    if (!agent.workspaceId || agent.archivedAt) return remove(agent.id);
    agents.set(agent.id, agent);
    if (agent.status !== "idle") {
      texts.delete(agent.id); // a returning idle must not resurrect the previous suggestion
      consumed.delete(agent.id);
    }
    const text = agent.status === "idle" ? (texts.get(agent.id) ?? null) : null;
    const pill = pills.get(agent.id);
    const button = {
      title: "Suggested next message",
      icon: SuggestIcon,
      label: text ? `✦ ${text}` : "✦",
      visible: text !== null,
      behavior: {
        kind: "popover" as const,
        Content: (props: PluginButtonContentProps) => (
          <SuggestCard
            {...props}
            text={text ?? ""}
            agentId={agent.id}
            onInserted={() => {
              consumed.set(agent.id, text ?? "");
              texts.set(agent.id, null);
              show(agents.get(agent.id) ?? agent); // hides the pill
            }}
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
          const shown = text === consumed.get(agent.id) ? null : text;
          const changed = texts.get(agent.id) !== shown;
          texts.set(agent.id, shown);
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
