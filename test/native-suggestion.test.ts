import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { nativeSuggestion } from "../server/session.ts";

// The file contract of the patched daemon : $PASEO_HOME/suggest/<claude-session-id>.json, consumed on read, fresh 15 min.
const HOME = join(tmpdir(), `paseo-native-${process.pid}`);
const paseo = { agents: { list: async () => ({ entries: [{ agent: { id: "a1", persistence: { sessionId: "s1" } } }] }) } } as never;
const put = (name: string, body: object) => {
  mkdirSync(join(HOME, "suggest"), { recursive: true });
  writeFileSync(join(HOME, "suggest", `${name}.json`), JSON.stringify(body));
};

describe("the native suggestion of the patched daemon", () => {
  before(() => {
    process.env.PASEO_HOME = HOME;
    rmSync(HOME, { recursive: true, force: true });
  });
  after(() => {
    rmSync(HOME, { recursive: true, force: true });
    delete process.env.PASEO_HOME;
  });

  it("is the text of the fresh file of the session, and the file is consumed", async () => {
    put("s1", { text: "ejecuta los tests", at: Date.now() });
    assert.equal(await nativeSuggestion("a1", paseo), "ejecuta los tests");
    assert.equal(await nativeSuggestion("a1", paseo), null); // consumida: un turno, una sugerencia
  });

  it("is null when stale (>15 min), malformed, empty or missing", async () => {
    put("s1", { text: "vieja", at: Date.now() - 16 * 60_000 });
    assert.equal(await nativeSuggestion("a1", paseo), null);
    put("s1", { text: "sin at" });
    assert.equal(await nativeSuggestion("a1", paseo), null);
    put("s1", { text: "   ", at: Date.now() });
    assert.equal(await nativeSuggestion("a1", paseo), null);
    rmSync(join(HOME, "suggest", "s1.json"), { force: true });
    assert.equal(await nativeSuggestion("a1", paseo), null);
  });
});
