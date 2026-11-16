import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vigia } from "../server/vigia.ts";

// SC-5805: the ✦'s held `suggest.watch`. What a client gets is the asked agents whose answer changed after its version; with
// nothing changed the call is held until `avisa` or the hold ends. Short holds here so the suite stays fast.
const respuestas = new Map<string, { text: string | null }>();
const lee = (agentes: readonly string[]) => Object.fromEntries(agentes.map((id) => [id, respuestas.get(id) ?? { text: null }]));

describe("la llamada retenida de la ✦", () => {
  it("la primera llamada trae todo, completo; la siguiente solo lo que cambió", async () => {
    respuestas.clear();
    const v = vigia<{ text: string | null }>(1_000, 5);
    const primera = await v.espera(["a", "b"], 0, lee);
    assert.equal(primera.completo, true);
    assert.deepEqual(Object.keys(primera.agentes).sort(), ["a", "b"]);
    respuestas.set("b", { text: "sigue" });
    v.avisa();
    const segunda = await v.espera(["a", "b"], primera.version, lee);
    assert.equal(segunda.completo, false);
    assert.deepEqual(segunda.agentes, { b: { text: "sigue" } });
    assert.ok(segunda.version > primera.version);
    v.cierra();
  });

  it("sin cambios retiene la llamada y responde en cuanto algo cambia y se avisa", async () => {
    respuestas.clear();
    const v = vigia<{ text: string | null }>(5_000, 5);
    const { version } = await v.espera(["a"], 0, lee);
    const inicio = Date.now();
    const retenida = v.espera(["a"], version, lee);
    setTimeout(() => {
      respuestas.set("a", { text: "lista" });
      v.avisa();
    }, 50);
    const r = await retenida;
    assert.deepEqual(r.agentes, { a: { text: "lista" } });
    assert.ok(Date.now() - inicio < 2_000, "respondió al aviso, no al final de la retención");
    v.cierra();
  });

  it("un cambio de otro agente no despierta a quien no lo pidió: sigue retenido hasta el final", async () => {
    respuestas.clear();
    const v = vigia<{ text: string | null }>(200, 5);
    const { version } = await v.espera(["a", "b"], 0, lee);
    const retenida = v.espera(["a"], version, lee);
    respuestas.set("b", { text: "de otro" });
    v.avisa();
    const r = await retenida;
    assert.deepEqual(r.agentes, {});
    assert.equal(r.completo, false);
    v.cierra();
  });

  it("al acabar la retención mira una vez más: un cambio sin aviso llega igual", async () => {
    respuestas.clear();
    const v = vigia<{ text: string | null }>(100, 5);
    const { version } = await v.espera(["a"], 0, lee);
    respuestas.set("a", { text: "sin aviso" });
    const r = await v.espera(["a"], version, lee);
    assert.deepEqual(r.agentes, { a: { text: "sin aviso" } });
  });

  it("una versión de antes de recargar el plugin recibe todo otra vez", async () => {
    respuestas.clear();
    const v = vigia<{ text: string | null }>(100, 5);
    const r = await v.espera(["a"], 1, lee);
    assert.equal(r.completo, true);
    assert.deepEqual(Object.keys(r.agentes), ["a"]);
  });

  it("cierra suelta las llamadas retenidas", async () => {
    respuestas.clear();
    const v = vigia<{ text: string | null }>(60_000, 5);
    const { version } = await v.espera(["a"], 0, lee);
    const retenida = v.espera(["a"], version, lee);
    v.cierra();
    assert.deepEqual((await retenida).agentes, {});
  });
});
