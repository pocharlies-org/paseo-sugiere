import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

// The seq guard of server/suggest.ts: an answer from the router that lands after the session moved on must not show.
// This file mocks the session module before importing suggest, so it lives apart from the rest of the tests (own process).
const TRANSCRIPT = ['{"type":"user","message":{"role":"user","content":"hola"}}'];
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
