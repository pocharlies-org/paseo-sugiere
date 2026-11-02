import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { dictaminar } from "../service/juez.ts";

// El residente no es reproducible (17 % de flips medidos con temp 0 y el mismo texto): la puerta pide tres votos y
// manda la mayoría. Jev está caído en todos estos casos para que el dictamen salga del voto.

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

const respuesta = (veredicto: string, riesgo: string, p = 0) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify({ veredicto, riesgo, p }) } }] }),
}) as unknown as Response;

/** Jev falla siempre; el residente contesta lo que diga `votos`, en orden. */
function conVotos(votos: (Response | Error)[]) {
  let i = 0;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("systemone")) throw new Error("jev caído");
    const v = votos[i++];
    if (v instanceof Error) throw v;
    return v;
  }) as typeof fetch;
}

const benigno = { cwd: "/home/dibanez/k8s", resumen: "añade un test", criterio: "el test pasa" };
const sugerencia = "Lee service/server.ts y añade un test del 422";

describe("el voto del residente", () => {
  it("dos de tres detener bloquean", async () => {
    conVotos([respuesta("detener", "alto"), respuesta("seguir", "bajo"), respuesta("detener", "alto")]);
    const v = await dictaminar(sugerencia, benigno);
    assert.equal(v.ok, false);
    assert.equal(v.via, "residente");
    assert.match(v.motivo, /mayoría 1-2 de 3/);
  });

  it("tres de tres seguir aprueban y conservan el riesgo", async () => {
    conVotos([respuesta("seguir", "bajo"), respuesta("seguir", "alto"), respuesta("seguir", "ninguno")]);
    const v = await dictaminar(sugerencia, benigno);
    assert.equal(v.ok, true);
    assert.equal(v.riesgo, "alto");   // el más grave de la mayoría
    assert.match(v.motivo, /mayoría 3-0 de 3/);
  });

  it("con una sola respuesta legible no hay dictamen: se escala", async () => {
    conVotos([respuesta("seguir", "bajo"), new Error("timeout"), new Error("timeout")]);
    const v = await dictaminar(sugerencia, benigno);
    assert.equal(v.ok, false);
    assert.equal(v.via, "ninguno");
    assert.match(v.motivo, /puerta no disponible/);
  });

  it("un empate no aprueba", async () => {
    conVotos([respuesta("seguir", "bajo"), respuesta("detener", "alto"), new Error("timeout")]);
    const v = await dictaminar(sugerencia, benigno);
    assert.equal(v.ok, false);
    assert.match(v.motivo, /mayoría 1-1 de 3/);
  });
});