import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

// The same session id in two projects (a session copied to another workspace) — the live copy is the newest one.
it("locateSession reads the most recently written copy of a duplicated transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "sugiere-dup-"));
  const claude = join(root, "claude");
  process.env.PASEO_HOME = join(root, "paseo");
  mkdirSync(process.env.PASEO_HOME);
  writeFileSync(join(process.env.PASEO_HOME, "config.json"), JSON.stringify({ agents: { providers: { claude: { env: { CLAUDE_CONFIG_DIR: claude } } } } }));
  const copy = (project: string, text: string, ageS: number) => {
    mkdirSync(join(claude, "projects", project), { recursive: true });
    const file = join(claude, "projects", project, "s1.jsonl");
    writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: text } }));
    const t = Date.now() / 1000 - ageS;
    utimesSync(file, t, t);
  };
  copy("-a-vieja", "vieja", 3600); // listed first, written long ago
  copy("-b-viva", "viva", 0);
  const paseo = { agents: { list: async () => ({ entries: [{ agent: { id: "a1", persistence: { sessionId: "s1" } } }] }) } };
  const { locateSession } = await import("../server/session.ts");
  const lines = await locateSession("a1", paseo as never);
  assert.match(lines.join("\n"), /"viva"/);
});
