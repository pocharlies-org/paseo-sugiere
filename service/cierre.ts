// La gramática del cierre de un turno, en TS: lo que el autopilot lee para decidir. Es una copia DECLARADA y permanente del
// parser del supervisor (x86-host-runtime: `company_runtime.esperas_de`/`paras_de`, `company-sesion` `estado_de`,
// `jira-epic-trigger.DINERO_RE`), que sigue vivo para el hook `Stop` y el barrido. La fuente de verdad es esa y su
// `CIERRE_PASEO`; `test/fixtures/cierre.json` es el corpus que las dos suites deben pasar igual (plan del autopilot, §3.2).
// Puro: texto dentro, datos fuera.

export type Espera = { tipo: string; linea: string; ts?: number }; // `ts`: el instante de una `fecha` (epoch ms)

const ESPERA_RE = /^[ \t]*(?:[-*>•]+[ \t]*)?[`*_]*ESPERA[`*_]*[ \t]*:[`*_]*[ \t]*(ci|merge|review|run|argocd|fichero|jira|sesion)[ \t]+([^\n→]+?)[ \t]*(?:(?:→|->)[ \t]*(.*?))?[ \t]*$/gim;
const FECHA_RE = /^[ \t]*(?:[-*>•]+[ \t]*)?[`*_]*ESPERA[`*_]*[ \t]*:[`*_]*[ \t]*fecha[ \t]+(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?Z?[ \t]*(?:(?:→|->)[ \t]*(.*?))?[ \t]*$/gim;
const PARA_RE = /^[ \t>*_`-]*PARA (DANI|IT|SECURITY|QA)[^\n:]{0,20}:/gim;
const ESTADO_RE = /^[ \t>*_`-]*ESTADO[ \t*_`]*:[ \t*_`]*(ENTREGA|PREGUNTA|BLOQUEO)\b[ \t*_`]*:?[ \t]*(.*)$/gim;
/** La regla del supervisor: a Dani solo le espera el dinero, y lo dice el importe, no la etiqueta. */
export const DINERO_RE = /\d[\d.,]*[ \t]*(?:€|\$|eur(?:os?)?\b|usd\b|dólares?\b)|[€$][ \t]*\d/i;
/** La última línea con que el autopilot cierra la sesión: clave y URL reales (un `<KEY> <url>` de ejemplo no cierra nada) y
 * SOLO como último renglón no vacío del turno (Dani 11-11: citado a mitad de turno no es un cierre — archivaría sesiones vivas).
 * `ENTREGADO` = encargo hecho; `APLAZADO` = la espera larga sigue en un ticket programado. */
const CIERRE_RE = /^[ \t>*_`-]*AUTOPILOT[ \t*_`]*:[ \t*_`]*(ENTREGADO|APLAZADO)[ \t*_`]+([A-Z][A-Z0-9_]+-\d+)[ \t`*_]+(https?:\/\/\S+?)[`*_.,;)]*[ \t]*$/;

const PR = /^[\w.-]+\/[\w.-]+#\d+$/;
// The coordinator waits for a registered producer; UUIDs use the daemon's lowercase representation.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJETIVO: Record<string, RegExp> = { ci: PR, merge: PR, review: PR, run: /^[\w.-]+\/[\w.-]+$/,
  argocd: /^[a-z0-9][a-z0-9.-]*$/, fichero: /^(\/|~)/, jira: /^[A-Z][A-Z0-9_]+-\d+$/, sesion: UUID };

// `str.strip("`*_,;.")` de Python: quita esos caracteres por los dos lados.
const limpia = (s: string, chars: string) => {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
};

/** Las `ESPERA:` vigilables, sin repetir (`esperas_de`). Una línea sin objetivo concreto no se puede vigilar: se ignora. */
export function esperasDe(texto: string): Espera[] {
  const out: Espera[] = [];
  const vistos = new Set<string>();
  for (const m of (texto || "").matchAll(ESPERA_RE)) {
    const tipo = m[1]!.toLowerCase();
    let args = m[2]!.split(/\s+/).filter(Boolean).map((a) => limpia(a, "`*_,;.")).slice(0, 2);
    if (!args.length || !args[0]) continue;
    if (!OBJETIVO[tipo]!.test(args[0]) || (tipo === "run" && !(args.length > 1 && /^\d+$/.test(args[1]!)))) continue;
    args = tipo === "run" || tipo === "argocd" ? args : args.slice(0, 1);
    const linea = `${tipo} ${args.join(" ")}`;
    if (vistos.has(linea)) continue;
    vistos.add(linea);
    out.push({ tipo, linea });
  }
  for (const m of (texto || "").matchAll(FECHA_RE)) {
    const [dia, hh, mm] = [m[1]!, m[2], m[3]];
    const [a, mes, d] = dia.length === 10 ? [Number(dia.slice(0, 4)), Number(dia.slice(5, 7)), Number(dia.slice(8, 10))]
      : [new Date().getUTCFullYear(), Number(dia.slice(3, 5)), Number(dia.slice(0, 2))];
    const f = new Date(Date.UTC(a, mes - 1, d, Number(hh ?? 0), Number(mm ?? 0)));
    // `datetime(...)` de Python rechaza un día o una hora imposibles; Date los desborda: se comprueba a la vuelta.
    if (f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== d || Number(hh ?? 0) > 23 || Number(mm ?? 0) > 59) continue;
    out.push({ tipo: "fecha", linea: `fecha ${dia}${hh ? ` ${hh}:${mm}Z` : ""}`, ts: f.getTime() });
  }
  return out;
}

