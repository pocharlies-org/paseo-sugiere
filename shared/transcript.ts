// The Claude Code transcript read as plain messages: the same flattening the side questions of the account plugin use — a tool call
// becomes one line about it, its result becomes its text, thinking is dropped. Pure: strings in, messages out, no Node.

export type Block = { type: "text"; text: string };
export type Message = { role: "user" | "assistant"; content: Block[] };

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) out.push({ type: "text", text: part.text });
    else if (part?.type === "tool_use" && typeof part.name === "string") out.push({ type: "text", text: `[called ${part.name}]` });
    else if (part?.type === "tool_result") {
      const text =
        typeof part.content === "string"
          ? part.content
          : Array.isArray(part.content)
            ? part.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("")
            : "";
      if (text.trim()) out.push({ type: "text", text: `[tool result] ${text.slice(0, 2_000)}` });
    }
    // thinking and redacted_thinking are dropped: they are signed for the model that wrote them and this call has no tools.
  }
  return out;
}

/** The messages of the transcript since its last compaction, and the last real model the session used (null if none: no assistant yet, or only synthetic ones). */
export function transcriptMessages(lines: string[]): { messages: Message[]; model: string | null } {
  const start = lines.findLastIndex((l) => l.includes('"compact_boundary"')) + 1;
  const messages: Message[] = [];
  let model: string | null = null;
  for (const line of lines.slice(start)) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line cut by a write in progress
    }
    const role = entry?.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = blocks(entry.message.content);
    if (!content.length) continue;
    // "<synthetic>" is what Claude Code writes on messages it made up itself (errors, interruptions): not a model anyone can call.
    const used = entry.message.model;
    if (role === "assistant" && typeof used === "string" && used.trim() && used !== "<synthetic>") model = used;
    const last = messages[messages.length - 1];
    if (last?.role === role) last.content.push(...content);
    else messages.push({ role, content });
  }
  return { messages: cap(messages), model };
}

/**
 * The most it may cost to answer: ~100k tokens, so it fits a 200k window with room for the answer. The newest messages are kept and
 * the answer is told what was left out. shortcut: one number for every model; upgrade if a smaller window needs its own.
 */
export const MAX_CONTEXT_CHARS = 400_000;

function cap(messages: Message[]): Message[] {
  const size = (ms: Message[]) => ms.reduce((n, m) => n + m.content.reduce((k, b) => k + b.text.length, 0), 0);
  let dropped = 0;
  while (messages.length > 1 && size(messages) > MAX_CONTEXT_CHARS) {
    const [oldest, ...rest] = messages as [Message, ...Message[]];
    messages = rest;
    dropped += oldest.content.length;
  }
  if (dropped) messages.unshift({ role: "user", content: [{ type: "text", text: `[${dropped} earlier messages left out]` }] });
  return messages;
}
