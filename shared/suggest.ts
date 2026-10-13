// The next-message suggestion: one small call with the session's transcript and a fixed instruction, answered by the resident.
// The instruction rides in `system` — as the last user turn the resident answered the conversation instead of suggesting (measured
// 13-10). System is fixed and the transcript only grows, so consecutive suggestions of a session still share a token prefix the
// resident's engine can cache: from the second one on, only the answer is paid for.
import { transcriptMessages } from "./transcript.ts";

/** The model that answers: the resident without reasoning, so the answer is plain text and costs nothing. */
export const SUGGEST_MODEL = "qwen38-off";
export const SUGGEST_MAX_TOKENS = 48;

/** Fixed, in the spirit of OpenChamber's session-assist prompt: a sendable message only for work that is genuinely owed. */
export const SUGGESTION_INSTRUCTION = `Tarea: escribe el único mensaje que el usuario debería enviar a continuación en esta conversación.
Reglas:
- Una sola línea, en castellano, como mucho 25 palabras, sin comillas ni prefijos: será el texto exacto que el usuario envíe.
- Escríbela como hablaría el usuario, en lenguaje natural: nunca imites el formato de la conversación (nada de lineas entre corchetes ni texto del asistente).
- Solo si queda trabajo que el usuario pidió y aún no está hecho que el asistente puede hacer en esta sesión (un paso siguiente claro, algo prometido y no terminado, una corrección pedida).
- Si el trabajo está terminado, si la siguiente decisión es del usuario (aprobar, elegir, pagar) o si la conversación ha parado de verdad: responde una línea vacía.
Responde únicamente esa línea. Si no hay nada que sugerir, tu respuesta es la línea vacía.`;

/** The whole call body: the transcript flattened as in a side question, the fixed instruction in `system`, no tools. */
export function suggestBody(lines: string[]): string {
  const { messages } = transcriptMessages(lines);
  return JSON.stringify({ model: SUGGEST_MODEL, max_tokens: SUGGEST_MAX_TOKENS, tools: [], system: SUGGESTION_INSTRUCTION, messages });
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
  const echo = lastAssistant.trim().replace(/^["«]|["»]$/g, "");
  return line === echo || (line !== "" && echo.startsWith(line)) ? "" : line;
}

/** The assistant's last flattened line: what the small model tends to echo instead of suggesting. */
export function lastAssistantText(lines: string[]): string {
  const { messages } = transcriptMessages(lines);
  const a = [...messages].reverse().find((m) => m.role === "assistant");
  return (a?.content ?? []).map((b: { text?: unknown }) => (typeof b.text === "string" ? b.text : "")).join(" ").trim();
}
