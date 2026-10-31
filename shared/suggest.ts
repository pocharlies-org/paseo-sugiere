// The next-message suggestion: one small call with the session's transcript and an instruction (built-in, or the user's from
// settings), answered by the SAME model the session is running (Dani 22-10), not a fixed one. A session with no real model yet gets no call.
// The instruction rides in `system` — as the last user turn the model answered the conversation instead of suggesting (measured
// 13-10). System is fixed and the transcript only grows, so consecutive suggestions of a session keep a stable token prefix.
// Cost: every suggestion sends the whole conversation (up to ~100k tokens) to the session's model and does not share the session's own cache.
import { transcriptMessages } from "./transcript.ts";

/** The suggestion has no length cap (Dani 31-10: «puede ser lo más largo que quieras»), so this is a real budget: thinking is off
below (`reasoning_effort`), but gpt models answer with `minimal`, which still thinks. 22-10 raised 48 to 256 because the thinking ate
it (measured: alibaba and the resident returned only a thinking block, no text: «respuesta vacía», Dani 25-10); 31-10 raised it to 512. */
export const SUGGEST_MAX_TOKENS = 512;

/** Fixed. Dani 14-10: the pill recommends the next step toward the task's GOAL — the model was continuing the assistant's last
turn instead of recommending (measured: «PR #14 en vigilancia…» came out). Sendable rule kept: if what comes next is the user's
in the real world (measure, buy, approve, pay), there is no suggestion (measured 14-10: «mide la longitud del cañón»). */
export const SUGGESTION_INSTRUCTION = `Tarea: esta conversación tiene una tarea en curso con un objetivo: lo que el usuario pidió al principio. Escribe el siguiente paso que el usuario debería pedir para avanzar hacia ese objetivo.
Reglas:
- El último turno del asistente está TERMINADO: no lo continúes, no lo resumas, no lo repitas. La recomendación es un paso NUEVO.
- Ten en cuenta lo ya hecho y lo que queda: recomienda el paso siguiente que acerca al objetivo (algo prometido y no terminado, una corrección pedida, el siguiente paso natural).
- En castellano, sin comillas ni prefijos, sin tope de longitud (Dani 31-10: no hace falta que sea súper corta).
- Voz del asistente aconsejando, en imperativo («ejecuta los tests antes del merge», «arregla el parseo que falló»).
- La recomendación tiene que poder enviarse tal cual al asistente para que ÉL la ejecute en esta sesión. Nunca un paso que haga el usuario fuera de la conversación (medir algo físico, comprar, llamar, aprobar, pagar).
- NUNCA una pregunta dirigida al usuario («¿quieres que...?»).
- Si el trabajo está terminado, si lo que falta es acción o decisión del usuario, o si la conversación ha parado de verdad: responde una línea vacía.
Responde únicamente la recomendación. Si no hay nada que recomendar, tu respuesta es la línea vacía.`;

/** The conversation proper: tool calls and tool results stripped. Measured 14-10 — with them the tail of a working session is
"[called Bash]" / "[tool result] …" and the small model mimics the last marker instead of recommending; without them it sees
what the user asked and what the assistant answered, which is all a next-step recommendation needs. */
function conversation(messages: { role: "user" | "assistant"; content: { type: "text"; text: string }[] }[]) {
  return messages
    .map((m) => ({ role: m.role, content: m.content.filter((b) => !/^\[(called|tool result)/.test(b.text)) }))
    .filter((m) => m.content.length);
}

/** Constant last user turn: without it the call ends with the assistant and the small model CONTINUES that turn instead of
recommending (measured 14-10: «PR #14 en vigilancia…»); with it, it answers. Constant, so the cached prefix of the session holds. */
const TRIGGER = "¿Qué debería pedirle a continuación al asistente? Responde solo con la recomendación.";

/** LiteLLM serves `claude-*` through Claude subscription accounts, and those answer 429 rate_limit_error "Error" to any request whose
system does not start with this line (measured 22-10: `system` as a plain string -> 429, the same call with this block first -> 200).
Fixed and always first, so the prefix of the session's calls stays stable. Sent for every model: the session's model comes from a
Claude Code transcript, so it is `claude-*` in practice, and the line is harmless to any other. */
export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

/** The whole call: the session's own model, and the body — the conversation (no tool noise), the instruction in `system` after the
Claude Code line (the configured one, or the built-in when it is empty), the constant trigger last, no tools. Null when the session has no real model
(no assistant message yet, or only `<synthetic>` ones): there is nothing to call and no fallback model (Dani 22-10). */
export function suggestBody(lines: string[], prompt = ""): { model: string; body: string } | null {
  const { messages, model } = transcriptMessages(lines);
  if (!model) return null;
  const body = JSON.stringify({
    model,
    max_tokens: SUGGEST_MAX_TOKENS,
    // LiteLLM translates this to `enable_thinking: false` for any alias (manifest, correo-clasificador note 22-10). Without it every
    // session on a thinking model gets a thinking block instead of a suggestion: the answer arrives empty. The ChatGPT backend rejects
    // `none` on the gpt models (measured 31-10: 400 «Unsupported value: 'none' is not supported with the 'gpt-6-astra' model»); `minimal` is the lowest it takes.
    reasoning_effort: model.startsWith("gpt-") ? "minimal" : "none",
    tools: [],
    system: [
      { type: "text", text: CLAUDE_CODE_SYSTEM },
      { type: "text", text: prompt.trim() || SUGGESTION_INSTRUCTION },
    ],
    messages: [...conversation(messages), { role: "user", content: [{ type: "text", text: TRIGGER }] }],
  });
  return { model, body };
}

/** The one sendable recommendation, or "" for nothing to suggest: the non-empty lines joined (the answer has no length cap since
Dani 31-10), quotes trimmed, and an answer that merely echoes the assistant's last line (the measured misfire of the model) dropped too. */
export function suggestionAnswer(response: unknown, lastAssistant = ""): string {
  const parts = Array.isArray((response as { content?: unknown })?.content) ? ((response as { content: unknown[] }).content as any[]) : [];
  const text = parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
  const line = text.split("\n").map((l) => l.trim()).filter((l) => l !== "").join(" ").replace(/^["«]|["»]$/g, "").trim();
  if (line.endsWith("?") || line.startsWith("¿")) return ""; // a question to the user is the assistant's voice, not a sendable order (measured 14-10)
  if (/^\[[^\]]*\]$/.test(line)) return ""; // the model mimicked a transcript marker like "[called Bash]" (measured 14-10)
  const echo = lastAssistant.trim().replace(/^["«]|["»]$/g, "");
  return line === echo || (line !== "" && echo.startsWith(line)) ? "" : line;
}

/** The assistant's last real answer (tool noise stripped, as in the call): what the model tends to echo instead of recommending. */
export function lastAssistantText(lines: string[]): string {
  const { messages } = transcriptMessages(lines);
  const a = [...conversation(messages)].reverse().find((m) => m.role === "assistant");
  return (a?.content ?? []).map((b: { text?: unknown }) => (typeof b.text === "string" ? b.text : "")).join(" ").trim();
}
