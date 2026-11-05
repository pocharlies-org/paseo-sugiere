// El registro de calidad de la puerta: una línea JSON por veredicto con la sugerencia ENTERA. El log de stdout la corta a
// 120 caracteres, que sirve para depurar pero no para etiquetar veredictos ni para comparar el brain contra el modelo.
// La línea se escribe cuando termina el brain (en `sombra` corre en paralelo), nunca antes de responder al llamante.
import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";

const RUTA = process.env.AUDITORIA_RUTA || "/var/lib/sugiere/auditoria.jsonl";
const MAX_BYTES = Number(process.env.AUDITORIA_MAX_BYTES || String(64 * 1024 * 1024));
const MAX_CONSULTA = 500;

export type BrainReg = { modo: string; ms: number; n: number; motivo: string } | null;
export type Registro = { ts: string; sid: string; turno: string; ms: number; ok: boolean; riesgo: string; motivo: string;
  via: string; traza?: string[]; cwd?: string; key?: string; sugerencia: string; brain?: BrainReg };

let tamano: { ruta: string; bytes: number } | null = null;

/** Una rotación por tamaño, un solo fichero viejo (`.1`): el registro es para leerlo, no para archivarlo. */
function rotar(ruta: string) {
  const bytes = tamano?.ruta === ruta ? tamano.bytes : (() => { try { return statSync(ruta).size; } catch { return 0; } })();
  if (bytes < MAX_BYTES) { tamano = { ruta, bytes }; return; }
  try { renameSync(ruta, `${ruta}.1`); } catch { /* sin fichero previo o sin permiso: se sigue escribiendo */ }
  tamano = { ruta, bytes: 0 };
}

/** Una línea. Si no se puede escribir se avisa una vez y la puerta sigue: la auditoría no puede tumbar un veredicto. */
export function registrar(r: Registro, ruta: string = RUTA): void {
  const linea = `${JSON.stringify(r)}\n`;
  try {
    rotar(ruta);
    appendFileSync(ruta, linea);
    tamano = { ruta, bytes: (tamano?.ruta === ruta ? tamano.bytes : 0) + Buffer.byteLength(linea) };
  } catch (error) {
    console.warn(JSON.stringify({ auditoria: "no se pudo escribir", ruta, error: String((error as Error).message).slice(0, 120) }));
  }
}

/** La auditoría de un veredicto se cierra cuando el brain acaba, sin retrasar la respuesta: se llama sin `await`. */
export function registrarCuando(brain: Promise<BrainReg>, base: Omit<Registro, "brain">, ruta: string = RUTA): void {
  brain.then((b) => registrar({ ...base, brain: b }, ruta)).catch(() => registrar({ ...base, brain: null }, ruta));
}

export type Filtro = { limit?: number; desde?: string; hasta?: string; ok?: boolean; via?: string };

/** Las últimas líneas que pasan el filtro, de la más vieja a la más nueva. Las líneas rotas se ignoran. */
export function consultar(f: Filtro = {}, ruta: string = RUTA): Registro[] {
  let texto = "";
  try { texto = readFileSync(ruta, "utf8"); } catch { return []; }
  const out: Registro[] = [];
  for (const linea of texto.split("\n")) {
    if (!linea.trim()) continue;
    let r: Registro;
    try { r = JSON.parse(linea); } catch { continue; }
    if (f.desde && r.ts < f.desde) continue;
    if (f.hasta && r.ts > f.hasta) continue;
    if (f.ok !== undefined && r.ok !== f.ok) continue;
    if (f.via && r.via !== f.via) continue;
    out.push(r);
  }
  // `limit` no numérico llega como NaN (`Number("abc")`): sin esto, slice(-NaN) es slice(0) y devuelve el registro ENTERO.
  const limit = Number.isFinite(f.limit) ? Math.max(Math.trunc(f.limit as number), 1) : 100;
  return out.slice(-Math.min(limit, MAX_CONSULTA));
}