import type { PluginClientContext } from "@getpaseo/plugin/client";
import { suggestDismiss, suggestGet } from "../shared/contract.ts";

// One composer pill per agent with the message the resident suggests after its last turn. The pill is invisible while there
// is nothing to suggest; its menu sends the text as the next user message or throws it away. The text lives in the plugin server —
// this only polls for idle agents, so a suggestion is never asked for while a turn is running.
type Agent = { id: string; workspaceId?: string | null; status: string; archivedAt?: string | null };

const POLL_MS = 10_000;
const LABEL_MAX = 60;

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
      label: text ? `✦ ${text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text}` : "✦",
      visible: text !== null,
      behavior: {
        kind: "menu" as const,
        items: [
          {
            kind: "item" as const,
            id: "send",
            title: text ?? "",
            behavior: {
              kind: "action" as const,
              onPress: () => {
                texts.delete(agent.id);
                void client.paseo.agents.ref(agent.id).send(text ?? "");
              },
            },
          },
          {
            kind: "item" as const,
            id: "dismiss",
            title: "Dismiss",
            behavior: {
              kind: "action" as const,
              onPress: () =>
                void client
                  .rpc(suggestDismiss, { agentId: agent.id })
                  .then(() => texts.set(agent.id, null))
                  .catch(() => {}),
            },
          },
        ],
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
