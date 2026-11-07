// El autopilot: al acabar cada turno, UNA acción para el llamante — enviar · esperar · humano · cerrar. Toda la lógica vive
// aquí (Dani, 07-11): el plugin de Paseo y el supervisor solo obedecen. Sin estado: la racha, la fase anterior y el cierre del
// turno salen del transcript; lo determinista decide antes que cualquier modelo. Spec: docs/servicio-sugiere.md §12.
import { readFileSync } from "node:fs";
import { type Plan, SUGGEST_WAIT_MS } from "../shared/suggest.ts";
import { transcriptMessages } from "../shared/transcript.ts";
import { DINERO_RE, PREFIJO, entregadoDe, esAlcance, esperasDe, estadoDe, parasDe, racha, ultimoTurno, type Racha } from "./cierre.ts";
import { dictaminar, type Veredicto } from "./juez.ts";
import { sugerir } from "./residente.ts";

const RUTA_TOPES = process.env.AUTOPILOT_FICHERO || "/etc/sugiere/autopilot.json";
const TOPES = { max_seguidos: 15, max_total: 40 }; // decisión 3 de Dani (07-11)

/** Los topes, releídos del fichero montado en cada petición (como `brain.json`): cambiarlos no reinicia el pod. */
export function topes(ruta: string = RUTA_TOPES): typeof TOPES {
  try {
    const j = JSON.parse(readFileSync(ruta, "utf8"));
    const n = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : d);
    return { max_seguidos: n(j?.max_seguidos, TOPES.max_seguidos), max_total: n(j?.max_total, TOPES.max_total) };
  } catch {
    return { ...TOPES };
  }
}

export type Accion = "enviar" | "esperar" | "humano" | "cerrar";
export type Fase = "arranque" | "devolver" | "entregar" | "seguir" | "desvio";
export type Decision = { accion: Accion; motivo: string; mensaje?: string; fase?: Fase; riesgo?: string; modelo?: string;
  via?: Veredicto["via"]; traza?: string[]; pasos: { seguidos: number; total: number } };
export type Contexto = { kind?: string; cwd: string; key?: string; plan?: Plan | null };

/** El modelo o la puerta no contestaron: el servidor responde 503 y el llamante reintenta una vez (no hay respaldo local). */
export class SinServicio extends Error {}

// Las plantillas: texto fijo, sin modelo. Su primera frase es la marca con la que se reconoce la fase en el transcript.
const ARRANQUE = `${PREFIJO}Autopilot activado: llevo yo esta sesión hasta la entrega.`;
const DEVOLVER = `${PREFIJO}Tu \`PARA DANI\` no es dinero: con el autopilot no le llega a Dani.`;
const DESVIO = `${PREFIJO}El paso que tocaba no se autoenvía`;
const ENTREGAR = `${PREFIJO}El encargo está hecho: toca la entrega del autopilot.`;
const CIERRES = "Acaba cada turno como siempre: `ESPERA:`, `PARA …:` o `ESTADO: ENTREGA`.";

function arranque(): string {
  return [ARRANQUE,
    "Si esta tarea no tiene ticket, créalo ahora en vivo (skill `clasificar-trabajo`) con criterios verificables `- [ ]`, y sigue.",
    "Si tu último turno preguntaba algo que no es dinero, decide tú la opción recomendada y déjala como `DECISIÓN TOMADA: …`.",
    "Lo que solo IT, security o qa pueden darte: coméntalo en el ticket con `PARA IT:`/`PARA SECURITY:`/`PARA QA:` y una línea `Paseo: $PASEO_AGENT_ID`.",
    CIERRES].join(" ");
}

function devolver(esperas: number): string {
  return [DEVOLVER, "Elige tú la opción recomendada, déjala escrita como `DECISIÓN TOMADA: …` y sigue.",
    "Si es un cambio de alcance o de diseño del encargo, ciérralo con `PARA DANI (alcance): …`; si es dinero, la línea lleva el importe.",
    ...(esperas ? ["Tus `ESPERA:` siguen en pie: decláralas otra vez al acabar."] : []), CIERRES].join(" ");
}

const desvio = (motivo: string) =>
  `${DESVIO} (${motivo}). Busca una vía reversible para avanzar; si no la hay, cierra con \`PARA DANI:\` y por qué.`;

