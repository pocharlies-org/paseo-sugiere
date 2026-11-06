// El servicio: dos endpoints, sin estado y sin ficheros. /v1/suggest propone el siguiente mensaje y /v1/verdict dictamina si
// puede enviarse. No envía, no escribe tickets y no lee transcripts: todo lo que necesita llega en la petición.
// La auditoría (`/v1/auditoria`) es la única escritura: el registro de calidad de la puerta, en un JSONL.
import { createServer } from "node:http";
import { RUTA, MAX_BYTES, consultar, registrar, registrarCuando } from "./auditoria.ts";
import { BRAIN_URL, BANCO, modoBrain, recordar } from "./brain.ts";
import { cargarPesos, clasificar, sinEntrenar } from "./clasificador.ts";
import { clave, guardar as guardarCache, leer as leerCache } from "./cache.ts";
import { JUEZ_MODELO, dictaminar } from "./juez.ts";
import { LITELLM, RESERVA, sugerir } from "./residente.ts";
import { evaluarReglas } from "./rules.ts";

const PORT = Number(process.env.PORT || "8080");
const MAX_TRANSCRIPT = Number(process.env.MAX_TRANSCRIPT || String(32 * 1024 * 1024)); // el recorte de contexto (400k caracteres) lo hace shared/transcript.ts
const MAX_SUGERENCIA = 4000;
const MODO = process.env.SUGIERE_MODO || "sombra"; // sombra = hay servicio y veredictos, ningún llamante que actúe
// Sin token, el servicio se comporta como siempre (solo clúster); con token, cada petición lo lleva. La ruta LAN lo usa.
const TOKEN = process.env.SUGIERE_TOKEN || "";

type Cuerpo = Record<string, any>;

