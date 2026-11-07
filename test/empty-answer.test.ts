import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

// The pill click (force) that the service answers with nothing to suggest shows «nada que sugerir», not «la sesión se movió»
// (measured 07-11: an empty answer was relabelled as moved). «Se movió» stays for a turn that really started meanwhile.
// Own file: it mocks the session module before importing suggest (own process).
const TRANSCRIPT = [
  '{"type":"user","message":{"role":"user","content":"hola"}}',
  '{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5-5","content":"hecho"}}',
];
let respuesta: () => Promise<{ status: number; sugerencia: string; modelo: string }>;
mock.module(new URL("../server/session.ts", import.meta.url).href, {
  namedExports: {
    SessionError: class extends Error {},
    locateSession: async () => TRANSCRIPT,
    nativeSuggestion: async () => null,
    sugiereRequest: () => respuesta(),
  },
});
const suggest = await import("../server/suggest.ts");
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("force answered with nothing to suggest", () => {
  it("settles with «nada que sugerir», not as a moved session", async () => {
    respuesta = async () => ({ status: 200, sugerencia: "", modelo: "claude-opus-5-5" });
    suggest.force("v1", {} as never);
    await flush();
    assert.equal(suggest.get("v1"), null);
    assert.deepEqual(suggest.state("v1"), { pending: false, error: "nada que sugerir" });
  });

  it("still says the session moved when a turn started while the answer was in flight", async () => {
    let contesta!: (r: { status: number; sugerencia: string; modelo: string }) => void;
    respuesta = () => new Promise((resolve) => { contesta = resolve; });
    suggest.force("v2", {} as never);
    await flush();
    suggest.cancel("v2"); // agent.turn_started
    contesta({ status: 200, sugerencia: "sigue con el merge", modelo: "claude-opus-5-5" });
    await flush();
    assert.equal(suggest.get("v2"), null);
    assert.deepEqual(suggest.state("v2"), { pending: false, error: "la sesión se movió mientras se generaba" });
  });
});
