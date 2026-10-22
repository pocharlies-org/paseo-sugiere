import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

// A session with no real model yet (no assistant message, or only "<synthetic>" ones) gets no call and no fallback model (Dani 22-10):
// the force settles with a visible error. Own file: it mocks the session module before importing suggest (own process).
let calls = 0;
let transcript = ['{"type":"user","message":{"role":"user","content":"hola"}}'];
mock.module(new URL("../server/session.ts", import.meta.url).href, {
  namedExports: {
    SessionError: class extends Error {},
    locateSession: async () => transcript,
    routerRequest: async (body: string) => {
      calls += 1;
      return { status: 200, text: JSON.stringify({ model: JSON.parse(body).model, content: [{ type: "text", text: "sigue con el merge" }] }) };
    },
  },
});
const suggest = await import("../server/suggest.ts");
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("a session with no real model", () => {
  it("makes no call and settles the force with a visible error", async () => {
    suggest.force("n1", {} as never);
    await flush();
    assert.equal(calls, 0);
    assert.equal(suggest.get("n1"), null);
    assert.deepEqual(suggest.state("n1"), { pending: false, error: "la sesión aún no tiene modelo" });
  });

  it("only synthetic assistants count as no model either", async () => {
    transcript = [...transcript, '{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":"No response requested."}}'];
    suggest.force("n2", {} as never);
    await flush();
    assert.equal(calls, 0);
    assert.deepEqual(suggest.state("n2"), { pending: false, error: "la sesión aún no tiene modelo" });
  });

  it("calls once the session has a real model", async () => {
    transcript = [...transcript, '{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5-5","content":"hola, dime"}}'];
    suggest.force("n3", {} as never);
    await flush();
    assert.equal(calls, 1);
    assert.equal(suggest.get("n3"), "sigue con el merge");
  });
});