const json = (res: any, code: number, out: unknown) => {
  const text = JSON.stringify(out);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

function autorizado(req: any): boolean {
  if (!TOKEN) return true;
  const cabecera = String(req.headers.authorization || "");
  return cabecera === `Bearer ${TOKEN}`;
}

async function leer(req: any): Promise<Cuerpo> {
  let size = 0;
  const partes: Buffer[] = [];
  for await (const trozo of req) {
    size += trozo.length;
    if (size > MAX_TRANSCRIPT + 64 * 1024) throw new Error("cuerpo demasiado grande");
    partes.push(trozo);
  }
  return JSON.parse(Buffer.concat(partes).toString("utf8") || "{}");
}

const lineas = (transcript: string) => transcript.split("\n").filter((l) => l.trim());

async function suggest(body: Cuerpo) {
  const { sid, turno, transcript, contexto } = body;
  if (!sid || !turno || typeof transcript !== "string" || !transcript.trim()) return [422, { error: "faltan sid, turno o transcript" }];
  if (transcript.length > MAX_TRANSCRIPT) return [422, { error: `transcript > ${MAX_TRANSCRIPT} caracteres` }];
  try {
    // La instrucción llega del llamante (ConfigMap en el pod): una sola instrucción para todos, editable sin reiniciar.
    const { texto: sugerencia, modelo } = await sugerir(lineas(transcript), contexto?.instruccion ?? "", undefined, contexto?.kind ?? "");
    console.log(JSON.stringify({ modo: MODO, sid, turno, sugerencia: sugerencia.slice(0, 120) }));
    return [200, { sugerencia, modelo, ms: 0 }];
  } catch (error) {
    console.warn(JSON.stringify({ sid, turno, error: String((error as Error).message).slice(0, 200) }));
    return [503, { error: "el residente no contestó" }];
  }
}

async function verdict(body: Cuerpo) {
  const { sid, turno, sugerencia, contexto } = body;
  if (!sid || !turno || typeof sugerencia !== "string" || !sugerencia.trim()) return [422, { error: "faltan sid, turno o sugerencia" }];
  if (sugerencia.length > MAX_SUGERENCIA) return [422, { error: `sugerencia > ${MAX_SUGERENCIA} caracteres` }];
  if (!contexto?.cwd) return [422, { error: "falta contexto.cwd" }];

  // El brain: `off` no llama a nadie; `sombra` corre en paralelo y solo se audita; `on` entra en la rúbrica y se paga.
  const modo = modoBrain();
  const busqueda = modo === "off" ? null : recordar(sugerencia);

  const t0 = Date.now();
  // Las reglas se evalúan SIEMPRE, también con veredicto cacheado: ganan a lo guardado. Con el brain `on` no se cachea,
  // porque el dictamen depende de los recuerdos de ese momento.
  const k = clave(sid, turno, sugerencia);
  const cacheable = modo !== "on" && !evaluarReglas(sugerencia, String(contexto.cwd));
  const guardado = cacheable ? leerCache(k) : null;
  // En `on` los recuerdos se esperan dentro de la puerta, y solo si ninguna regla dura ha decidido ya.
  const v = guardado ? { ...guardado, traza: [...(guardado.traza ?? []), "cache"] }
    : await dictaminar(sugerencia, contexto,
      modo === "on" && busqueda ? busqueda.then((b) => b.recuerdos.map((r) => r.texto)) : undefined);
  if (!guardado) guardarCache(k, v);
  const ms = Date.now() - t0;

  // `ms` y `traza` son lo que permite auditar después un veredicto: cuánto tardó y, si cerró por caída, por qué.
  console.log(JSON.stringify({ modo: MODO, sid, turno, ms, ...v, sugerencia: sugerencia.slice(0, 120) }));

  // La auditoría se cierra cuando acaba el brain, sin retrasar la respuesta: la sugerencia va entera.
  const base = { ts: new Date().toISOString(), sid, turno, ms, ok: v.ok, riesgo: v.riesgo, motivo: v.motivo,
    via: v.via, traza: v.traza, cwd: String(contexto.cwd || ""),
    key: typeof contexto.key === "string" ? contexto.key : undefined, sugerencia };
  if (busqueda) registrarCuando(busqueda.then((b) => ({ modo, ms: b.ms, n: b.recuerdos.length, motivo: b.motivo })), base);
  else registrar(base);
  return [200, v];
}

// El clasificador barato, en sombra: se mide y se registra, pero no cambia lo que responde /v1/verdict. `decide: false`
// en el log y en la respuesta, para que nadie lo lea como una decisión de la puerta.
async function clasificarCuerpo(body: Cuerpo) {
  const { texto } = body;
  if (typeof texto !== "string" || !texto.trim()) return [422, { error: "falta texto" }];
  const r = await clasificar(texto);
  console.log(JSON.stringify({ modo: MODO, clasificador: "sombra", decide: false, etiqueta: r.etiqueta,
    p: r.p === null ? null : Number(r.p.toFixed(3)), ms: r.ms, motivo: r.motivo }));
  return [200, { ...r, decide: false }];
}

// La auditoría de calidad: los veredictos con su sugerencia entera, para etiquetarlos y comparar el brain contra el modelo.
function auditoria(url: string) {
  const q = new URL(url, "http://sugiere").searchParams;
  const ok = q.get("ok");
  return [200, consultar({
    limit: Number(q.get("limit") || "100"),
    desde: q.get("desde") || undefined,
    hasta: q.get("hasta") || undefined,
    ok: ok === null ? undefined : ok === "true",
    via: q.get("via") || undefined,
  })];
}

// La configuración EFECTIVA, para el dashboard: lo que este proceso ve de verdad. Los secretos solo se anuncian, no se leen.
function config() {
  const pesos = cargarPesos();
  return {
    modo: MODO,
    modelo_juez: JUEZ_MODELO,
    modelo_reserva: RESERVA,
    residente_url: LITELLM,
    clave_residente: Boolean(process.env.RESIDENTE_KEY),
    brain: { modo: modoBrain(), url: BRAIN_URL, banco: BANCO, token: Boolean(process.env.BRAIN_TOKEN) },
    clasificador: { pesos: pesos !== null, sin_entrenar: pesos ? sinEntrenar(pesos) : null, mide: false },
    limites: { max_transcript: MAX_TRANSCRIPT, max_sugerencia: MAX_SUGERENCIA },
    auditoria: { ruta: RUTA, max_bytes: MAX_BYTES },
    token: Boolean(TOKEN),
  };
}

const servidor = createServer(async (req, res) => {
  const ruta = (req.url || "/").split("?")[0];
  try {
    if (ruta === "/healthz") return json(res, 200, { ok: true, modo: MODO, brain: modoBrain() });
    if (!autorizado(req)) return json(res, 401, { error: "falta el token" });
    if (ruta === "/v1/config") {
      if (req.method !== "GET") return json(res, 405, { error: "solo GET" });
      return json(res, 200, config());
    }
    if (ruta === "/v1/auditoria") {
      if (req.method !== "GET") return json(res, 405, { error: "solo GET" });
      const [code, out] = auditoria(req.url || "/");
      return json(res, code as number, out);
    }
    if (req.method !== "POST") return json(res, 405, { error: "solo POST" });
    const body = await leer(req);
    const [code, out] = ruta === "/v1/suggest" ? await suggest(body)
      : ruta === "/v1/verdict" ? await verdict(body)
      : ruta === "/v1/clasificar" ? await clasificarCuerpo(body)
      : [404, { error: "no existe" }];
    json(res, code as number, out);
  } catch (error) {
    json(res, 422, { error: String((error as Error).message).slice(0, 200) });
  }
});

servidor.listen(PORT, () => console.log(JSON.stringify({ arranca: PORT, modo: MODO, brain: modoBrain() })));