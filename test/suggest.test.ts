import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { SUGGESTION_INSTRUCTION, suggestBody, suggestionAnswer } from "../shared/suggest.ts";
import * as suggest from "../server/suggest.ts";

// The two decisions that decide what the user sees — the body of the one call, and what counts as a suggestion — plus
// the bookkeeping of the quiet window. The transport is `server/session.ts`: the same router call the account plugin's side questions make.
const line = (o: object) => JSON.stringify(o);
const user = (content: unknown) => line({ type: "user", message: { role: "user", content } });
const as = (content: unknown) => line({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content } });

describe("the body of the suggestion call", () => {
  it("is the transcript alone with the fixed instruction in system, the resident model and no tools", () => {
    const body = JSON.parse(suggestBody([user("monta el pill"), as([{ type: "text", text: "listo" }])]));
    assert.equal(body.model, "qwen38-off");
    assert.equal(body.max_tokens, 48);
    assert.deepEqual(body.tools, []);
    assert.equal(body.system, SUGGESTION_INSTRUCTION);
    assert.equal(body.messages.length, 2); // the transcript alone: the instruction never rides as a user turn
    assert.equal(body.messages[1].role, "assistant");
  });

  it("leaves a transcript that ends with the user untouched (the measured misfire)", () => {
    const body = JSON.parse(suggestBody([as([{ type: "text", text: "listo" }]), user("y ahora?")]));
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[1].content.length, 1);
  });
});

describe("what counts as a suggestion", () => {
  const answer = (text: string) => ({ content: [{ type: "text", text }] });

  it("is the first non-empty line, with quotes trimmed", () => {
    assert.equal(suggestionAnswer(answer("«Lanza el watcher de la PR.»")), "Lanza el watcher de la PR.");
    assert.equal(suggestionAnswer(answer("\n\nsigue con el merge\n")), "sigue con el merge");
  });

  it("an empty answer is a successful nothing-to-suggest", () => {
    assert.equal(suggestionAnswer(answer("   ")), "");
    assert.equal(suggestionAnswer({ content: [] }), "");
    assert.equal(suggestionAnswer(null), "");
  });

  it("a rambling answer is not a sendable line", () => {
    assert.equal(suggestionAnswer(answer("x".repeat(241))), "");
  });

  it("an echo of the assistant's last line is nothing to suggest", () => {
    assert.equal(suggestionAnswer(answer("listo"), "listo"), "");
    assert.equal(suggestionAnswer(answer("[called Bash]"), "[called Bash]"), "");
    assert.equal(suggestionAnswer(answer("sigue con el merge"), "listo"), "sigue con el merge");
  });
});

describe("the quiet window", () => {
  it("a cancelled agent has nothing, and a failed generation stays silent", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const broken = { paseo: { agents: { list: async () => { throw new Error("no daemon"); } } } } as any;
      suggest.arm("a1", broken);
      suggest.cancel("a1");
      mock.timers.tick(61_000);
      await Promise.resolve();
      assert.equal(suggest.get("a1"), null);
      suggest.arm("a2", broken); // never cancelled: the generation runs and fails quietly
      mock.timers.tick(61_000);
      await new Promise((r) => setImmediate(r));
      assert.equal(suggest.get("a2"), null);
    } finally {
      suggest.dispose();
      mock.timers.reset();
    }
  });
});
