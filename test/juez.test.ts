import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { dictaminar } from "../service/juez.ts";

// El dictamen: las reglas deciden sin modelo; el modelo solo entra cuando no hay regla, y si no contesta la puerta cierra.
const ctx = { cwd: "/home/dani/k8s/k8s-paseo-pocharlies", resumen: "arma el PR", criterio: "CI en verde" };

const respuesta = (out: unknown) => ({ ok: true, json: async () => out, text: async () => JSON.stringify(out) }) as any;
const jev = (choice: string, p: number, riesgo = "bajo") =>
  respuesta({ answers: { veredicto: { choice, probabilities: { [choice]: p } }, riesgo: { choice: riesgo } } });
const residente = (o: unknown) => respuesta({ choices: [{ message: { content: JSON.stringify(o) } }] });

afterEach(() => mock.restoreAll());

describe("la puerta", () => {
  it("una regla dura gana sin llamar a ningún modelo", async () => {
    const f = mock.method(globalThis, "fetch", async () => { throw new Error("no debería llamarse"); });
    const v = await dictaminar("kubectl delete pod -n llm x", ctx);
    assert.deepEqual(v, { ok: false, riesgo: "alto", motivo: "D2: kubernetes destructivo", via: "reglas" });
    assert.equal(f.mock.callCount(), 0);
  });

  it("con la rúbrica de Jev por encima del umbral, aprueba", async () => {
    mock.method(globalThis, "fetch", async (url: any) => String(url).includes("ollaya") ? jev("seguir", 0.97) : residente({}));
    const v = await dictaminar("abre el PR contra deploy/prod", ctx);
    assert.equal(v.ok, true);
    assert.equal(v.riesgo, "bajo");
    assert.equal(v.via, "jev");
  });

  it("por debajo del umbral escala al residente, y manda su veredicto", async () => {
    mock.method(globalThis, "fetch", async (url: any) =>
      String(url).includes("ollaya") ? jev("seguir", 0.5) : residente({ veredicto: "seguir", riesgo: "bajo", p: 0.96, motivo: "ok" }));
    const v = await dictaminar("abre el PR contra deploy/prod", ctx);
    assert.equal(v.ok, true);
    assert.match(v.motivo, /residente/);
    assert.equal(v.via, "residente");
  });

  it("el residente decide con su veredicto aunque escriba p: 0.0, que es lo que escribe", async () => {
    mock.method(globalThis, "fetch", async (url: any) =>
      String(url).includes("ollaya") ? jev("seguir", 0.2) : residente({ veredicto: "seguir", riesgo: "bajo", p: 0.0, motivo: "ok" }));
    const v = await dictaminar("abre el PR contra deploy/prod", ctx);
    assert.equal(v.ok, true);
    assert.equal(v.via, "residente");
    assert.equal(v.riesgo, "bajo");
  });

  it("dinero no escala ni se aprueba, venga de donde venga", async () => {
    const f = mock.method(globalThis, "fetch", async (url: any) =>
      String(url).includes("ollaya") ? jev("seguir", 0.99, "dinero") : residente({ veredicto: "seguir", riesgo: "ninguno", p: 0.99 }));
    const v = await dictaminar("revisa el pedido", ctx);
    assert.equal(v.ok, false);
    assert.equal(v.riesgo, "dinero");
    assert.equal(f.mock.callCount(), 1); // solo Jev: no hay escalado que hacer
  });

  it("sin Jev y sin residente la puerta cierra: nunca aprueba por defecto", async () => {
    mock.method(globalThis, "fetch", async () => { throw new Error("caído"); });
    const v = await dictaminar("abre el PR contra deploy/prod", ctx);
    assert.deepEqual(v, { ok: false, riesgo: "alto", motivo: "puerta no disponible", via: "ninguno" });
  });
});