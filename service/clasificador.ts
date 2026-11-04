// El clasificador barato de la puerta: una embedding de bge-m3 (~150 ms) y un head lineal. Solo puede `permitir` o
// `escalar`: `detener` lo dicen las reglas duras y el residente, nunca esto. Nace en sombra (no cambia el veredicto de
// `/v1/verdict`): primero se mide su coverage y su recall contra el corpus real.
import { readFileSync } from "node:fs";

const EMBED = process.env.EMBED_URL || "http://bge-m3-embedding.llm.svc:8000";
const RUTA_PESOS = process.env.CLASIFICADOR_PESOS || "/etc/sugiere/clasificador.json";
const MAX_TEXTO = 4000;      // más largo no añade señal y el tokenizador del embedding corta antes
const TIMEOUT_MS = 2000;     // presupuesto del filtro: si no contesta a tiempo, se escala (nunca se permite)

export type Etiqueta = "permitir" | "escalar";
export type Pesos = { etiquetas: Etiqueta[]; pesos: number[][]; sesgo: number[]; umbral: number };

let cache: { ruta: string; pesos: Pesos | null } | null = null;

/** Un head con todos sus pesos a cero no ha aprendido nada: su softmax es una constante, y devolverla con forma de
 * probabilidad invita a que alguien la use de umbral. Sin entrenar se dice, no se disimula (medido 02-11: `p` 0,731
 * para `rm -rf` y para «añade un test»). */
export const sinEntrenar = (p: Pesos): boolean => p.pesos.every((f) => f.every((w) => w === 0));

/** Los pesos del head, o null si no están (somos sombra: sin pesos se escala todo). */
export function cargarPesos(ruta: string = RUTA_PESOS): Pesos | null {
  if (cache?.ruta === ruta) return cache.pesos;
  let pesos: Pesos | null = null;
  try {
    const p = JSON.parse(readFileSync(ruta, "utf8")) as Pesos;
    pesos = Array.isArray(p.pesos) && Array.isArray(p.etiquetas) ? p : null;
  } catch {
    pesos = null;
  }
  cache = { ruta, pesos };
  return pesos;
}

/** La embedding del texto (TEI: POST /embed {inputs:[…]} → [[…]]). */
export async function embedding(texto: string, timeoutMs = TIMEOUT_MS): Promise<number[]> {
  const r = await fetch(`${EMBED.replace(/\/$/, "")}/embed`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: [texto.slice(0, MAX_TEXTO)] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`bge-m3 respondió ${r.status}`);
  const v = (await r.json()) as number[][];
  const fila = Array.isArray(v?.[0]) ? v[0] : null;
  if (!fila) throw new Error("bge-m3 no devolvió vector");
  return fila;
}

/** El head: softmax de `pesos·x + sesgo`, y `permitir` solo si además pasa el umbral calibrado. */
export function decidir(x: number[], p: Pesos): { etiqueta: Etiqueta; p: number } {
  const z = p.etiquetas.map((_, i) => p.pesos[i].reduce((s, w, j) => s + w * (x[j] ?? 0), p.sesgo[i] ?? 0));
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const suma = e.reduce((a, b) => a + b, 0);
  const probs = e.map((v) => v / suma);
  const i = probs.indexOf(Math.max(...probs));
  const etiqueta = p.etiquetas[i];
  const prob = probs[i];
  if (etiqueta === "permitir" && prob < (p.umbral ?? 1)) return { etiqueta: "escalar", p: prob };
  return { etiqueta, p: prob };
}

/** Una pasada completa. Cualquier fallo es `escalar`: el filtro barato no puede abrir la puerta por accidente.
 * `etiqueta: null` es «no hay dictamen»: un head sin entrenar no clasifica, y su número no significa nada. */
export async function clasificar(texto: string, rutaPesos: string = RUTA_PESOS): Promise<{ etiqueta: Etiqueta | null; p: number | null; ms: number; motivo: string }> {
  const t0 = Date.now();
  const pesos = cargarPesos(rutaPesos);
  if (!pesos) return { etiqueta: "escalar", p: 0, ms: Date.now() - t0, motivo: "sin pesos" };
  if (sinEntrenar(pesos)) return { etiqueta: null, p: null, ms: Date.now() - t0, motivo: "head sin entrenar" };
  try {
    const { etiqueta, p } = decidir(await embedding(texto), pesos);
    return { etiqueta, p, ms: Date.now() - t0, motivo: "" };
  } catch (error) {
    return { etiqueta: "escalar", p: 0, ms: Date.now() - t0, motivo: String((error as Error).message).slice(0, 120) };
  }
}