/** Cada `PARA <quién>:` con sus párrafos, en el orden DANI, SECURITY, QA, IT (`paras_de`). */
export function parasDe(texto: string): { quien: string; texto: string }[] {
  const quien = new Set([...(texto || "").matchAll(PARA_RE)].map((m) => m[1]!.toUpperCase()));
  return ["DANI", "SECURITY", "QA", "IT"].filter((q) => quien.has(q)).map((q) => ({
    quien: q,
    texto: [...texto.matchAll(new RegExp(
      `^[ \\t>*_\`-]*PARA ${q}[^\\n:]{0,20}:[^\\n]*(?:\\n(?![ \\t]*\\n|[ \\t>*_\`-]*PARA (?:DANI|IT|SECURITY|QA)\\b)[^\\n]*)*`, "gim"))]
      .map((m) => m[0].trim()).join("\n"),
  }));
}

/** La etiqueta y el detalle de la última línea `ESTADO:` (en los últimos 4000 caracteres, como `estado_de`). */
export function estadoDe(texto: string): [string | null, string] {
  const ms = [...(texto || "").slice(-4000).matchAll(ESTADO_RE)];
  const m = ms[ms.length - 1];
  return m ? [m[1]!.toUpperCase(), limpia(m[2]!.trim(), "`*_ ")] : [null, ""];
}

const cierreDe = (palabra: string) => (texto: string): { key: string; url: string } | null => {
  const ultima = (texto || "").split("\n").filter((l) => l.trim()).at(-1) ?? "";
  const m = ultima.match(CIERRE_RE);
  return m && m[1] === palabra ? { key: m[2]!, url: m[3]! } : null;
};
export const entregadoDe = cierreDe("ENTREGADO");
export const aplazadoDe = cierreDe("APLAZADO");

type Entrada = { type?: string; isMeta?: boolean; timestamp?: string; message?: { role?: string; content?: unknown } };
const entradas = (lines: string[]): Entrada[] => lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

/** Un mensaje de usuario real: texto y ningún resultado de herramienta (la misma regla que `ultimo_turno`). */
function textoDeUsuario(e: Entrada): string | null {
  if (e.type !== "user") return null;
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c) || c.some((b) => b?.type === "tool_result") || !c.some((b) => b?.type === "text")) return null;
  return c.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n");
}

/** Lo que el asistente escribió tras el último mensaje real del usuario (`ultimo_turno`). */
export function ultimoTurno(lines: string[]): string {
  let textos: string[] = [];
  for (const e of entradas(lines)) {
    if (textoDeUsuario(e) !== null) textos = [];
    else if (e.type === "assistant" && Array.isArray(e.message?.content))
      textos.push(...(e.message!.content as any[]).filter((b) => b?.type === "text" && b.text).map((b) => String(b.text)));
  }
  return textos.join("\n");
}

export const PREFIJO = "[AUTOPILOT] ";

export type Racha = { seguidos: number; total: number; humanos: number; eventos: number; ultimo: string; desde: string | null };

/** Cuenta los mensajes del autopilot en el transcript entero (sin estado: la cuenta ES el transcript). `seguidos` vuelve a 0 con
 * un mensaje humano o un `EVENTO:`; `humanos` y `eventos` cuentan desde el primer mensaje del autopilot. Lo que manda el sistema
 * (supervisor, hooks, recordatorios) no es humano. */
export function racha(lines: string[]): Racha {
  const r: Racha = { seguidos: 0, total: 0, humanos: 0, eventos: 0, ultimo: "", desde: null };
  for (const e of entradas(lines)) {
    const t = textoDeUsuario(e)?.trim();
    if (!t || e.isMeta) continue;
    if (t.startsWith(PREFIJO.trim())) {
      r.total++; r.seguidos++; r.ultimo = t; r.desde ??= e.timestamp ?? null;
    } else if (t.startsWith("EVENTO:")) {
      r.seguidos = 0; if (r.desde) r.eventos++;
    } else if (!/^(RETOMA:|\[SUPERVISOR\]|Stop hook feedback|<)/.test(t)) {
      r.seguidos = 0; if (r.desde) r.humanos++;
    }
  }
  return r;
}
