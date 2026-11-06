// La única llamada al residente, por LiteLLM: /v1/chat/completions con el MISMO modelo que corre la sesión (Dani 22-10), el
// cuerpo que ya arma `shared/suggest.ts` y `reasoning_effort: none`, que LiteLLM traduce a `enable_thinking: false` en cualquier alias.
import { suggestBody, suggestionAnswer, lastAssistantText } from "../shared/suggest.ts";

export const LITELLM = process.env.RESIDENTE_URL || "http://litellm.litellm.svc:4000";
const KEY = process.env.RESIDENTE_KEY || "";
/** Alias que la clave del servicio sí puede usar (`/key/info` de LiteLLM: `models: [qwen38-flash-next]`, 05-11). */
export const RESERVA = process.env.SUGIERE_MODELO_RESERVA || "qwen38-flash-next";

/** El cuerpo de la sugerencia en la forma del chat: el `system` del cuerpo Anthropic (dos bloques) pasa a un mensaje de sistema. */
export function cuerpoSugerencia(lines: string[], instruccion = ""): string | null {
  const s = suggestBody(lines, instruccion);
  if (!s) return null; // la sesión no tiene modelo real todavía: no hay nada que llamar, y no hay modelo de reserva
  const a = JSON.parse(s.body);
  return JSON.stringify({
    model: a.model,
    max_tokens: a.max_tokens,
    reasoning_effort: a.reasoning_effort,
    messages: [{ role: "system", content: a.system.map((b: any) => b.text).join("\n\n") },
      ...a.messages.map((m: any) => ({ role: m.role, content: m.content.map((b: any) => b.text).join("\n") }))],
  });
}

async function llamar(cuerpo: string, timeoutMs: number): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (KEY) headers.authorization = `Bearer ${KEY}`;
  const r = await fetch(`${LITELLM.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST", headers, body: cuerpo, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw Object.assign(new Error(`LiteLLM respondió ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: r.status });
  return r.json();
}

/** Completions como respuesta Anthropic: lo que come `suggestionAnswer`, que ya descarta preguntas y ecos. */
const comoAnthropic = (r: any) => ({ content: [{ type: "text", text: r?.choices?.[0]?.message?.content ?? "" }] });

/** La sugerencia del siguiente mensaje: "" cuando no hay nada que proponer. */
export async function sugerir(lines: string[], instruccion = "", timeoutMs = 120_000): Promise<{ texto: string; modelo: string }> {
  const cuerpo = cuerpoSugerencia(lines, instruccion);
  if (!cuerpo) return { texto: "", modelo: "" };
  const modelo = JSON.parse(cuerpo).model;
  const pedir = async (c: string) => suggestionAnswer(comoAnthropic(await llamar(c, timeoutMs)), lastAssistantText(lines));
  try {
    return { texto: await pedir(cuerpo), modelo };
  } catch (e) {
    // La clave del servicio no sirve todos los alias (LiteLLM: `models: [qwen38-flash-next]`), así que una sesión en otro
    // modelo —Alibaba, `claude-*`— recibía un 403 y la píldora salía vacía (Dani 05-11). Una sola reserva, y solo para el 403.
    if ((e as { status?: number }).status !== 403 || modelo === RESERVA) throw e;
    return { texto: await pedir(JSON.stringify({ ...JSON.parse(cuerpo), model: RESERVA })), modelo: RESERVA };
  }
}

/** Una respuesta de texto para la rúbrica del dictamen (eso sí, con un modelo fijo: no depende de ninguna sesión). */
export async function texto(modelo: string, prompt: string, timeoutMs = 60_000): Promise<string> {
  const cuerpo = JSON.stringify({ model: modelo, max_tokens: 400, reasoning_effort: "none",
    messages: [{ role: "user", content: prompt }] });
  const r = await llamar(cuerpo, timeoutMs);
  return String(r?.choices?.[0]?.message?.content ?? "").trim();
}