import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";

// «Garantizar plan» in the plugin: the anchor paseo-plan writes per agent, read here from a hand-written file (paseo-plan's
// contract). With guard on and criteria, every completed turn generates right away with the plan, auto or not; three «no es esto»
// in a row and the ✦ goes quiet until clicked. Own process: it mocks the session module and moves HOME before importing suggest.
const home = mkdtempSync(join(tmpdir(), "sugiere-guard-"));
process.env.HOME = home;
const dir = join(home, ".local", "state", "paseo-plan");
mkdirSync(dir, { recursive: true });
const anchor = (agentId: string, a: object) => writeFileSync(join(dir, `anchor-${agentId}.json`), JSON.stringify(a));
const PLAN = { ticketKey: "SUG-H1", objetivo: "o", criterios: [{ texto: "c1", status: "abierta" }], fuera_de_alcance: [] };

const pedidos: { sid: string; plan: object | null }[] = [];
mock.module(new URL("../server/session.ts", import.meta.url).href, {
  namedExports: {
    SessionError: class extends Error {},
    locateSession: async () => [
      '{"type":"user","message":{"role":"user","content":"hola"}}',
      '{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5-5","content":"hola, dime"}}',
    ],
    nativeSuggestion: async () => "la nativa, que no vio el plan",
    sugiereRequest: async (sid: string, _turno: number, _lines: string[], plan: object | null) => {
      pedidos.push({ sid, plan });
      return { status: 200, sugerencia: "relee el estado", modelo: "m", en_plan: plan ? "verificar" : null, criterio: plan ? "C1 — c1" : null };
    },
  },
});
const suggest = await import("../server/suggest.ts");
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("Garantizar plan", () => {
  it("with guard on, a completed turn generates at once with the plan (auto off), skipping the native suggestion", async () => {
    anchor("g1", { ...PLAN, guard: true });
    suggest.arm("g1", {} as never);
    await flush();
    assert.deepEqual(pedidos.at(-1), { sid: "g1", plan: { ...PLAN, guard: true } });
    assert.equal(suggest.get("g1"), "relee el estado");
    assert.deepEqual(suggest.anchor("g1"), { en_plan: "verificar", criterio: "C1 — c1", muted: false });
  });

  it("guard off, no criteria or no file: nothing arms without auto, and a force goes without plan", async () => {
    anchor("g2", { ...PLAN, guard: false });
    anchor("g3", { ...PLAN, criterios: [], guard: true });
    const antes = pedidos.length;
    for (const id of ["g2", "g3", "g4"]) suggest.arm(id, {} as never);
    await flush();
    assert.equal(pedidos.length, antes);
    suggest.force("g2", {} as never);
    await flush();
    assert.equal(suggest.get("g2"), "la nativa, que no vio el plan"); // as before plans: the native suggestion first
    assert.deepEqual(suggest.anchor("g2"), { en_plan: null, criterio: null, muted: false });
  });

  it("three «no es esto» in a row: quiet, no guarded generation, until a click; a used suggestion breaks the streak", async () => {
    anchor("g5", { ...PLAN, guard: true });
    assert.deepEqual(suggest.feedback("g5", "no-es-esto"), { muted: false });
    assert.deepEqual(suggest.feedback("g5", "no-es-esto"), { muted: false });
    suggest.feedback("g5", "usada");
    assert.deepEqual(suggest.feedback("g5", "no-es-esto"), { muted: false });
    assert.deepEqual(suggest.feedback("g5", "no-es-esto"), { muted: false });
    assert.deepEqual(suggest.feedback("g5", "no-es-esto"), { muted: true });
    assert.equal(suggest.get("g5"), null); // «no es esto» drops the suggestion
    const antes = pedidos.length;
    suggest.arm("g5", {} as never);
    await flush();
    assert.equal(pedidos.length, antes);
    assert.equal(suggest.anchor("g5").muted, true);
    suggest.force("g5", {} as never);
    await flush();
    assert.equal(suggest.anchor("g5").muted, false);
    assert.equal(suggest.get("g5"), "relee el estado");
  });
});
