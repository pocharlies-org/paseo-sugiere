// El autopilot: al acabar cada turno, UNA acción para el llamante — enviar · esperar · humano · cerrar. Toda la lógica vive
// aquí (Dani, 07-11): el plugin de Paseo y el supervisor solo obedecen. Sin estado: la racha, la fase anterior y el cierre del
// turno salen del transcript; lo determinista decide antes que cualquier modelo. Spec: docs/servicio-sugiere.md §12.
import { readFileSync } from "node:fs";
import { type Plan, SUGGEST_WAIT_MS } from "../shared/suggest.ts";
import { transcriptMessages } from "../shared/transcript.ts";
import { DINERO_RE, PREFIJO, aplazadoDe, entregadoDe, esAlcance, esperasDe, type Espera, estadoDe, parasDe, racha, ultimoTurno, type Racha } from "./cierre.ts";
import { dictaminar, type Veredicto } from "./juez.ts";
import { sugerir } from "./residente.ts";

const RUTA_TOPES = process.env.AUTOPILOT_FICHERO || "/etc/sugiere/autopilot.json";
// 0 = sin tope (Dani, 07-11: «si es autopilot es autopilot»); el que manda es el ajuste del llamante (`contexto.topes`).
export type Topes = { max_seguidos: number; max_total: number };
const SIN_TOPE: Topes = { max_seguidos: 0, max_total: 0 };
const entero = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : d);

/** Los topes: los del llamante si los manda; si no, los del fichero montado, releído en cada petición (como `brain.json`);
 * sin fichero, ninguno. Un valor que no sea un entero ≥ 0 cae al de la capa de debajo. */
export function topes(delLlamante?: Partial<Topes> | null, ruta: string = RUTA_TOPES): Topes {
  let base = SIN_TOPE;
  try {
    const j = JSON.parse(readFileSync(ruta, "utf8"));
    base = { max_seguidos: entero(j?.max_seguidos, 0), max_total: entero(j?.max_total, 0) };
  } catch { /* sin fichero: sin tope */ }
  return { max_seguidos: entero(delLlamante?.max_seguidos, base.max_seguidos), max_total: entero(delLlamante?.max_total, base.max_total) };
}

export type Accion = "enviar" | "esperar" | "humano" | "cerrar";
export type Fase = "arranque" | "devolver" | "entregar" | "aplazar" | "seguir" | "desvio";
export type Decision = { accion: Accion; motivo: string; mensaje?: string; fase?: Fase; riesgo?: string; modelo?: string;
  via?: Veredicto["via"]; traza?: string[]; pasos: { seguidos: number; total: number } };
export type Contexto = { kind?: string; cwd: string; key?: string; plan?: Plan | null; topes?: Partial<Topes> | null };

/** El modelo o la puerta no contestaron: el servidor responde 503 y el llamante reintenta una vez (no hay respaldo local). */
export class SinServicio extends Error {}

// Las plantillas: texto fijo, sin modelo (el `arranque` lleva delante, si lo hay, el paso que aprobó la puerta). Su primera
// frase, tras ese paso en el `arranque`, es la marca con la que se reconoce la fase en el transcript.
const ARRANQUE = `${PREFIJO}Autopilot activado: llevo yo esta sesión hasta la entrega.`;
const DEVOLVER = `${PREFIJO}Tu \`PARA DANI\` no es dinero: con el autopilot no le llega a Dani.`;
const DESVIO = `${PREFIJO}El paso que tocaba no se autoenvía`;
const ENTREGAR = `${PREFIJO}El encargo está hecho: toca la entrega del autopilot.`;
const APLAZAR = `${PREFIJO}Lo que esperas es una fecha lejana: esta sesión no se queda abierta esperándola.`;
/** Dani, 09-11: «que no se quede una sesión esperando 2 días»; «si es 2 h ya sería suficiente». Una espera solo de fecha a más de esto se aplaza. */
const APLAZAR_DESDE_MS = 2 * 3600_000;
// SC-5494 (Dani, 13-11): «no parar hasta tener el plan entero»; el supervisor bloquea la ENTREGA con tareas abiertas.
const CIERRES = "No pares mientras quede una tarea de tu plan. Cierra el turno con `ESPERA:` o `PARA …:` si lo que falta depende "
  + "de fuera, y con `ESTADO: ENTREGA` solo con todas las tareas hechas y probadas.";

