// El servicio: dos endpoints, sin estado y sin ficheros. /v1/suggest propone el siguiente mensaje y /v1/verdict dictamina si
// puede enviarse. No envía, no escribe tickets y no lee transcripts: todo lo que necesita llega en la petición.
import { createServer } from "node:http";
import { dictaminar } from "./juez.ts";
import { sugerir } from "./residente.ts";

const PORT = Number(process.env.PORT || "8080");
const MAX_TRANSCRIPT = Number(process.env.MAX_TRANSCRIPT || String(32 * 1024 * 1024)); // el recorte de contexto (400k caracteres) lo hace shared/transcript.ts
const MAX_SUGERENCIA = 4000;
const MODO = process.env.SUGIERE_MODO || "sombra"; // sombra = hay servicio y veredictos, ningún llamante que actúe

type Cuerpo = Record<string, any>;

const json = (res: any, code: number, out: unknown) => {
  const text = JSON.stringify(out);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

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
    const { texto: sugerencia, modelo } = await sugerir(lineas(transcript), contexto?.instruccion ?? "");
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
  const v = await dictaminar(sugerencia, contexto);
  console.log(JSON.stringify({ modo: MODO, sid, turno, ...v, sugerencia: sugerencia.slice(0, 120) }));
  return [200, v];
}

const servidor = createServer(async (req, res) => {
  const ruta = (req.url || "/").split("?")[0];
  try {
    if (ruta === "/healthz") return json(res, 200, { ok: true, modo: MODO });
    if (req.method !== "POST") return json(res, 405, { error: "solo POST" });
    const body = await leer(req);
    const [code, out] = ruta === "/v1/suggest" ? await suggest(body) : ruta === "/v1/verdict" ? await verdict(body) : [404, { error: "no existe" }];
    json(res, code as number, out);
  } catch (error) {
    json(res, 422, { error: String((error as Error).message).slice(0, 200) });
  }
});

servidor.listen(PORT, () => console.log(JSON.stringify({ arranca: PORT, modo: MODO })));