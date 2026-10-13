// The next-message suggestion: one small call with the session's transcript and a fixed instruction, answered by the resident.
// The instruction is the last message and never changes, and the transcript only grows, so consecutive suggestions of a session
// share a token prefix the resident's engine can cache: from the second one on, only the answer is paid for.
import { transcriptMessages, type Message } from "./transcript.ts";

/** The model that answers: the resident without reasoning, so the answer is plain text and costs nothing. */
export const SUGGEST_MODEL = "qwen38-off";
export const SUGGEST_MAX_TOKENS = 48;

/** Fixed, in the spirit of OpenChamber's session-assist prompt: a sendable message only for work that is genuinely owed. */
export const SUGGESTION_INSTRUCTION = `Tarea: escribe el único mensaje que el usuario debería enviar a continuación en esta conversación.
Reglas:
- Una sola línea, en castellano, como mucho 25 palabras, sin comillas ni prefijos: será el texto exacto que el usuario envíe.
- Solo si queda trabajo que el usuario pidió y aún no está hecho que el asistente puede hacer en esta sesión (un paso siguiente claro, algo prometido y no terminado, una corrección pedida).
- Si el trabajo está terminado, si la siguiente decisión es del usuario (aprobar, elegir, pagar) o si la conversación ha parado de verdad: responde una línea vacía.
Responde únicamente esa línea.`;

/** The whole call body: the transcript flattened as in a side question, the instruction as the last user turn, no tools. */
export function suggestBody(lines: string[]): string {
  const { messages } = transcriptMessages(lines);
  const last = messages[messages.length - 1];
  const withInstruction: Message[] =
    last?.role === "user"
      ? [...messages.slice(0, -1), { role: "user", content: [...last.content, { type: "text", text: SUGGESTION_INSTRUCTION }] }]
      : [...messages, { role: "user", content: [{ type: "text", text: SUGGESTION_INSTRUCTION }] }];
  return JSON.stringify({ model: SUGGEST_MODEL, max_tokens: SUGGEST_MAX_TOKENS, tools: [], messages: withInstruction });
}

/** The one sendable line, or "" for nothing to suggest: first non-empty line, quotes trimmed, a rambling answer dropped. */
export function suggestionAnswer(response: unknown): string {
  const parts = Array.isArray((response as { content?: unknown })?.content) ? ((response as { content: unknown[] }).content as any[]) : [];
  const text = parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
  const line = (text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "").replace(/^["«]|["»]$/g, "").trim();
  return line.length > 240 ? "" : line;
}
