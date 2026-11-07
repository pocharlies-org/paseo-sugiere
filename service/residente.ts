// La única llamada al modelo, por LiteLLM: /v1/chat/completions con el MISMO modelo que corre la sesión si llama Paseo en vivo
// (Dani 22-10 y 06-11) y con el residente local si llama la compañía (Dani 06-11); el
// cuerpo que ya arma `shared/suggest.ts` y `reasoning_effort: none`, que LiteLLM traduce a `enable_thinking: false` en cualquier alias.
import { type Plan, SUGGEST_WAIT_MS, planAnswer, suggestBody, suggestionAnswer, lastAssistantText } from "../shared/suggest.ts";

export const LITELLM = process.env.RESIDENTE_URL || "http://litellm.litellm.svc:4000";
const KEY = process.env.RESIDENTE_KEY || "";
/** El residente local: el modelo de la compañía y la reserva cuando la clave no sirve el alias de una sesión (Dani 06-11). */
export const RESERVA = process.env.SUGIERE_MODELO_RESERVA || "qwen38-flash-next";

/** El cuerpo de la sugerencia en la forma del chat: el `system` del cuerpo Anthropic (dos bloques) pasa a un mensaje de sistema
 * que CONSERVA los bloques: las cuentas de suscripción de Claude responden 429 «Error» si la línea de Claude Code no es un bloque
 * propio (medido 07-11: el texto junto, 429; en bloques, 200 en claude-*, qwen, alibaba y gpt). */
export function cuerpoSugerencia(lines: string[], modelo = "", plan: Plan | null = null): string | null {
  const s = suggestBody(lines, modelo, plan);
  if (!s) return null; // la sesión no tiene modelo real todavía: no hay nada que llamar, y no hay modelo de reserva
  const a = JSON.parse(s.body);
  return JSON.stringify({
    model: a.model,
    max_tokens: a.max_tokens,
    reasoning_effort: a.reasoning_effort,
    messages: [{ role: "system", content: a.system.map((b: any) => ({ type: "text", text: b.text })) },
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

type Sugerencia = { texto: string; modelo: string; en_plan?: string | null; criterio?: string };

/** La sugerencia del siguiente mensaje: "" cuando no hay nada que proponer. `kind: "live"` (Paseo en vivo) usa el modelo de la
 * sesión; cualquier otro llamante —la compañía, o quien no lo diga— el residente local (Dani 06-11). Con `plan`, además, qué
 * persigue (`en_plan`) y el criterio. */
export async function sugerir(lines: string[], timeoutMs = SUGGEST_WAIT_MS, kind = "", plan: Plan | null = null): Promise<Sugerencia> {
  // Un plan sin criterios no ancla (decisión 2 de Dani): «todo verificado → entregar» saldría vacuamente cierto (medido en el eval).
  if (!plan?.criterios?.length) plan = null;
  const cuerpo = cuerpoSugerencia(lines, kind === "live" ? "" : RESERVA, plan);
  if (!cuerpo) return plan ? { texto: "", modelo: "", en_plan: null, criterio: "" } : { texto: "", modelo: "" };
  const modelo = JSON.parse(cuerpo).model;
  const pedir = async (c: string) => {
    const r = comoAnthropic(await llamar(c, timeoutMs));
    return plan ? planAnswer(r, lastAssistantText(lines)) : { texto: suggestionAnswer(r, lastAssistantText(lines)) };
  };
  try {
    return { ...(await pedir(cuerpo)), modelo };
  } catch (e) {
    // Un alias que la clave no sirve da 403 y la píldora salía vacía (Dani 05-11); un 429 (las cuentas de la sesión agotadas o
    // sin asignar, medido 07-11) también: una sola reserva, solo para esos dos. El cuerpo se rehace para el residente, con su
    // `reasoning_effort` y no el del modelo de la sesión.
    const status = (e as { status?: number }).status;
    if ((status !== 403 && status !== 429) || modelo === RESERVA) throw e;
    return { ...(await pedir(cuerpoSugerencia(lines, RESERVA, plan)!)), modelo: RESERVA };
  }
}

/** Una respuesta de texto para la rúbrica del dictamen (eso sí, con un modelo fijo: no depende de ninguna sesión). */
export async function texto(modelo: string, prompt: string, timeoutMs = 60_000): Promise<string> {
  const cuerpo = JSON.stringify({ model: modelo, max_tokens: 400, reasoning_effort: "none",
    messages: [{ role: "user", content: prompt }] });
  const r = await llamar(cuerpo, timeoutMs);
  return String(r?.choices?.[0]?.message?.content ?? "").trim();
}