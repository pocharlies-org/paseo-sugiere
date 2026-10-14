// The next-message suggestion: one small call with the session's transcript and a fixed instruction, answered by the resident.
// The instruction rides in `system` — as the last user turn the resident answered the conversation instead of suggesting (measured
// 13-10). System is fixed and the transcript only grows, so consecutive suggestions of a session still share a token prefix the
// resident's engine can cache: from the second one on, only the answer is paid for.
import { transcriptMessages } from "./transcript.ts";

/** The model that answers: the resident without reasoning, so the answer is plain text and costs nothing. */
export const SUGGEST_MODEL = "qwen38-off";
export const SUGGEST_MAX_TOKENS = 48;

/** Fixed. Dani 14-10: the pill recommends the next step in the assistant's voice — and the recommendation must be sendable:
if what comes next is the user's in the real world (measure, buy, approve, pay), there is no suggestion (measured 14-10: «mide la longitud del cañón» came out as a pill with an Enviar button). */
export const SUGGESTION_INSTRUCTION = `Tarea: escribe la recomendación que el asistente daría al usuario sobre cómo continuar esta conversación, tras su último turno.
Reglas:
- Una sola línea, en castellano, como mucho 25 palabras, sin comillas ni prefijos.
- Voz del asistente aconsejando el mejor siguiente paso, en imperativo («ejecuta los tests antes del merge», «arregla el parseo que falló»).
- La recomendación tiene que poder enviarse tal cual al asistente para que ÉL la ejecute en esta sesión. Nunca un paso que haga el usuario fuera de la conversación (medir algo físico, comprar, llamar, aprobar, pagar).
- NUNCA una pregunta dirigida al usuario («¿quieres que...?»).
- Solo si queda trabajo pendiente o un paso siguiente claro que el asistente pueda ejecutar (algo prometido y no terminado, una corrección pedida).
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

/** The whole call body: the conversation (no tool noise), the fixed instruction in `system`, no tools. */
export function suggestBody(lines: string[]): string {
  const { messages } = transcriptMessages(lines);
  return JSON.stringify({ model: SUGGEST_MODEL, max_tokens: SUGGEST_MAX_TOKENS, tools: [], system: SUGGESTION_INSTRUCTION, messages: conversation(messages) });
}

/** The one sendable line, or "" for nothing to suggest: first non-empty line, quotes trimmed, a rambling answer dropped,
and an answer that merely echoes the assistant's last line (the measured misfire of the small model) dropped too. */
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

/** The assistant's last real answer (tool noise stripped, as in the call): what the small model tends to echo instead of recommending. */
export function lastAssistantText(lines: string[]): string {
  const { messages } = transcriptMessages(lines);
  const a = [...conversation(messages)].reverse().find((m) => m.role === "assistant");
  return (a?.content ?? []).map((b: { text?: unknown }) => (typeof b.text === "string" ? b.text : "")).join(" ").trim();
}
