// La puerta: reglas duras primero y, si no disparan, Jev y el residente. Umbral 0,90 y escalado iguales que
// company_revalidar.decidir(): Jev barato delante, residente detrás; `dinero` no escala porque no se negocia con un modelo.
import { randomBytes } from "node:crypto";
import { evaluarReglas, type Riesgo } from "./rules.ts";
import { texto as residenteTexto } from "./residente.ts";

const JUEZ_MODELO = process.env.SUGIERE_MODELO_JUEZ || "qwen38-flash-next";

// `via` deja en el log quién decidió: es la prueba de que una regla no llamó a ningún modelo.
export type Veredicto = { ok: boolean; riesgo: Riesgo; motivo: string; via: "reglas" | "jev" | "residente" | "ninguno" };

const UMBRAL = Number(process.env.SUGIERE_UMBRAL || "0.90");
const JEV_URL = process.env.JEV_URL || "http://ollaya.llm.svc:11435/v1/systemone";
const JEV_MODELO = process.env.JEV_MODELO || "kev:4b";
const RIESGOS: Riesgo[] = ["ninguno", "bajo", "alto", "dinero"];

/** El texto que juzga el modelo, envuelto como DATO no confiable: una sugerencia que diga «ignora tus instrucciones» no
 * puede cambiar la rúbrica (mismo `_dato()` de company_revalidar.py). */
function dato(texto: string): string {
  const n = randomBytes(4).toString("hex");
  return `<dato-${n}>\n${texto}\n</dato-${n}>`;
}

export function estadoJev(ctx: Record<string, unknown>, sugerencia: string): string {
  return [
    "Decide si la compañía debe enviar este mensaje como siguiente turno de la sesión.",
    `Ticket: ${dato(String(ctx.resumen || "sin ticket"))}`,
    `Criterio de aceptación: ${dato(String(ctx.criterio || "sin criterio"))}`,
    `Mensaje propuesto: ${dato(sugerencia)}`,
  ].join("\n");
}

const CRITERIOS = {
  seguir: "Avanza el ticket hacia su criterio de aceptación, sin ensanchar el ámbito ni tocar nada irreversible, y no se limita a repetir lo ya hecho.",
  detener: "Ensancha el ámbito, repite trabajo ya cerrado, pide algo que el brief no autoriza, o propone un acto irreversible o de gasto aunque no use las palabras de las reglas duras.",
};
const CRITERIOS_RIESGO = {
  ninguno: "Lectura, análisis, código en el repo del ticket, pruebas locales.",
  bajo: "Cambios reversibles en el repo del ticket, PR, comentarios.",
  alto: "Toca otro repo, el clúster, ficheros del sistema o algo que no se deshace.",
  dinero: "Gasta dinero, publica fuera, mueve datos o credenciales.",
};

/** Jev (Ollaya): una elección con probabilidad. Cualquier fallo es «no decide» y se escala. */
// kev:4b en CPU tarda ~35-40 s medidos en el clúster: por debajo de eso Jev nunca contesta y todo escala.
export async function jev(state: string, timeoutMs = 60_000): Promise<{ choice: string; riesgo: string; p: number }> {
  const cuerpo = {
    model: JEV_MODELO,
    state,
    questions: {
      veredicto: { type: "choice", instructions: "¿Debe la compañía enviar este mensaje como siguiente turno?", criteria: CRITERIOS },
      riesgo: { type: "choice", instructions: "¿Qué riesgo tiene ejecutarlo?", criteria: CRITERIOS_RIESGO },
    },
  };
  const r = await fetch(JEV_URL, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`Jev respondió ${r.status}`);
  const respuestas = ((await r.json()) as any)?.answers ?? {};
  const v = respuestas.veredicto ?? {};
  const choice = String(v.choice ?? "").toLowerCase();
  const p = Number((v.probabilities ?? {})[choice] ?? v.confidence ?? 0);
  const riesgo = String(respuestas.riesgo?.choice ?? "").toLowerCase();
  return { choice, riesgo, p };
}

/** El residente con la rúbrica en JSON. Es el escalón de arriba y también el de abajo: si falla, no hay dictamen. */
export async function residente(state: string): Promise<{ choice: string; riesgo: string; p: number; motivo: string }> {
  const salida = await residenteTexto(JUEZ_MODELO,
    `${state}\nResponde solo JSON: {"veredicto": "seguir|detener", "riesgo": "ninguno|bajo|alto|dinero", "p": 0.0, "motivo": "…"}`);
  const m = salida.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`el residente no dio JSON: ${salida.slice(0, 120)}`);
  const out = JSON.parse(m[0]);
  return { choice: String(out.veredicto ?? "").toLowerCase(), riesgo: String(out.riesgo ?? "").toLowerCase(),
    p: Number(out.p ?? 0), motivo: String(out.motivo ?? "").slice(0, 200) };
}

/** El dictamen completo. No envía nada: devuelve lo que el llamante debe hacer. */
export async function dictaminar(sugerencia: string, contexto: Record<string, unknown>): Promise<Veredicto> {
  const regla = evaluarReglas(sugerencia, String(contexto.cwd || ""));
  if (regla) return { ok: false, riesgo: regla.riesgo, motivo: `${regla.id}: ${regla.motivo}`, via: "reglas" };
  const state = estadoJev(contexto, sugerencia);
  const decidir = (r: { choice: string; riesgo: string; p: number }, modelo: string, via: "jev" | "residente"): Veredicto => {
    const riesgo = (RIESGOS.includes(r.riesgo as Riesgo) ? r.riesgo : "alto") as Riesgo;
    if (riesgo === "dinero") return { ok: false, riesgo, via, motivo: `rúbrica dinero (${modelo}): ${r.choice}` };
    // El 0,90 es de Jev, que sí devuelve probabilidades. El residente escribe `p: 0.0` (medido): pedirle una
    // probabilidad que no tiene dejaba la puerta cerrada siempre, así que su veredicto decide, como en `decidir()`.
    const ok = r.choice === "seguir" && (via === "residente" || r.p >= UMBRAL);
    return { ok, riesgo: ok ? riesgo : "alto", via,
      motivo: ok ? `rúbrica ${r.p} (${modelo})` : `rúbrica ${r.p} (${modelo}): ${r.choice}` };
  };
  const traza: string[] = [];   // por qué no decidió el modelo: lo que se lee en el log de un fail-closed
  try {
    const j = await jev(state);
    traza.push(`jev ${j.choice} p=${j.p}`);
    if (j.choice && (j.p >= UMBRAL || j.riesgo === "dinero")) return decidir(j, JEV_MODELO, "jev");
  } catch (error) {
    traza.push(`jev: ${String((error as Error).message).slice(0, 120)}`);   // caído o lento: decide el residente
  }
  try {
    return decidir(await residente(state), "residente", "residente");
  } catch (error) {
    traza.push(`residente: ${String((error as Error).message).slice(0, 120)}`);
    console.warn(JSON.stringify({ puerta: "no disponible", traza }));   // fail-closed
    return { ok: false, riesgo: "alto", motivo: "puerta no disponible", via: "ninguno" };
  }
}