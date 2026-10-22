// The next-message suggestion: one small call with the session's transcript and an instruction (built-in, or the user's from
// settings), answered by the SAME model the session is running (Dani 22-10), not a fixed one. A session with no real model yet gets no call.
// The instruction rides in `system` — as the last user turn the model answered the conversation instead of suggesting (measured
// 13-10). System is fixed and the transcript only grows, so consecutive suggestions of a session keep a stable token prefix.
// Cost: every suggestion sends the whole conversation (up to ~100k tokens) to the session's model and does not share the session's own cache.
import { transcriptMessages } from "./transcript.ts";

export const SUGGEST_MAX_TOKENS = 48;

/** Fixed. Dani 14-10: the pill recommends the next step toward the task's GOAL — the model was continuing the assistant's last
turn instead of recommending (measured: «PR #14 en vigilancia…» came out). Sendable rule kept: if what comes next is the user's
in the real world (measure, buy, approve, pay), there is no suggestion (measured 14-10: «mide la longitud del cañón»). */
export const SUGGESTION_INSTRUCTION = `Tarea: esta conversación tiene una tarea en curso con un objetivo: lo que el usuario pidió al principio. Escribe el siguiente paso que el usuario debería pedir para avanzar hacia ese objetivo.
Reglas:
- El último turno del asistente está TERMINADO: no lo continúes, no lo resumas, no lo repitas. La recomendación es un paso NUEVO.
- Ten en cuenta lo ya hecho y lo que queda: recomienda el paso siguiente que acerca al objetivo (algo prometido y no terminado, una corrección pedida, el siguiente paso natural).
- Una sola línea, en castellano, como mucho 25 palabras, sin comillas ni prefijos.
- Voz del asistente aconsejando, en imperativo («ejecuta los tests antes del merge», «arregla el parseo que falló»).
- La recomendación tiene que poder enviarse tal cual al asistente para que ÉL la ejecute en esta sesión. Nunca un paso que haga el usuario fuera de la conversación (medir algo físico, comprar, llamar, aprobar, pagar).
- NUNCA una pregunta dirigida al usuario («¿quieres que...?»).
- Si el trabajo está terminado, si lo que falta es acción o decisión del usuario, o si la conversación ha parado de verdad: responde una línea vacía.
Responde únicamente esa línea. Si no hay nada que recomendar, tu respuesta es la línea vacía.`;

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
const TRIGGER = "¿Qué debería pedirle a continuación al asistente? Responde solo con esa línea.";

/** The whole call: the session's own model, and the body — the conversation (no tool noise), the instruction in `system` (the
configured one, or the built-in when it is empty), the constant trigger last, no tools. Null when the session has no real model
(no assistant message yet, or only `<synthetic>` ones): there is nothing to call and no fallback model (Dani 22-10). */
export function suggestBody(lines: string[], prompt = ""): { model: string; body: string } | null {
  const { messages, model } = transcriptMessages(lines);
  if (!model) return null;
  const body = JSON.stringify({
    model,
    max_tokens: SUGGEST_MAX_TOKENS,
    tools: [],
    system: prompt.trim() || SUGGESTION_INSTRUCTION,
    messages: [...conversation(messages), { role: "user", content: [{ type: "text", text: TRIGGER }] }],
  });
  return { model, body };
}

/** The one sendable line, or "" for nothing to suggest: first non-empty line, quotes trimmed, a rambling answer dropped,
and an answer that merely echoes the assistant's last line (the measured misfire of the model) dropped too. */
export function suggestionAnswer(response: unknown, lastAssistant = ""): string {
  const parts = Array.isArray((response as { content?: unknown })?.content) ? ((response as { content: unknown[] }).content as any[]) : [];
  const text = parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
  const line = (text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "").replace(/^["«]|["»]$/g, "").trim();
  if (line.length > 240) return "";
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
