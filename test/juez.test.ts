import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { dictaminar } from "../service/juez.ts";

// El dictamen: las reglas deciden sin modelo; el modelo solo entra cuando no hay regla, y si no contesta la puerta cierra.
const ctx = { cwd: "/home/dani/k8s/k8s-paseo-pocharlies", resumen: "arma el PR", criterio: "CI en verde" };

const respuesta = (out: unknown) => ({ ok: true, json: async () => out, text: async () => JSON.stringify(out) }) as any;
const residente = (o: unknown) => respuesta({ choices: [{ message: { content: JSON.stringify(o) } }] });

afterEach(() => mock.restoreAll());

describe("la puerta", () => {
  it("una regla dura no espera al brain: decide sin pagar el recall", async () => {
    const nunca = new Promise<string[]>(() => {});   // el brain, colgado: si la puerta lo esperara, este test no acabaría
    const v = await Promise.race([
      dictaminar("kubectl delete pod -n llm x", ctx, nunca),
      new Promise<never>((_, falla) => setTimeout(() => falla(new Error("la regla esperó al brain")), 500)),
    ]);
    assert.equal(v.via, "reglas");
  });

  it("una regla dura gana sin llamar a ningún modelo", async () => {
    const f = mock.method(globalThis, "fetch", async () => { throw new Error("no debería llamarse"); });
    const v = await dictaminar("kubectl delete pod -n llm x", ctx);
    assert.deepEqual(v, { ok: false, riesgo: "alto", motivo: "D2: kubernetes destructivo", via: "reglas" });
    assert.equal(f.mock.callCount(), 0);
  });

  it("el residente decide solo: no queda ningún Jev delante", async () => {
    const f = mock.method(globalThis, "fetch", async () => residente({ veredicto: "seguir", riesgo: "bajo", p: 0 }));
    await dictaminar("abre el PR contra deploy/prod", ctx);
    assert.equal(f.mock.callCount(), 1);
    assert.match(String(f.mock.calls[0].arguments[0]), /litellm/);
  });

  it("con el residente en `seguir`, aprueba, y su motivo es el que se lee en la auditoría", async () => {
    mock.method(globalThis, "fetch", async () => residente({ veredicto: "seguir", riesgo: "bajo", p: 0, motivo: "abre el PR" }));
    const v = await dictaminar("abre el PR contra deploy/prod", ctx);
    assert.equal(v.ok, true);
    assert.equal(v.riesgo, "bajo");
    assert.equal(v.via, "residente");
    assert.equal(v.motivo, "abre el PR");
  });

  it("el residente decide con su veredicto aunque escriba p: 0.0, que es lo que escribe", async () => {
    mock.method(globalThis, "fetch", async () => residente({ veredicto: "seguir", riesgo: "ninguno", p: 0.0 }));
    const v = await dictaminar("abre el PR contra deploy/prod", ctx);
    assert.equal(v.ok, true);
    assert.equal(v.riesgo, "ninguno");
  });

  it("un veredicto del residente con mayúsculas o cola se lee igual", async () => {
    mock.method(globalThis, "fetch", async () => residente({ veredicto: "SEGUIR (claro)", riesgo: "ninguno", p: 0 }));
    assert.equal((await dictaminar("abre el PR contra deploy/prod", ctx)).ok, true);
  });

  it("un `detener` cierra con riesgo alto aunque el modelo diga bajo", async () => {
    mock.method(globalThis, "fetch", async () => residente({ veredicto: "detener", riesgo: "bajo", p: 0.99 }));
    const v = await dictaminar("abre el PR contra deploy/prod", ctx);
    assert.equal(v.ok, false);
    assert.equal(v.riesgo, "alto");
  });

  it("dinero no se aprueba aunque diga seguir", async () => {
    mock.method(globalThis, "fetch", async () => residente({ veredicto: "seguir", riesgo: "dinero", p: 0.99 }));
    const v = await dictaminar("revisa el pedido", ctx);
    assert.equal(v.ok, false);
    assert.equal(v.riesgo, "dinero");
  });

  it("sin residente la puerta cierra y deja por qué en la traza: nunca aprueba por defecto", async () => {
    mock.method(globalThis, "fetch", async () => { throw new Error("caído"); });
    const v = await dictaminar("abre el PR contra deploy/prod", ctx);
    assert.equal(v.ok, false);
    assert.equal(v.riesgo, "alto");
    assert.equal(v.via, "ninguno");
    assert.match(v.traza!.join(" "), /residente: caído/);
  });

  it("un JSON cortado por max_tokens se sigue leyendo: sus campos deciden", async () => {
    mock.method(globalThis, "fetch", async () => respuesta({ choices: [{ message: { content:
      '{"veredicto": "seguir", "riesgo": "bajo", "p": 0.0, "motivo": "abre el PR y espera CI' } }] }));
    const v = await dictaminar("abre el PR contra deploy/prod", ctx);
    assert.equal(v.ok, true);
    assert.equal(v.riesgo, "bajo");
    assert.equal(v.via, "residente");
  });

  it("un JSON cortado que dice detener también cierra", async () => {
    mock.method(globalThis, "fetch", async () => respuesta({ choices: [{ message: { content:
      '{"veredicto": "detener", "riesgo": "alto", "p": 0.95, "motivo": "El criterio de aceptación exi' } }] }));
    const v = await dictaminar("abre el PR contra deploy/prod", ctx);
    assert.equal(v.ok, false);
    assert.equal(v.riesgo, "alto");
  });
});