/** Con `paso` (el que la puerta aprobó), el paso va delante y la plantilla detrás, con un solo prefijo. */
function arranque(paso = ""): string {
  const plantilla = [ARRANQUE,
    "Si esta tarea no tiene ticket, créalo ahora en vivo (skill `clasificar-trabajo`) con criterios verificables `- [ ]`, y sigue.",
    "Si tu último turno preguntaba algo que no es dinero, decide tú la opción recomendada y déjala como `DECISIÓN TOMADA: …`.",
    "Lo que solo IT, security o qa pueden darte: coméntalo en el ticket con `PARA IT:`/`PARA SECURITY:`/`PARA QA:` y una línea `Paseo: $PASEO_AGENT_ID`.",
    CIERRES].join(" ");
  return paso ? `${PREFIJO}${paso}\n\n${plantilla.slice(PREFIJO.length)}` : plantilla;
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

/** El `programada-AAAA-MM-DDTHH:MM` del supervisor (contrato `jira.etiquetas.programada`): la hora de Madrid. */
export const etiquetaProgramada = (ts: number) =>
  `programada-${new Date(ts).toLocaleString("sv-SE", { timeZone: "Europe/Madrid", hour12: false }).slice(0, 16).replace(" ", "T")}`;

/** En `live`, la espera hecha solo de fechas cuya primera queda lejos: mejor un ticket programado que una sesión abierta. */
function aplazable(esperas: Espera[], kind = ""): number | null {
  if (kind !== "live" || !esperas.length || esperas.some((e) => e.tipo !== "fecha" || e.ts === undefined)) return null;
  const ts = Math.min(...esperas.map((e) => e.ts!));
  return ts - Date.now() >= APLAZAR_DESDE_MS ? ts : null;
}

function aplazar(ts: number, key: string): string {
  const actual = key || "el ticket de esta sesión";
  return [`${APLAZAR} Pasa el trabajo a un ticket que el supervisor arranca a su hora, y cierra.`,
    "1. Crea el ticket que lo retoma (skill `clasificar-trabajo`): sin asignar, en To Do, con `jira_rest.py crear … --rol cto` y la descripción por stdin: " +
      `lo hecho (PRs, commits, evidencia), dónde quedó, el paso que toca en esa fecha (el \`→\` de tu \`ESPERA\`), criterios \`- [ ]\` verificables y, el último, cerrar ${actual}.`,
    `2. Etiquétalo con \`jira_rest.etiqueta_add\` (\`JIRA_ROL=cto\`), PRIMERO \`${etiquetaProgramada(ts)}\` (hora de Madrid) y DESPUÉS \`cola-compania\`: sin la fecha delante, el supervisor lo lanzaría ya.`,
    `3. \`jira_rest.py enlazar <NUEVA> ${key || "<ACTUAL>"} --tipo Blocks\` y comenta en ${actual} el informe de lo hecho y la clave nueva.`,
    "4. Limpia lo tuyo: tu worktree por su ruta exacta (la rama con PR abierta se queda).",
    "5. Acaba el turno con, en la última línea, `AUTOPILOT: APLAZADO <NUEVA> <url del ticket nuevo>`: el autopilot cierra y archiva esta sesión."].join("\n");
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
  const key = ctx.key || ctx.plan?.ticket || ctx.plan?.ticketKey || ""; // la clave vale aunque el ancla no tenga criterios
  const fin = (accion: Accion, motivo: string, extra: Partial<Decision> = {}): Decision => ({ accion, motivo, pasos, ...extra });
  const envia = (fase: Fase, mensaje: string, motivo: string, extra: Partial<Decision> = {}) =>
    fin("enviar", motivo, { fase, mensaje, ...extra });
  // El paso que propone el modelo (la nativa, si viene y no hay plan, ahorra la llamada) y el dictamen de la puerta: filas 5 y 8.
  const proponer = async (): Promise<[string, string]> => {
    if (nativa.trim() && !plan) return [nativa.trim(), "nativa"];
    try {
      const s = await sugerir(lines, SUGGEST_WAIT_MS, ctx.kind ?? "", plan);
      return [s.texto.trim(), s.modelo];
    } catch (e) {
      throw new SinServicio(`el modelo no contestó: ${String((e as Error).message).slice(0, 160)}`);
    }
  };
  const juzgar = async (paso: string, quien: string) => {
    const v = await dictaminar(paso, { cwd: ctx.cwd, key, resumen: plan?.objetivo ?? "",
      criterio: criterios(plan).map((c, i) => `C${i + 1} ${c?.texto ?? ""}`).join("\n") });
    return { v, puerta: { riesgo: v.riesgo, via: v.via, modelo: quien, ...(v.traza ? { traza: v.traza } : {}) } };
  };

  // 1. La entrega ya está hecha, o aplazada a un ticket programado: se cierra (el plugin archiva). Pero el cierre no archiva
  // una sesión que sigue esperando (Dani 11-11): con el marcador presente y alguna espera viva, lo ve una persona. En el
  // `APLAZADO` las `ESPERA: fecha` son justo las que se van al ticket programado: no cuentan como espera viva.
  const entregado = entregadoDe(texto);
  const aplazado = aplazadoDe(texto);
  const cierre = entregado ?? aplazado;
  if (cierre) {
    const vivas = esperasDe(texto).filter((e) => e.tipo !== "fichero" && !(aplazado && e.tipo === "fecha")).map((e) => e.linea);
    const paras = parasDe(texto).map((p) => `PARA ${p.quien}`);
    if (vivas.length || paras.length)
      return fin("humano", `cierra con AUTOPILOT: ${aplazado ? "APLAZADO" : "ENTREGADO"} y sigue esperando: ${[...vivas, ...paras].join(", ")}`);
    return fin("cerrar", entregado ? `entregado ${entregado.key}: ${entregado.url}` : `aplazado a ${cierre.key}: ${cierre.url}`);
  }
  if (!texto.trim()) return fin("esperar", "el turno no dejó texto (lo retoma el supervisor)");

  // 2. Lo que espera a Dani: dinero o un cambio de alcance (decisión 1) paran; lo demás vuelve a la sesión, como en el supervisor.
  const [etiqueta, detalle] = estadoDe(texto);
  const dani = parasDe(texto).find((p) => p.quien === "DANI")?.texto
    ?? (etiqueta === "PREGUNTA" || etiqueta === "BLOQUEO" ? detalle || etiqueta : null);
  if (dani !== null && esAlcance(texto)) return fin("humano", "cambio de alcance o diseño: lo decide Dani", { riesgo: "alto" });
  if (dani !== null && DINERO_RE.test(dani)) return fin("humano", `dinero: ${dani.slice(0, 160)}`, { riesgo: "dinero" });

  // 3. Lo que espera fuera lo despierta el supervisor con EVENTO (una `ESPERA: fichero` no despierta a nadie en Paseo). Una
  // `ESPERA: sesion` (coordinación de sesiones) solo espera en `live`: en la compañía nada reanuda al producer, y no se espera lo que no reanuda.
  // Una espera solo de fecha lejana, en live, no deja la sesión abierta: se aplaza a un ticket programado.
  const esperas = esperasDe(texto).filter((e) => e.tipo !== "fichero" && (e.tipo !== "sesion" || ctx.kind === "live"));
  const antes = r.seguidos ? r.ultimo : ""; // la fase anterior solo cuenta dentro de la racha: tras Dani o un EVENTO, no insiste nadie
  const lejos = dani === null ? aplazable(esperas, ctx.kind) : null;
  if (lejos !== null) {
    if (antes.startsWith(APLAZAR)) return fin("humano", "se pidió aplazar a un ticket programado y el turno no cerró con AUTOPILOT: APLAZADO");
    return envia("aplazar", aplazar(lejos, key), `espera solo de fecha (${esperas.map((e) => e.linea).join(", ")}): se aplaza`);
  }
  if (dani === null && esperas.length) return fin("esperar", esperas.map((e) => e.linea).join(", "));
  const otros = parasDe(texto).filter((p) => p.quien !== "DANI");
  if (dani === null && otros.length) return fin("esperar", `PARA ${otros.map((p) => p.quien).join("/")}: lo despierta el supervisor`);

  // 4. A partir de aquí se envía algo: antes, los topes que haya configurado quien llama (0 = sin tope).
  const t = topes(ctx.topes);
  if (t.max_seguidos && r.seguidos >= t.max_seguidos) return fin("humano", `tope: ${r.seguidos} pasos seguidos sin ESPERA, EVENTO ni entrega`);
  if (t.max_total && r.total >= t.max_total) return fin("humano", `tope: ${r.total} pasos del autopilot en esta sesión`);

  // 5. El primer paso sin plan anclado: el ticket primero (decisión 4). El autopilot se enciende con la sesión a medias (Dani,
  // 09-11): el paso que la puerta aprueba va delante de la plantilla. Sin él —sin paso, modelo o puerta, o vetado— la
  // plantilla sola, como antes: el arranque no se para por un modelo.
  if (!r.total && !key) {
    const [paso, quien] = await proponer().catch((): [string, string] => ["", ""]);
    const j = paso ? await juzgar(paso, quien) : null;
    if (j?.v.ok) return envia("arranque", arranque(paso), "primer paso sin ticket, con el paso propuesto", j.puerta);
    return envia("arranque", arranque(), "primer paso sin ticket");
  }

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
  const [paso, quien] = await proponer();
  if (!paso) return fin("humano", "el turno no cierra y el modelo no propone nada", { modelo: quien });
  if (antes === `${PREFIJO}${paso}`) return fin("humano", "el autopilot repetiría el mismo paso", { modelo: quien });
  const { v, puerta } = await juzgar(paso, quien);
  if (v.via === "ninguno") throw new SinServicio(`puerta no disponible: ${(v.traza ?? []).join("; ").slice(0, 160)}`);
  if (v.ok) return envia("seguir", `${PREFIJO}${paso}`, v.motivo, puerta);
  if (v.riesgo === "dinero") return fin("humano", `dinero: ${v.motivo}`, puerta);
  if (antes.startsWith(DESVIO)) return fin("humano", `segundo paso vetado seguido: ${v.motivo}`, puerta);
  return envia("desvio", desvio(v.motivo), v.motivo, puerta);
}
