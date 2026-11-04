// §3: el veredicto del MODELO se cachea por sesión|turno|sugerencia 24 h (LRU 1000). Las reglas duras no se cachean:
// el llamante las evalúa siempre antes de mirar la caché, así que una regla gana a cualquier veredicto guardado.
import { createHash } from "node:crypto";
import type { Veredicto } from "./juez.ts";

const TTL = 24 * 3600_000;
const TOPE = 1000;
const M = new Map<string, { v: Veredicto; exp: number }>();

export const clave = (sid: unknown, turno: unknown, sugerencia: string): string =>
  createHash("sha256").update(`${String(sid)}|${String(turno)}|${sugerencia}`).digest("hex");

export function leer(k: string): Veredicto | null {
  const e = M.get(k);
  if (!e) return null;
  if (e.exp < Date.now()) { M.delete(k); return null; }
  M.delete(k); M.set(k, e);   // LRU: lo usado vuelve al final de la cola
  return e.v;
}

/** Ni las reglas (deciden sin coste) ni el fail-closed (es un fallo, no un dictamen) se guardan. */
export function guardar(k: string, v: Veredicto): void {
  if (v.via !== "residente") return;
  M.set(k, { v, exp: Date.now() + TTL });
  if (M.size > TOPE) M.delete(M.keys().next().value as string);
}

/** Solo para los tests: deja la caché vacía. */
export function olvidar(): void { M.clear(); }