import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// The pill with the real session module and real files: the native suggestion is shown hours after the turn, and serving it consumes
// the file, so a second force of the same turn (after a dismissal, say) goes to the service, as before the native file lived on.
// A native file that is not served (the session moved on) is left where it is. The service and Paseo are fakes; HOME is a scratch
// dir, set before the modules read their paths.
const ROOT = mkdtempSync(join(tmpdir(), "native-pill-"));
process.env.HOME = ROOT;
process.env.PASEO_HOME = join(ROOT, "paseo");
process.env.SUGIERE_URL = "http://sugiere.test:8080";
const suggest = await import("../server/suggest.ts");

const SUGGEST = join(ROOT, "paseo", ".paseo", "suggest", "s1.json");
const TRANSCRIPT = join(ROOT, "claude", "projects", "p", "s1.jsonl");
const T0 = Date.now() - 3 * 3_600_000; // the turn ended three hours ago
const iso = (ms: number) => new Date(ms).toISOString();
const turn = (ms: number) => [
  JSON.stringify({ type: "user", timestamp: iso(ms), message: { role: "user", content: [{ type: "text", text: "haz la tarea" }] } }),
  JSON.stringify({ type: "assistant", timestamp: iso(ms + 10_000), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "listo" }] } }),
];
const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};
const native = (text: string, at: number) => write(SUGGEST, JSON.stringify({ text, at }));

let servicio: string[] = [];
let llamadas = 0;
globalThis.fetch = (async () => {
  llamadas++;
  return new Response(JSON.stringify({ modelo: "claude-opus-5-5", sugerencia: servicio.shift() ?? "" }), { status: 200 });
}) as typeof fetch;
const paseo = { agents: { list: async () => ({ entries: [{ agent: { id: "a1", persistence: { sessionId: "s1" } } }] }) } };
const ctx = { paseo } as never;
const forzar = async () => {
  suggest.force("a1", ctx);
  const deadline = Date.now() + 10_000;
  while (suggest.state("a1").pending) {
    assert.ok(Date.now() < deadline, "timed out waiting for the force");
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe("the pill and the native suggestion", () => {
  beforeEach(() => {
    suggest.dispose();
    suggest.setEnabled(true);
    suggest.setAuto(false);
    servicio = [];
    llamadas = 0;
    rmSync(SUGGEST, { force: true });
    write(join(ROOT, "paseo", "config.json"), JSON.stringify({ agents: { providers: { claude: { env: { CLAUDE_CONFIG_DIR: join(ROOT, "claude") } } } } }));
    write(TRANSCRIPT, turn(T0).join("\n") + "\n");
  });
  after(() => rmSync(ROOT, { recursive: true, force: true }));

  it("shows the native text hours after the turn, with no call to the service, and consumes the file", async () => {
    native("ejecuta los tests", T0 + 37_000);
    await forzar();
    assert.equal(suggest.get("a1"), "ejecuta los tests");
    assert.equal(llamadas, 0); // the transcript is not resent
    assert.equal(existsSync(SUGGEST), false);
  });

  it("a second force of the same turn goes to the service: one native suggestion per turn, a dismissal gets an alternative", async () => {
    native("ejecuta los tests", T0 + 37_000);
    servicio = ["revisa el diff"];
    await forzar();
    assert.equal(suggest.get("a1"), "ejecuta los tests");
    suggest.cancel("a1"); // the pill dismisses it
    assert.equal(suggest.get("a1"), null);
    await forzar();
    assert.equal(suggest.get("a1"), "revisa el diff");
    assert.equal(llamadas, 1);
  });

  it("«no es esto» on the native text, then a re-force: the service answers, not the same native text", async () => {
    native("ejecuta los tests", T0 + 37_000);
    servicio = ["revisa el diff"];
    await forzar();
    suggest.feedback("a1", "no-es-esto");
    assert.equal(suggest.get("a1"), null);
    await forzar();
    assert.equal(suggest.get("a1"), "revisa el diff");
  });

  it("a native file the user already answered is not shown and not deleted: the next message made it stale", async () => {
    native("ejecuta los tests", T0 + 37_000);
    write(TRANSCRIPT, [...turn(T0), ...turn(T0 + 3_600_000)].join("\n") + "\n");
    servicio = ["revisa el diff"];
    await forzar();
    assert.equal(suggest.get("a1"), "revisa el diff");
    assert.equal(llamadas, 1);
    assert.ok(existsSync(SUGGEST)); // left for the next turn to overwrite
  });

  it("the fork of the next turn is served again: consuming one turn's file does not touch the next", async () => {
    native("del turno uno", T0 + 37_000);
    await forzar();
    assert.equal(suggest.get("a1"), "del turno uno");
    write(TRANSCRIPT, [...turn(T0), ...turn(T0 + 3_600_000)].join("\n") + "\n");
    native("del turno dos", T0 + 3_600_000 + 37_000);
    await forzar();
    assert.equal(suggest.get("a1"), "del turno dos");
    assert.equal(llamadas, 0);
  });
});
