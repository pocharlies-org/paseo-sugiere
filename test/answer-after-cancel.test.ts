import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";

// The seq guard of server/suggest.ts: an answer from the router that lands after the session moved on must not show.
// This file mocks the session module before importing suggest, so it lives apart from the rest of the tests (own process).
const TRANSCRIPT = [
  '{"type":"user","message":{"role":"user","content":"hola"}}',
  '{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5-5","content":"hola, dime"}}', // a session with no real model gets no call
];
mock.module(new URL("../server/session.ts", import.meta.url).href, {
  namedExports: {
    SessionError: class extends Error {},
    locateSession: async () => TRANSCRIPT,
    routerRequest: async () => ({ status: 200, text: JSON.stringify({ content: [{ type: "text", text: "sigue con el merge" }] }) }),
  },
});
const suggest = await import("../server/suggest.ts");
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("an answer that lands after the quiet window moved on", () => {
  before(() => suggest.setAuto(true)); // the quiet window only fires with auto (default off, Dani 25-10)
  it("is dropped when a turn started meanwhile", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    suggest.arm("a1", {} as never);
    mock.timers.tick(61_000); // the generation starts; the router answer is still in flight
    suggest.cancel("a1");
    await flush();
    assert.equal(suggest.get("a1"), null);
    mock.timers.reset();
  });

  it("is kept when nothing happened (control: the same path stores it)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    suggest.arm("a2", {} as never);
    mock.timers.tick(61_000);
    await flush();
    assert.equal(suggest.get("a2"), "sigue con el merge");
    mock.timers.reset();
  });
});

describe("force: the pill click with nothing suggested (Dani 19-10)", () => {
  it("returns at once (the RPC must not wait for the router) and the answer lands after", async () => {
    assert.equal(suggest.force("f1", {} as never), true);
    assert.deepEqual(suggest.state("f1"), { pending: true, error: null }); // the pill spins from the click
    await flush();
    assert.equal(suggest.get("f1"), "sigue con el merge");
    assert.deepEqual(suggest.state("f1"), { pending: false, error: null }); // settled clean: no error to show
  });

  it("kills the pending quiet window: the forced answer is the only one that can land", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      suggest.arm("f2", {} as never);
      assert.equal(suggest.force("f2", {} as never), true);
      await flush();
      mock.timers.tick(61_000); // the armed timer was cleared by force: nothing re-fires
      await flush();
      assert.equal(suggest.get("f2"), "sigue con el merge");
    } finally {
      suggest.dispose();
      mock.timers.reset();
    }
  });
});
