import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { consumeNative, nativeSuggestion } from "../server/session.ts";
import { newestMessage } from "../shared/transcript.ts";

// The file contract of the patched daemon: $PASEO_HOME/.paseo/suggest/<claude-session-id>.json = {text, at}, written once per turn.
// The suggestion stays valid until the session's next message: `at` must be later than the newest conversation message of the
// main transcript (<CLAUDE_CONFIG_DIR>/projects/<proj>/<sid>.jsonl, found through the providers of $PASEO_HOME/config.json), and that
// message must close a turn. No time limit. The file is checked first and consumed only when its text is served (one native
// suggestion per turn); a file that is not served is never deleted. With no readable transcript: 15 minutes.
const ROOT = join(tmpdir(), `paseo-native-${process.pid}`);
const HOME = join(ROOT, "paseo");
const CLAUDE = join(ROOT, "claude");
const SUGGEST = join(HOME, ".paseo", "suggest", "s1.json");
const TRANSCRIPT = join(CLAUDE, "projects", "proj", "s1.jsonl");
const paseo = { agents: { list: async () => ({ entries: [{ agent: { id: "a1", persistence: { sessionId: "s1" } } }] }) } } as never;

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.now() - 3 * HOUR; // the turn ended three hours ago: far beyond the old 15 minutes
const iso = (ms: number) => new Date(ms).toISOString();
const line = (o: object) => JSON.stringify(o);
const user = (ms: number, text = "haz la tarea", extra: object = {}) => line({ type: "user", timestamp: iso(ms), message: { role: "user", content: [{ type: "text", text }] }, ...extra });
const toolResult = (ms: number) => line({ type: "user", timestamp: iso(ms), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
const closing = (ms: number, extra: object = {}) => line({ type: "assistant", timestamp: iso(ms), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "listo" }] }, ...extra });
const toolUse = (ms: number) => line({ type: "assistant", timestamp: iso(ms), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
const bookkeeping = (ms: number) => [
  line({ type: "attachment", timestamp: iso(ms), attachment: { type: "hook_success" } }),
  line({ type: "api-request", timestamp: iso(ms) }),
  line({ type: "system", subtype: "stop_hook_summary", timestamp: iso(ms) }),
  line({ type: "pr-link", timestamp: iso(ms), prUrl: "https://example.com/pr/1" }),
  line({ type: "queue-operation", operation: "enqueue", timestamp: iso(ms) }),
  line({ type: "last-prompt", lastPrompt: "x" }), // no timestamp at all
];
const transcript = (...lines: string[]) => {
  mkdirSync(join(TRANSCRIPT, ".."), { recursive: true });
  writeFileSync(TRANSCRIPT, lines.join("\n") + "\n");
};
const put = (body: object | string, file = SUGGEST) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
};
const config = (body: string = JSON.stringify({ agents: { providers: { claude: { env: { CLAUDE_CONFIG_DIR: CLAUDE } } } } })) => writeFileSync(join(HOME, "config.json"), body);

describe("the native suggestion of the patched daemon", () => {
  before(() => {
    process.env.PASEO_HOME = HOME;
  });
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(HOME, { recursive: true });
    config();
  });
  after(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.PASEO_HOME;
  });

  describe("valid until the next message of the session", () => {
    it("is the text of the file when it landed after the closing answer, however long ago (no 15-minute limit)", async () => {
      transcript(user(T0), toolUse(T0 + 5_000), toolResult(T0 + 6_000), closing(T0 + 10_000));
      put({ text: " ejecuta los tests ", at: T0 + 37_000 });
      assert.equal(await nativeSuggestion("a1", paseo), "ejecuta los tests");
    });

    it("goes stale with any user message after it: the user's, Seguir's, a tool result of a new turn", async () => {
      put({ text: "vieja", at: T0 + 37_000 });
      transcript(user(T0), closing(T0 + 10_000), user(T0 + 2 * HOUR, "otra cosa"));
      assert.equal(await nativeSuggestion("a1", paseo), null);
      transcript(user(T0), closing(T0 + 10_000), user(T0 + 2 * HOUR, "[SEGUIMIENTO] sigue con el merge"));
      assert.equal(await nativeSuggestion("a1", paseo), null);
      transcript(user(T0), closing(T0 + 10_000), user(T0 + 2 * HOUR), toolUse(T0 + 2 * HOUR + 1_000), toolResult(T0 + 2 * HOUR + 2_000), closing(T0 + 2 * HOUR + 9_000));
      assert.equal(await nativeSuggestion("a1", paseo), null);
    });

    it("goes stale when it is not strictly after the newest message", async () => {
      transcript(user(T0), closing(T0 + 10_000));
      put({ text: "a la vez", at: T0 + 10_000 });
      assert.equal(await nativeSuggestion("a1", paseo), null);
    });

    it("goes stale when a fork of turn N lands after turn N+1 started: the newest line is a user message or a tool step, not a closing answer", async () => {
      put({ text: "del turno N", at: T0 + 30_000 });
      transcript(user(T0), closing(T0 + 10_000), user(T0 + 20_000, "siguiente"));
      assert.equal(await nativeSuggestion("a1", paseo), null);
      transcript(user(T0), closing(T0 + 10_000), user(T0 + 20_000, "siguiente"), toolUse(T0 + 22_000));
      assert.equal(await nativeSuggestion("a1", paseo), null);
      transcript(user(T0), closing(T0 + 10_000), user(T0 + 20_000, "siguiente"), toolUse(T0 + 22_000), toolResult(T0 + 25_000));
      assert.equal(await nativeSuggestion("a1", paseo), null);
    });

    it("ignores what is not conversation: sub-agent and meta lines, attachments, hooks, api requests, pr links, queue entries", async () => {
      put({ text: "sigue valida", at: T0 + 37_000 });
      transcript(
        user(T0),
        closing(T0 + 10_000),
        user(T0 + HOUR, "mensaje de un subagente", { isSidechain: true }),
        closing(T0 + HOUR + 1_000, { isSidechain: true }),
        user(T0 + 2 * HOUR, "contexto inyectado", { isMeta: true }),
        ...bookkeeping(T0 + 2 * HOUR),
      );
      assert.equal(await nativeSuggestion("a1", paseo), "sigue valida");
    });

    it("finds the newest message behind a long run of bookkeeping lines at the end of a big transcript", async () => {
      const filler = Array.from({ length: 4_000 }, (_, i) => line({ type: "attachment", timestamp: iso(T0 + HOUR + i), attachment: { type: "hook_success", stdout: "x".repeat(200) } }));
      transcript(user(T0), closing(T0 + 10_000), ...filler); // ~1 MB after the closing answer: past the first window
      put({ text: "tras mucho relleno", at: T0 + 37_000 });
      assert.equal(await nativeSuggestion("a1", paseo), "tras mucho relleno");
      transcript(user(T0), closing(T0 + 10_000), ...filler, user(T0 + 2 * HOUR, "otra"));
      assert.equal(await nativeSuggestion("a1", paseo), null);
    });
  });

  describe("the file is checked first and consumed only when its text is served", () => {
    it("serving consumes it: the same turn gets one native suggestion, the second read finds none", async () => {
      transcript(user(T0), closing(T0 + 10_000));
      put({ text: "ejecuta los tests", at: T0 + 37_000 });
      assert.equal(await nativeSuggestion("a1", paseo), "ejecuta los tests");
      assert.equal(existsSync(SUGGEST), false);
      assert.equal(await nativeSuggestion("a1", paseo), null);
    });

    it("a stale file is not deleted by a read: it is read, judged and left (the next turn overwrites it)", async () => {
      transcript(user(T0), closing(T0 + 10_000), user(T0 + HOUR));
      put({ text: "vieja", at: T0 + 37_000 });
      assert.equal(await nativeSuggestion("a1", paseo), null);
      assert.ok(existsSync(SUGGEST));
      transcript(user(T0), closing(T0 + 10_000), user(T0 + HOUR), toolUse(T0 + HOUR + 1_000)); // a fork that landed mid-turn
      put({ text: "a medio turno", at: T0 + HOUR + 2_000 });
      assert.equal(await nativeSuggestion("a1", paseo), null);
      assert.ok(existsSync(SUGGEST));
    });

    it("a malformed, empty or incomplete file is not deleted by a read either", async () => {
      transcript(user(T0), closing(T0 + 10_000));
      for (const body of ["{not json", "[]", { text: "sin at" }, { text: "   ", at: T0 + 37_000 }, { at: T0 + 37_000 }]) {
        put(body);
        assert.equal(await nativeSuggestion("a1", paseo), null, JSON.stringify(body));
        assert.ok(existsSync(SUGGEST), JSON.stringify(body));
      }
    });

    it("a file older than 15 minutes is served and consumed when the transcript says it is current (no time limit)", async () => {
      transcript(user(T0), closing(T0 + 10_000));
      put({ text: "tres horas despues", at: T0 + 37_000 });
      assert.equal(await nativeSuggestion("a1", paseo), "tres horas despues");
      assert.equal(existsSync(SUGGEST), false);
    });

    it("a newer fork that landed between the check and the delete survives: only the file that was served is consumed", async () => {
      put({ text: "del turno N+1", at: T0 + HOUR + 30_000 });
      await consumeNative(SUGGEST, T0 + 37_000); // the one that was served is the turn N's: the file on disk is not it
      assert.deepEqual(JSON.parse(readFileSync(SUGGEST, "utf8")), { text: "del turno N+1", at: T0 + HOUR + 30_000 });
      await consumeNative(SUGGEST, T0 + HOUR + 30_000); // the same `at`: consumed
      assert.equal(existsSync(SUGGEST), false);
    });

    it("consuming a file that is gone, half written or not JSON does nothing and does not throw", async () => {
      await consumeNative(SUGGEST, 1); // missing
      put("{\"text\":\"cortado");
      await consumeNative(SUGGEST, 1);
      assert.ok(existsSync(SUGGEST));
      put("");
      await consumeNative(SUGGEST, 1);
      assert.ok(existsSync(SUGGEST));
    });
  });

  describe("with no readable transcript: the old rule, valid only if at most 15 minutes old", () => {
    const fresh = () => put({ text: "reciente", at: Date.now() - 5 * MIN });
    const old = () => put({ text: "vieja", at: Date.now() - 16 * MIN });

    it("no transcript on disk", async () => {
      fresh();
      assert.equal(await nativeSuggestion("a1", paseo), "reciente");
      old();
      assert.equal(await nativeSuggestion("a1", paseo), null);
    });

    it("unreadable: Paseo's config cannot be read or parsed", async () => {
      transcript(user(T0), closing(T0 + 10_000), user(T0 + HOUR)); // a transcript that would make it stale, if it could be found
      config("{not json");
      fresh();
      assert.equal(await nativeSuggestion("a1", paseo), "reciente");
      old();
      assert.equal(await nativeSuggestion("a1", paseo), null);
      rmSync(join(HOME, "config.json"));
      fresh();
      assert.equal(await nativeSuggestion("a1", paseo), "reciente");
    });

    it("a transcript with no conversation message in it", async () => {
      transcript(...bookkeeping(T0));
      fresh();
      assert.equal(await nativeSuggestion("a1", paseo), "reciente");
      old();
      assert.equal(await nativeSuggestion("a1", paseo), null);
    });

    it("the same consume rule: a file served by the fallback is consumed, one refused by it is left", async () => {
      fresh();
      assert.equal(await nativeSuggestion("a1", paseo), "reciente");
      assert.equal(existsSync(SUGGEST), false);
      old();
      assert.equal(await nativeSuggestion("a1", paseo), null);
      assert.ok(existsSync(SUGGEST));
    });
  });

  describe("bad files", () => {
    it("is null with no session: the agent has no Claude session id, so there is no file to read (the 15 minutes do not apply)", async () => {
      put({ text: "reciente", at: Date.now() - MIN });
      const sinSesion = { agents: { list: async () => ({ entries: [{ agent: { id: "a1" } }] }) } } as never;
      assert.equal(await nativeSuggestion("a1", sinSesion), null);
      assert.equal(await nativeSuggestion("otro", paseo), null);
      assert.ok(existsSync(SUGGEST));
    });

    it("is null when malformed, empty, missing, without text or at, or with a blank text", async () => {
      transcript(user(T0), closing(T0 + 10_000));
      for (const body of ["{not json", "", "[]", "null", { text: "sin at" }, { at: T0 + 37_000 }, { text: 7, at: T0 + 37_000 }, { text: "at texto", at: "1" }, { text: "   ", at: T0 + 37_000 }]) {
        put(body);
        assert.equal(await nativeSuggestion("a1", paseo), null, JSON.stringify(body));
      }
      rmSync(SUGGEST, { force: true });
      assert.equal(await nativeSuggestion("a1", paseo), null);
    });
  });
});

