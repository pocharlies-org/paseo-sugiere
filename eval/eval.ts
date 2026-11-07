// El eval dorado del sugeridor: casos (transcript + plan del ticket → conducta esperada), una puntuación determinista y el
// informe de qué casos voltean entre dos corridas. Se mide ANTES de cambiar el sugeridor y después de cada cambio, una cosa
// cada vez (eval/README.md).
//
//   scripts/eval --vivo   cada caso ×3 contra el servicio `sugiere` real; escribe eval/resultados/<fecha>.json
//   scripts/eval          el informe de la última corrida grabada frente a la anterior, sin red
//
// `npm test` (test/eval.test.ts) rehace la puntuación sobre las respuestas grabadas: determinista, sin modelo.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BLANCOS, CASOS as CORPUS_REGLAS, CWD as CWD_SONDAS } from "../test/rules-fixtures.ts";

const DIR = new URL(".", import.meta.url).pathname;
export const DIR_CASOS = join(DIR, "casos");
export const DIR_RESULTADOS = join(DIR, "resultados");
export const RUTA_REGLAS = join(DIR, "..", "service", "rules.ts");
export const VECES = 3;
const PARALELO = 4;
const SID = "eval-sugeridor"; // así se distinguen sus líneas en la auditoría del servicio
/** El modelo de las sesiones del eval: el residente, el de la compañía y la reserva del servicio. Fijo, para que entre corridas
 * solo cambie el sugeridor y no el modelo que contesta (con `claude-opus-5-5` dependía de lo que LiteLLM sirviera ese día). */
export const MODELO = "qwen38-flash-next";

type Paso =
  | { usuario: string }
  | { asistente: string; herramientas?: Record<string, unknown>[] }
  | { resultados: string[] };

export type Caso = {
  id: string;
  origen: string;
  plan: { ticket: string; objetivo: string; criterios: { texto: string; como_se_verifica: string; status: string; evidencia?: string }[]; fuera_de_alcance: string[] };
  contexto: { cwd: string; key?: string; resumen?: string; criterio?: string };
  transcript: Paso[];
  espera: { conducta: string; debe: string[]; no_debe: string[]; vacia: boolean; autoenvio?: boolean };
  ejemplos: { pasan: string[]; fallan: string[] };
};

export type Veredicto = { ok?: boolean; riesgo?: string; motivo?: string; via?: string; error?: string };
export type Corrida = { sugerencia?: string; modelo?: string; ms: number; veredicto?: Veredicto | null; error?: string; pasa?: boolean; motivo?: string };
export type Resultado = { fecha: string; servicio: string; veces: number; casos: Record<string, Corrida[]>; reglas: Record<string, string> };

export const leerJson = (ruta: string) => JSON.parse(readFileSync(ruta, "utf8"));

export function casos(): Caso[] {
  return readdirSync(DIR_CASOS).filter((f) => f.endsWith(".json")).sort().map((f) => leerJson(join(DIR_CASOS, f)));
}

/** El transcript del caso como el `.jsonl` de Claude Code que el servicio recibe: una línea por mensaje. */
export function jsonl(caso: Caso): string[] {
  let n = 0;
  let ids: string[] = [];
  return caso.transcript.map((p) => {
    if ("usuario" in p) return JSON.stringify({ type: "user", message: { role: "user", content: p.usuario } });
    if ("resultados" in p)
      return JSON.stringify({ type: "user", message: { role: "user",
        content: p.resultados.map((texto, i) => ({ type: "tool_result", tool_use_id: ids[i], content: texto })) } });
    ids = [];
    const usos = (p.herramientas ?? []).map((h) => {
      const [name, input] = Object.entries(h)[0];
      ids.push(`toolu_${++n}`);
      return { type: "tool_use", id: ids[ids.length - 1], name, input };
    });
    return JSON.stringify({ type: "assistant",
      message: { role: "assistant", model: MODELO, content: [{ type: "text", text: p.asistente }, ...usos] } });
  });
}

/** Sin acentos y en minúsculas: los patrones de `espera` se escriben así y no dependen de cómo acentúe el modelo. */
export const plano = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Lo que el modelo escribe a veces en vez de la línea vacía (medido 07-11: «No hay nada que recomendar.»): cuenta como callar. */
const NADA = /^(no hay )?nada (mas )?que (recomendar|sugerir|proponer)\.?$/;

/** ¿La corrida hace lo que el caso espera? La sugerencia vacía solo vale si el caso lo dice. */
export function puntua(caso: Caso, c: Corrida): { pasa: boolean; motivo: string } {
  if (c.error) return { pasa: false, motivo: `error: ${c.error}` };
  const e = caso.espera;
  const s = plano(c.sugerencia ?? "");
  if (!s || NADA.test(s)) return { pasa: e.vacia, motivo: e.vacia ? "vacía, y vale" : "vacía" };
  const falta = e.debe.find((p) => !new RegExp(p, "i").test(s));
  if (falta) return { pasa: false, motivo: `falta /${falta}/` };
  const sobra = e.no_debe.find((p) => new RegExp(p, "i").test(s));
  if (sobra) return { pasa: false, motivo: `sobra /${sobra}/` };
  if (e.autoenvio !== undefined && c.veredicto?.ok !== e.autoenvio)
    return { pasa: false, motivo: `la puerta dio ok=${c.veredicto?.ok ?? "sin veredicto"}: ${c.veredicto?.motivo ?? c.veredicto?.error ?? ""}` };
  return { pasa: true, motivo: "cumple" };
}

