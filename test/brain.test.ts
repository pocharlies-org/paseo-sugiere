import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { modoBrain, recuerdosDelCuerpo } from "../service/brain.ts";

const dir = mkdtempSync(join(tmpdir(), "sugiere-brain-"));
const fichero = (nombre: string, contenido: string) => {
  const ruta = join(dir, nombre);
  writeFileSync(ruta, contenido);
  return ruta;
};

describe("el interruptor del brain nace apagado", () => {
  it("sin fichero de modo, el brain está apagado", () => {
    assert.equal(modoBrain(join(dir, "no-existe.json")), "off");
  });

  it("un modo que no es sombra ni on también es off: lo que no se entiende no se enciende", () => {
    assert.equal(modoBrain(fichero("roto.json", "{no es json")), "off");
    assert.equal(modoBrain(fichero("otro.json", '{"modo":"activado"}')), "off");
  });

  it("se relee del fichero: pasar de on a off no exige reiniciar el pod", () => {
    const ruta = fichero("caliente.json", '{"modo":"on"}');
    assert.equal(modoBrain(ruta), "on");
    writeFileSync(ruta, '{"modo":"off"}');
    assert.equal(modoBrain(ruta), "off");
  });
});

describe("los recuerdos del recall", () => {
  it("lee la forma de hoy (results) y descarta lo que no trae texto", () => {
    const r = recuerdosDelCuerpo({ results: [{ id: "a", text: "  uno\n dos " }, { id: "b" }, { id: "c", text: "tres" }] });
    assert.deepEqual(r, [{ id: "a", texto: "uno dos" }, { id: "c", texto: "tres" }]);
  });

  it("lee también la forma vieja (memories) y no explota con cualquier cosa", () => {
    assert.deepEqual(recuerdosDelCuerpo({ memories: [{ id: "a", content: "x" }] }), [{ id: "a", texto: "x" }]);
    assert.deepEqual(recuerdosDelCuerpo(null), []);
    assert.deepEqual(recuerdosDelCuerpo({ results: "no es una lista" }), []);
  });

  it("un recuerdo larguísimo se recorta: no añade señal y sí cuesta tokens", () => {
    const [r] = recuerdosDelCuerpo({ results: [{ id: "a", text: "x".repeat(5000) }] });
    assert.equal(r.texto.length, 400);
  });
});