// El contexto del brain (hindsight) para la rúbrica, con interruptor. Medido el 03-11 desde el pod `sugiere`: un recall
// de 5 recuerdos tarda 8,6-9,6 s y 3 de 5 pasan de 20 s, así que NO puede ir delante de cada veredicto por defecto.
// De ahí tres modos, y `off` el de fábrica:
//   off     no se llama a nadie (lo de siempre).
//   sombra  corre EN PARALELO al veredicto y solo queda en la auditoría: cero latencia añadida, cero efecto.
//   on      se espera al brain con un tope duro y sus recuerdos entran en la rúbrica; su fallo, su lentitud o su silencio
//           son «sin contexto», nunca un veredicto distinto por un timeout.
import { readFileSync } from "node:fs";

const RUTA_MODO = process.env.BRAIN_MODO_FICHERO || "/etc/sugiere/brain.json";
const BRAIN_URL = process.env.BRAIN_URL || "http://hindsight-api.hindsight.svc:8888";
const BANCO = process.env.BRAIN_BANCO || "claude-personal";
const TOPE_MS = Number(process.env.BRAIN_TOPE_MS || "20000");
const MAX_RECUERDOS = Number(process.env.BRAIN_MAX || "5");
const MAX_RECUERDO = 400;   // un recuerdo largo no añade señal a la rúbrica y sí tokens de espera

export type ModoBrain = "off" | "sombra" | "on";
export type Recuerdo = { id: string; texto: string };
export type Busqueda = { ms: number; recuerdos: Recuerdo[]; motivo: string };

/** El modo, releído del fichero en cada petición: cambiarlo no exige reiniciar el pod. Ausente o ilegible = off. */
export function modoBrain(ruta: string = RUTA_MODO): ModoBrain {
  try {
    const m = String(JSON.parse(readFileSync(ruta, "utf8"))?.modo ?? "").toLowerCase();
    return m === "sombra" || m === "on" ? m : "off";
  } catch {
    return "off";
  }
}

function token(): string {
  if (process.env.BRAIN_TOKEN) return process.env.BRAIN_TOKEN;
  try { return readFileSync(process.env.BRAIN_TOKEN_FICHERO || "", "utf8").trim(); } catch { return ""; }
}

/** Los recuerdos del cuerpo del recall. Acepta `results` (la forma de hoy) y `memories` (la de antes) sin fallar. */
export function recuerdosDelCuerpo(cuerpo: unknown): Recuerdo[] {
  const lista = (cuerpo as any)?.results ?? (cuerpo as any)?.memories ?? [];
  if (!Array.isArray(lista)) return [];
  return lista
    .map((r: any) => ({ id: String(r?.id ?? ""), texto: String(r?.text ?? r?.content ?? "").replace(/\s+/g, " ").trim() }))
    .filter((r) => r.texto)
    .slice(0, MAX_RECUERDOS)
    .map((r) => ({ id: r.id, texto: r.texto.slice(0, MAX_RECUERDO) }));
}

/** Una búsqueda. Nunca lanza: un brain caído es «sin contexto», que es exactamente lo que había antes de él. */
export async function recordar(consulta: string, timeoutMs: number = TOPE_MS): Promise<Busqueda> {
  const t0 = Date.now();
  const t = token();
  if (!t) return { ms: 0, recuerdos: [], motivo: "sin token" };
  try {
    const r = await fetch(`${BRAIN_URL.replace(/\/$/, "")}/v1/default/banks/${BANCO}/memories/recall`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
      body: JSON.stringify({ query: consulta.slice(0, 1000), budget: "low", max_tokens: 512 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ms: Date.now() - t0, recuerdos: [], motivo: `brain respondió ${r.status}` };
    return { ms: Date.now() - t0, recuerdos: recuerdosDelCuerpo(await r.json()), motivo: "ok" };
  } catch (error) {
    const e = error as Error;
    return { ms: Date.now() - t0, recuerdos: [], motivo: e.name === "TimeoutError" ? `sin respuesta en ${timeoutMs} ms` : e.message.slice(0, 120) };
  }
}