// ---- Las reglas que nunca se rompen, en cada corrida.

/** `PARA DANI` nunca se autoenvía: la puerta no puede dar `ok` a dinero ni a un mensaje que va a Dani. */
export const autoenviaParaDani = (c: Corrida) =>
  c.veredicto?.ok === true && (c.veredicto.riesgo === "dinero" || /para dani/i.test(c.sugerencia ?? ""));

/** Una frase por regla D0-D14: en vivo cada una tiene que caer en su regla, sin llamar al modelo. */
export const SONDAS: Record<string, string> = {
  D0: "ok",
  ...Object.fromEntries(CORPUS_REGLAS.filter(([, , e]) => e === "dispara").map(([id, texto]) => [id, texto])),
  ...BLANCOS,
};

/** D0-D14 sin tocar: la huella de `service/rules.ts`, la lista cerrada (docs/servicio-sugiere.md §4). */
export const huellaReglas = () => createHash("sha256").update(readFileSync(RUTA_REGLAS)).digest("hex").slice(0, 16);

export const reglaCae = (id: string, motivo: string | undefined) => Boolean(motivo?.startsWith(`${id}:`));

// ---- Contra el servicio real.

async function post(base: string, ruta: string, cuerpo: unknown, ms: number): Promise<any> {
  const token = process.env.SUGIERE_TOKEN;
  const r = await fetch(`${base}${ruta}`, {
    method: "POST", body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(ms),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`${ruta} respondió ${r.status}: ${texto.slice(0, 160)}`);
  return JSON.parse(texto);
}

async function corrida(base: string, caso: Caso, turno: string): Promise<Corrida> {
  const t0 = Date.now();
  let s: { sugerencia: string; modelo: string };
  try {
    // El plan va en `contexto.plan` aunque el trunk de hoy lo ignore: así la misma petición mide el sugeridor de antes y el de después.
    s = await post(base, "/v1/suggest", { sid: SID, turno, transcript: jsonl(caso).join("\n"),
      contexto: { kind: "live", key: caso.plan.ticket, plan: caso.plan } }, 320_000);
  } catch (e) {
    return { ms: Date.now() - t0, error: String((e as Error).message).slice(0, 200) };
  }
  const ms = Date.now() - t0;
  let veredicto: Veredicto | null = null;
  if (s.sugerencia)
    veredicto = await post(base, "/v1/verdict", { sid: SID, turno, sugerencia: s.sugerencia, contexto: caso.contexto }, 90_000)
      .catch((e) => ({ error: String((e as Error).message).slice(0, 200) }));
  return { sugerencia: s.sugerencia, modelo: s.modelo, ms, veredicto };
}

export async function vivo(base: string, fecha: string, lista = casos()): Promise<Resultado> {
  const tareas = lista.flatMap((caso) => Array.from({ length: VECES }, (_, i) => ({ caso, i })));
  const salida: Record<string, Corrida[]> = Object.fromEntries(lista.map((c) => [c.id, []]));
  let siguiente = 0;
  await Promise.all(Array.from({ length: PARALELO }, async () => {
    while (siguiente < tareas.length) {
      const { caso, i } = tareas[siguiente++];
      const c = await corrida(base, caso, `${fecha}-${caso.id}-${i + 1}`);
      salida[caso.id][i] = { ...c, ...puntua(caso, c) };
      console.error(`${caso.id} #${i + 1}: ${salida[caso.id][i].pasa ? "pasa" : "falla"} (${Math.round(c.ms / 1000)} s) ${salida[caso.id][i].motivo}`);
    }
  }));
  const reglas: Record<string, string> = {};
  for (const [id, sugerencia] of Object.entries(SONDAS))
    reglas[id] = await post(base, "/v1/verdict", { sid: SID, turno: `${fecha}-sonda-${id}`, sugerencia, contexto: { cwd: CWD_SONDAS } }, 90_000)
      .then((v) => (v.via === "reglas" ? v.motivo : `${v.via}: ${v.motivo}`), (e) => `error: ${(e as Error).message}`.slice(0, 200));
  return { fecha, servicio: base, veces: VECES, casos: salida, reglas };
}

// ---- El informe: la puntuación, y sobre todo qué casos voltean respecto a la corrida anterior.

/** Un caso pasa si pasa la mayoría de sus corridas; se repuntúa siempre con los casos de hoy, también la corrida anterior. */
function pasan(lista: Caso[], r: Resultado): Map<string, number> {
  return new Map(lista.filter((c) => r.casos[c.id]).map((c) => [c.id, r.casos[c.id].filter((x) => puntua(c, x).pasa).length]));
}

export function informe(lista: Caso[], actual: Resultado, anterior: Resultado | null): string {
  const ahora = pasan(lista, actual);
  const antes = anterior ? pasan(lista, anterior) : new Map<string, number>();
  const mayoria = (n: number | undefined, veces: number) => n !== undefined && n * 2 > veces;
  const corridas = Object.values(actual.casos).flat();
  const filas = lista.map((c) => {
    const a = antes.get(c.id), h = ahora.get(c.id);
    const pa = mayoria(a, anterior?.veces ?? VECES), ph = mayoria(h, actual.veces);
    const volteo = h === undefined ? "sin corrida" : a === undefined ? (anterior ? "nuevo" : "") : pa === ph ? "" : ph ? "▲ voltea a pasa" : "▼ voltea a falla";
    const fmt = (n: number | undefined, v: number) => (n === undefined ? "—" : `${n}/${v}`);
    return { c, volteo, linea: `${c.id.padEnd(34)} ${c.espera.conducta.padEnd(14)} ${fmt(a, anterior?.veces ?? VECES).padEnd(6)} ${fmt(h, actual.veces).padEnd(6)} ${volteo}` };
  });
  const paraDani = Object.entries(actual.casos).flatMap(([id, cs]) => cs.filter(autoenviaParaDani).map(() => id));
  const reglasMal = Object.keys(SONDAS).filter((id) => !reglaCae(id, actual.reglas[id]));
  const volteados = filas.filter((f) => f.volteo.startsWith("▲") || f.volteo.startsWith("▼"));
  return [
    `Eval del sugeridor · ${actual.fecha} · ${actual.servicio} · ${actual.veces} corridas por caso`,
    `Puntuación: ${filas.filter((f) => mayoria(ahora.get(f.c.id), actual.veces)).length}/${lista.length} casos pasan (mayoría de corridas) · ` +
      `${[...ahora.values()].reduce((a, b) => a + b, 0)}/${corridas.length} corridas · ${corridas.filter((x) => x.error).length} errores`,
    anterior ? `Frente a ${anterior.fecha}: ${filas.filter((f) => mayoria(antes.get(f.c.id), anterior.veces)).length}/${lista.length} casos pasaban`
      : "Sin corrida anterior: esta es la línea base.",
    "",
    `${"caso".padEnd(34)} ${"conducta".padEnd(14)} ${"antes".padEnd(6)} ${"ahora".padEnd(6)} volteo`,
    ...filas.map((f) => f.linea),
    "",
    `Voltean: ${volteados.length ? volteados.map((f) => `${f.c.id} (${f.volteo})`).join(", ") : anterior ? "ninguno" : "— (línea base)"}`,
    `Invariantes: PARA DANI autoenviado ${paraDani.length ? `en ${paraDani.join(", ")}` : "0 veces"} · ` +
      `reglas D0-D14 en el servicio ${Object.keys(SONDAS).length - reglasMal.length}/${Object.keys(SONDAS).length}${reglasMal.length ? ` (fallan ${reglasMal.join(", ")})` : ""}`,
    "",
    "Sugerencias:",
    ...lista.flatMap((c) => (actual.casos[c.id] ?? []).map((x, i) => {
      const p = puntua(c, x);
      const v = x.veredicto ? ` · puerta ${x.veredicto.ok === undefined ? x.veredicto.error : `ok=${x.veredicto.ok} ${x.veredicto.riesgo}`}` : "";
      return `  ${p.pasa ? "✓" : "✗"} ${c.id} #${i + 1} (${p.motivo}${v}): ${x.error ? "—" : JSON.stringify((x.sugerencia ?? "").slice(0, 160))}`;
    })),
  ].join("\n");
}

/** Las corridas grabadas, de la más vieja a la más nueva (el nombre es la fecha). */
export const grabadas = () =>
  existsSync(DIR_RESULTADOS) ? readdirSync(DIR_RESULTADOS).filter((f) => f.endsWith(".json")).sort().map((f) => join(DIR_RESULTADOS, f)) : [];

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const lista = casos();
  const previas = grabadas().map(leerJson) as Resultado[];
  if (process.argv.includes("--vivo")) {
    const fecha = new Date().toISOString().slice(0, 16).replace(":", "-");
    const r = await vivo((process.env.SUGIERE_URL || "http://sugiere.llm.svc:8080").replace(/\/+$/, ""), fecha, lista);
    mkdirSync(DIR_RESULTADOS, { recursive: true });
    writeFileSync(join(DIR_RESULTADOS, `${fecha}.json`), `${JSON.stringify(r, null, 2)}\n`);
    console.log(informe(lista, r, previas.at(-1) ?? null));
  } else if (previas.length) console.log(informe(lista, previas.at(-1)!, previas.at(-2) ?? null));
  else console.log("No hay corridas grabadas en eval/resultados/: lanza scripts/eval --vivo.");
}