function duracion(desde: string | null): string {
  const ms = desde ? Date.now() - Date.parse(desde) : NaN;
  if (!Number.isFinite(ms) || ms < 0) return "un tiempo sin medir";
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function entregar(r: Racha, modelo: string, key: string): string {
  const ticket = key ? ` ${key}` : "";
  return [ENTREGAR,
    "1. Limpia lo tuyo: tu worktree por su ruta exacta y las ramas ya fusionadas.",
    "2. Carga la skill `artifact-s3` y construye UN artifact (si no eres Opus, encárgaselo a un `Agent` con `model: \"opus\"` y los datos en un fichero). " +
      "Insignia visible «Generado con autopilot» y tres bloques: **Negocio** (qué problema había, qué cambia y para quién, valor, coste y tiempo, riesgos, qué queda fuera); " +
      "**Técnico** (arquitectura del cambio, PRs y commits, despliegue verificado con su evidencia —imagen viva, Synced/Healthy, llamada real—, pruebas, cómo revertir); " +
      `**Traza del autopilot**: ${r.total} pasos del autopilot, ${r.eventos} esperas resueltas, ${duracion(r.desde)} desde que se activó, modelo ${modelo || "sin medir"}, ${r.humanos} intervenciones humanas.`,
    `3. Publícalo con \`publish_html\` (LAN, 7 días) y adjúntalo al ticket${ticket} con \`jira_rest.py upload <KEY> <fichero> --como 92-autopilot.html\` (como mucho 2 MiB; la URL publicada va además como enlace).`,
    "4. En el ticket: etiquetas `autopilot` y `entrega-<tipo>` (uno de: codigo, infra, datos, documento, investigacion, operacion), el resumen de entrega con `prompts/resumen-entrega.md` y la transición a Done.",
    "5. Acaba el turno con `ESTADO: ENTREGA` y, en la última línea, `AUTOPILOT: ENTREGADO <KEY> <url del artifact>`: el autopilot cierra y archiva la sesión."].join("\n");
}

const criterios = (plan: Plan | null | undefined) => (Array.isArray(plan?.criterios) ? plan!.criterios! : []);
const todoVerificado = (plan: Plan | null | undefined) =>
  criterios(plan).length > 0 && criterios(plan).every((c) => String(c?.status ?? "").toLowerCase().startsWith("verificad"));

/** La decisión de un turno cerrado. `nativa`: la sugerencia que el daemon ya bifurcó de la caché de la sesión (ahorra la llamada). */
export async function decidir(lines: string[], ctx: Contexto, nativa = ""): Promise<Decision> {
  const texto = ultimoTurno(lines);
  const r = racha(lines);
  const pasos = { seguidos: r.seguidos, total: r.total };
  const plan = criterios(ctx.plan).length ? ctx.plan! : null; // un plan sin criterios no ancla (decisión 2 de «Garantizar plan»)
  const key = ctx.key || plan?.ticket || plan?.ticketKey || "";
  const fin = (accion: Accion, motivo: string, extra: Partial<Decision> = {}): Decision => ({ accion, motivo, pasos, ...extra });
  const envia = (fase: Fase, mensaje: string, motivo: string, extra: Partial<Decision> = {}) =>
    fin("enviar", motivo, { fase, mensaje, ...extra });

  // 1. La entrega ya está hecha: se cierra (el plugin archiva).
  const entregado = entregadoDe(texto);
  if (entregado) return fin("cerrar", `entregado ${entregado.key}: ${entregado.url}`);
  if (!texto.trim()) return fin("esperar", "el turno no dejó texto (lo retoma el supervisor)");

  // 2. Lo que espera a Dani: dinero o un cambio de alcance (decisión 1) paran; lo demás vuelve a la sesión, como en el supervisor.
  const [etiqueta, detalle] = estadoDe(texto);
  const dani = parasDe(texto).find((p) => p.quien === "DANI")?.texto
    ?? (etiqueta === "PREGUNTA" || etiqueta === "BLOQUEO" ? detalle || etiqueta : null);
  if (dani !== null && esAlcance(texto)) return fin("humano", "cambio de alcance o diseño: lo decide Dani", { riesgo: "alto" });
  if (dani !== null && DINERO_RE.test(dani)) return fin("humano", `dinero: ${dani.slice(0, 160)}`, { riesgo: "dinero" });

  // 3. Lo que espera fuera lo despierta el supervisor con EVENTO (una `ESPERA: fichero` no despierta a nadie en Paseo).
  const esperas = esperasDe(texto).filter((e) => e.tipo !== "fichero");
  if (dani === null && esperas.length) return fin("esperar", esperas.map((e) => e.linea).join(", "));
  const otros = parasDe(texto).filter((p) => p.quien !== "DANI");
  if (dani === null && otros.length) return fin("esperar", `PARA ${otros.map((p) => p.quien).join("/")}: lo despierta el supervisor`);

  // 4. A partir de aquí se envía algo: antes, los topes (decisión 3).
  const t = topes();
  if (r.seguidos >= t.max_seguidos) return fin("humano", `tope: ${r.seguidos} pasos seguidos sin ESPERA, EVENTO ni entrega`);
  if (r.total >= t.max_total) return fin("humano", `tope: ${r.total} pasos del autopilot en esta sesión`);
  const antes = r.seguidos ? r.ultimo : ""; // la fase anterior solo cuenta dentro de la racha: tras Dani o un EVENTO, no insiste nadie

  // 5. El primer paso sin plan anclado: el ticket primero (decisión 4).
  if (!r.total && !plan) return envia("arranque", arranque(), "primer paso sin ticket anclado");

  // 6. La pregunta a Dani que no es dinero vuelve a la sesión; si insiste justo después, la ve una persona.
  if (dani !== null) {
    if (antes.startsWith(DEVOLVER)) return fin("humano", `insiste en preguntar a Dani: ${dani.slice(0, 160)}`, { riesgo: "alto" });
    return envia("devolver", devolver(esperas.length), "PARA DANI sin dinero: decide la sesión");
  }

  // 7. Hecho: con plan, solo si todos sus criterios están verificados.
  const modelo = transcriptMessages(lines).model ?? "";
  if ((etiqueta === "ENTREGA" && !plan) || todoVerificado(plan)) {
    if (antes.startsWith(ENTREGAR)) return fin("humano", "la entrega se pidió y el turno no la cerró con AUTOPILOT: ENTREGADO");
    return envia("entregar", entregar(r, modelo, key), plan ? "todos los criterios verificados" : "ESTADO: ENTREGA");
  }

  // 8. Lo demás: el modelo propone el paso y la puerta lo dictamina.
  let paso = "", quien = "";
  if (nativa.trim() && !plan) [paso, quien] = [nativa.trim(), "nativa"];
  else {
    try {
      const s = await sugerir(lines, SUGGEST_WAIT_MS, ctx.kind ?? "", plan);
      [paso, quien] = [s.texto.trim(), s.modelo];
    } catch (e) {
      throw new SinServicio(`el modelo no contestó: ${String((e as Error).message).slice(0, 160)}`);
    }
  }
  if (!paso) return fin("humano", "el turno no cierra y el modelo no propone nada", { modelo: quien });
  if (antes === `${PREFIJO}${paso}`) return fin("humano", "el autopilot repetiría el mismo paso", { modelo: quien });
  const resumen = plan?.objetivo ?? "";
  const criterio = criterios(plan).map((c, i) => `C${i + 1} ${c?.texto ?? ""}`).join("\n");
  const v = await dictaminar(paso, { cwd: ctx.cwd, key, resumen, criterio });
  const puerta = { riesgo: v.riesgo, via: v.via, modelo: quien, ...(v.traza ? { traza: v.traza } : {}) };
  if (v.via === "ninguno") throw new SinServicio(`puerta no disponible: ${(v.traza ?? []).join("; ").slice(0, 160)}`);
  if (v.ok) return envia("seguir", `${PREFIJO}${paso}`, v.motivo, puerta);
  if (v.riesgo === "dinero") return fin("humano", `dinero: ${v.motivo}`, puerta);
  if (antes.startsWith(DESVIO)) return fin("humano", `segundo paso vetado seguido: ${v.motivo}`, puerta);
  return envia("desvio", desvio(v.motivo), v.motivo, puerta);
}