describe("the newest conversation message of a transcript", () => {
  it("is the latest by timestamp, the later line winning a tie, and says whether it closes a turn", () => {
    assert.deepEqual(newestMessage([user(T0), closing(T0 + 1_000)]), { at: T0 + 1_000, endsTurn: true });
    assert.deepEqual(newestMessage([user(T0), closing(T0 + 1_000), user(T0 + 2_000)]), { at: T0 + 2_000, endsTurn: false });
    assert.deepEqual(newestMessage([user(T0), toolUse(T0 + 1_000)]), { at: T0 + 1_000, endsTurn: false });
    assert.deepEqual(newestMessage([closing(T0 + 5_000), user(T0)]), { at: T0 + 5_000, endsTurn: true }); // by time, not by position
    assert.deepEqual(newestMessage([toolUse(T0 + 1_000), closing(T0 + 1_000)]), { at: T0 + 1_000, endsTurn: true });
    assert.deepEqual(newestMessage([line({ type: "assistant", timestamp: iso(T0), message: { role: "assistant", content: "texto plano" } })]), { at: T0, endsTurn: true });
  });

  it("is null with no usable line: bookkeeping only, no timestamp, a bad timestamp, a cut line, sidechain or meta only", () => {
    assert.equal(newestMessage([]), null);
    assert.equal(newestMessage(bookkeeping(T0)), null);
    assert.equal(newestMessage([line({ type: "user", message: { role: "user", content: "x" } })]), null);
    assert.equal(newestMessage([line({ type: "user", timestamp: 123, message: { role: "user", content: "x" } }), line({ type: "user", timestamp: "mañana", message: {} })]), null);
    assert.equal(newestMessage(['{"type":"user","timestamp":"2026-11-2']), null);
    assert.equal(newestMessage([user(T0, "x", { isSidechain: true }), closing(T0, { isMeta: true })]), null);
  });
});
