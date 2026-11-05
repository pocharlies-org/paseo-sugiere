import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { sugerir } from "../service/residente.ts";

// La clave del servicio está limitada a `qwen38-flash-next` en LiteLLM (`/key/info`, 05-11): con el modelo de la sesión
// (Alibaba, `claude-*`) la llamada daba 403 y `/v1/suggest` 503, o sea la píldora vacía. Una reserva, solo para el 403.
const line = (o: object) => JSON.stringify(o);
const TRANSCRIPT = [
  line({ type: "user", message: { role: "user", content: [{ type: "text", text: "monta el pill" }] } }),
  line({ type: "assistant", message: { role: "assistant", model: "alibaba-q38-flash", content: [{ type: "text", text: "hecho" }] } }),
];

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

function stub(responder: (cuerpo: any) => Response) {
  const cuerpos: any[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const cuerpo = JSON.parse(init.body);
    cuerpos.push(cuerpo);
    return responder(cuerpo);
  }) as unknown as typeof fetch;
  return cuerpos;
}

const ok = (texto: string) => new Response(JSON.stringify({ choices: [{ message: { content: texto } }] }), { status: 200 });

describe("el modelo de reserva", () => {
  it("ante un 403 por modelo no permitido reintenta UNA vez con el residente", async () => {
    const cuerpos = stub((c) => (c.model === "alibaba-q38-flash"
      ? new Response('{"error":{"message":"not available for this API key"}}', { status: 403 })
      : ok("sube el pin del digest")));
    const r = await sugerir(TRANSCRIPT, "", 5_000);
    assert.deepEqual(cuerpos.map((c) => c.model), ["alibaba-q38-flash", "qwen38-flash-next"]);
    assert.equal(r.modelo, "qwen38-flash-next"); // se informa del que contestó, no del que se pidió primero
    assert.equal(r.texto, "sube el pin del digest");
  });

  it("un fallo que no es 403 no se reintenta: un timeout no se paga dos veces", async () => {
    const cuerpos = stub(() => new Response("boom", { status: 500 }));
    await assert.rejects(() => sugerir(TRANSCRIPT, "", 5_000), /500/);
    assert.equal(cuerpos.length, 1);
  });

  it("si el propio residente también da 403, sube el error: la reserva no se repite en bucle", async () => {
    const cuerpos = stub(() => new Response("sin modelo", { status: 403 }));
    await assert.rejects(() => sugerir(TRANSCRIPT, "", 5_000), /403/);
    assert.deepEqual(cuerpos.map((c) => c.model), ["alibaba-q38-flash", "qwen38-flash-next"]);
  });
});