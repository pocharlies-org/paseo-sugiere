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

  it("un veredicto del residente con mayúsculas o cola se lee igual", async () => {
    mock.method(globalThis, "fetch", async (url: any) =>
      String(url).includes("ollaya") ? jev("seguir", 0.1) : residente({ veredicto: "SEGUIR (claro)", riesgo: "ninguno", p: 0 }));
    assert.equal((await dictaminar("abre el PR contra deploy/prod", ctx)).ok, true);
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

// El residente no es reproducible (17 % de flips medidos con temp 0 y el mismo texto): la puerta pide tres votos y
// manda la mayoría. Jev está caído en todos estos casos para que el dictamen salga del voto.
describe("el voto del residente", () => {
  /** Jev falla siempre; el residente contesta lo que diga `votos`, en orden. */
  function conVotos(votos: any[]) {
    let i = 0;
    return mock.method(globalThis, "fetch", async (url: any) => {
      if (String(url).includes("ollaya")) throw new Error("jev caído");
      const v = votos[i++];
      if (v instanceof Error) throw v;
      return v;
    });
  }

  const sugerencia = "Lee service/server.ts y añade un test del 422";

  it("dos de tres detener bloquean", async () => {
    conVotos([residente({ veredicto: "detener", riesgo: "alto" }), residente({ veredicto: "seguir", riesgo: "bajo" }),
      residente({ veredicto: "detener", riesgo: "alto" })]);
    const v = await dictaminar(sugerencia, ctx);
    assert.equal(v.ok, false);
    assert.equal(v.via, "residente");
    assert.match(v.motivo, /mayoría 1-2 de 3/);
  });

  it("tres de tres seguir aprueban y conservan el riesgo más grave", async () => {
    conVotos([residente({ veredicto: "seguir", riesgo: "bajo" }), residente({ veredicto: "seguir", riesgo: "alto" }),
      residente({ veredicto: "seguir", riesgo: "ninguno" })]);
    const v = await dictaminar(sugerencia, ctx);
    assert.equal(v.ok, true);
    assert.equal(v.riesgo, "alto");
    assert.match(v.motivo, /mayoría 3-0 de 3/);
  });

  it("con una sola respuesta legible no hay dictamen: se escala", async () => {
    conVotos([residente({ veredicto: "seguir", riesgo: "bajo" }), new Error("timeout"), new Error("timeout")]);
    const v = await dictaminar(sugerencia, ctx);
    assert.equal(v.ok, false);
    assert.equal(v.via, "ninguno");
    assert.match(v.motivo, /puerta no disponible/);
  });

  it("un empate no aprueba", async () => {
    conVotos([residente({ veredicto: "seguir", riesgo: "bajo" }), residente({ veredicto: "detener", riesgo: "alto" }),
      new Error("timeout")]);
    const v = await dictaminar(sugerencia, ctx);
    assert.equal(v.ok, false);
    assert.match(v.motivo, /mayoría 1-1 de 3/);
  });

  it("deja en la traza el veredicto de cada voto, no solo el marcador", async () => {
    conVotos([residente({ veredicto: "seguir", riesgo: "bajo" }), residente({ veredicto: "detener", riesgo: "alto" }),
      residente({ veredicto: "detener", riesgo: "bajo" })]);
    const v = await dictaminar(sugerencia, ctx);
    const traza = (v as any).traza as string[];
    assert.deepEqual(traza.filter((l) => l.startsWith("voto")),
      ["voto1 seguir/bajo", "voto2 detener/alto", "voto3 detener/bajo"]);
  });

  it("un 429 no es un voto y queda dicho en la traza", async () => {
    conVotos([residente({ veredicto: "seguir", riesgo: "bajo" }), new Error("LiteLLM respondió 429: no hay hueco"),
      residente({ veredicto: "seguir", riesgo: "bajo" })]);
    const v = await dictaminar(sugerencia, ctx);
    assert.equal(v.ok, true);
    const traza = (v as any).traza as string[];
    assert.ok(traza.some((l) => /voto2 ERROR LiteLLM respondió 429/.test(l)));
  });
});