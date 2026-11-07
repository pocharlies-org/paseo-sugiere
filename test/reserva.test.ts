import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { sugerir } from "../service/residente.ts";
import { CLAUDE_CODE_SYSTEM } from "../shared/suggest.ts";

// Paseo en vivo pide el modelo de la sesión; si la clave no sirve ese alias (403) o no le quedan cuentas (429), reintenta una sola vez con el residente.
// La compañía (o quien no diga `kind`) va directa al residente local (Dani 06-11).
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
    const r = await sugerir(TRANSCRIPT, 5_000, "live");
    assert.deepEqual(cuerpos.map((c) => c.model), ["alibaba-q38-flash", "qwen38-flash-next"]);
    assert.equal(r.modelo, "qwen38-flash-next"); // se informa del que contestó, no del que se pidió primero
    assert.equal(r.texto, "sube el pin del digest");
  });

  it("ante un 429 (cuentas de la sesión agotadas) también reintenta UNA vez con el residente", async () => {
    const cuerpos = stub((c) => (c.model === "alibaba-q38-flash"
      ? new Response('{"error":{"message":"No deployments available for selected model"}}', { status: 429 })
      : ok("revisa el CI")));
    const r = await sugerir(TRANSCRIPT, 5_000, "live");
    assert.deepEqual(cuerpos.map((c) => c.model), ["alibaba-q38-flash", "qwen38-flash-next"]);
    assert.equal(r.modelo, "qwen38-flash-next");
  });

  it("un fallo que no es 403 ni 429 no se reintenta: un timeout no se paga dos veces", async () => {
    const cuerpos = stub(() => new Response("boom", { status: 500 }));
    await assert.rejects(() => sugerir(TRANSCRIPT, 5_000, "live"), /500/);
    assert.equal(cuerpos.length, 1);
  });

  it("si el propio residente también da 403, sube el error: la reserva no se repite en bucle", async () => {
    const cuerpos = stub(() => new Response("sin modelo", { status: 403 }));
    await assert.rejects(() => sugerir(TRANSCRIPT, 5_000, "live"), /403/);
    assert.deepEqual(cuerpos.map((c) => c.model), ["alibaba-q38-flash", "qwen38-flash-next"]);
  });

  it("con la sesión en GPT, el reintento lleva el reasoning_effort del residente, no el de GPT", async () => {
    const gpt = [TRANSCRIPT[0], line({ type: "assistant", message: { role: "assistant", model: "gpt-6-luna", content: [{ type: "text", text: "hecho" }] } })];
    const cuerpos = stub((c) => (c.model === "gpt-6-luna" ? new Response("no", { status: 403 }) : ok("sigue")));
    await sugerir(gpt, 5_000, "live");
    assert.deepEqual(cuerpos.map((c) => [c.model, c.reasoning_effort]), [["gpt-6-luna", "minimal"], ["qwen38-flash-next", "none"]]);
  });
});

describe("la forma del system", () => {
  it("la línea de Claude Code va como primer bloque propio, no junta con la instrucción (si no, Claude da 429)", async () => {
    const cuerpos = stub(() => ok("revisa el CI"));
    await sugerir(TRANSCRIPT, 5_000, "live");
    const sistema = cuerpos[0].messages[0];
    assert.equal(sistema.role, "system");
    assert.ok(Array.isArray(sistema.content) && sistema.content.length === 2);
    assert.deepEqual(sistema.content[0], { type: "text", text: CLAUDE_CODE_SYSTEM });
  });
});

describe("el modelo según quién llama", () => {
  for (const kind of ["", "company"]) {
    it(`kind ${JSON.stringify(kind)} va directo al residente, sea cual sea el modelo de la sesión`, async () => {
      const cuerpos = stub(() => ok("revisa el CI"));
      const r = await sugerir(TRANSCRIPT, 5_000, kind);
      assert.deepEqual(cuerpos.map((c) => c.model), ["qwen38-flash-next"]);
      assert.equal(r.modelo, "qwen38-flash-next");
    });
  }

  it("Paseo en vivo usa el modelo de la sesión", async () => {
    const cuerpos = stub(() => ok("revisa el CI"));
    const r = await sugerir(TRANSCRIPT, 5_000, "live");
    assert.deepEqual(cuerpos.map((c) => c.model), ["alibaba-q38-flash"]);
    assert.equal(r.modelo, "alibaba-q38-flash");
  });
});
