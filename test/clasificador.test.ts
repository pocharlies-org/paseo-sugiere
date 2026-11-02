import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { cargarPesos, clasificar, decidir, type Pesos } from "../service/clasificador.ts";

// El head en sombra: solo puede decir `permitir` (y con el umbral calibrado) o `escalar`. Sin pesos o sin embedding se
// escala, nunca se permite.

const PESOS: Pesos = { etiquetas: ["permitir", "escalar"], pesos: [[5, 0], [0, 5]], sesgo: [0, 0], umbral: 0.9 };

function conPesos(p: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "clasificador-"));
  const ruta = join(dir, "pesos.json");
  writeFileSync(ruta, typeof p === "string" ? p : JSON.stringify(p));
  return ruta;
}

const embedDevuelve = (v: number[]) => async () => ({ ok: true, json: async () => [v] }) as unknown as Response;

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

describe("el head", () => {
  it("permite solo por encima del umbral, y escala si no lo pasa", () => {
    assert.equal(decidir([1, 0], PESOS).etiqueta, "permitir");
    assert.equal(decidir([0, 1], PESOS).etiqueta, "escalar");
    const empate: Pesos = { ...PESOS, pesos: [[1, 0], [1, 0]] };   // p=0,5: por debajo del umbral no permite
    assert.deepEqual(decidir([1, 0], empate), { etiqueta: "escalar", p: 0.5 });
  });

  it("sin pesos escala, aunque el texto sea benigno", async () => {
    const r = await clasificar("revisa los tests del PR", "/no/existe.json");
    assert.deepEqual([r.etiqueta, r.motivo], ["escalar", "sin pesos"]);
  });

  it("si el embedding falla, escala", async () => {
    const ruta = conPesos(PESOS);
    globalThis.fetch = (async () => { throw new Error("bge-m3 caído"); }) as typeof fetch;
    const r = await clasificar("revisa los tests del PR", ruta);
    assert.equal(r.etiqueta, "escalar");
    assert.match(r.motivo, /bge-m3 caído/);
  });

  it("con embedding bueno y pesos buenos, decide y lo cuenta", async () => {
    const ruta = conPesos(PESOS);
    globalThis.fetch = embedDevuelve([0.9, 0.1]) as unknown as typeof fetch;
    const r = await clasificar("revisa los tests del PR", ruta);
    assert.equal(r.etiqueta, "permitir");
    assert.equal(r.motivo, "");
    assert.ok(r.p > 0.9);
    assert.ok(r.ms >= 0);
  });

  it("un fichero de pesos roto se lee como «sin pesos», no revienta", () => {
    assert.equal(cargarPesos(conPesos("{no es json")), null);
  });
});