import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { CLAUDE_CODE_SYSTEM, SUGGESTION_INSTRUCTION, suggestBody, suggestionAnswer } from "../shared/suggest.ts";
import { litellmDoor } from "../server/session.ts";
import * as suggest from "../server/suggest.ts";

// The two decisions that decide what the user sees — the body of the one call, and what counts as a suggestion — plus
// the bookkeeping of the quiet window. The transport is `server/session.ts`: the same router call the account plugin's side questions make.
const line = (o: object) => JSON.stringify(o);
const user = (content: unknown) => line({ type: "user", message: { role: "user", content } });
const as = (content: unknown, model = "claude-opus-5-5") => line({ type: "assistant", message: { role: "assistant", model, content } });

describe("the body of the suggestion call", () => {
  it("is the transcript alone with the fixed instruction in system, the session's model and no tools", () => {
    const body = JSON.parse(suggestBody([user("monta el pill"), as([{ type: "text", text: "listo" }])])!.body);
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.max_tokens, 256);
    assert.equal(body.reasoning_effort, "none"); // without it a thinking session returns only a thinking block and the suggestion is empty (Dani 25-10)
    assert.deepEqual(body.tools, []);
    assert.equal(CLAUDE_CODE_SYSTEM, "You are Claude Code, Anthropic's official CLI for Claude.");
    assert.deepEqual(body.system, [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }, // without it LiteLLM's subscription accounts answer 429 (measured 22-10)
      { type: "text", text: SUGGESTION_INSTRUCTION },
    ]);
    assert.equal(body.messages.length, 3); // transcript + the constant trigger; the instruction never rides as a user turn
    assert.equal(body.messages[1].role, "assistant");
    assert.equal(body.messages[2].role, "user"); // the trigger: without it the model continues the assistant's last turn (measured 14-10)
  });

  it("uses the model of the LAST assistant message (the session may have switched model)", () => {
    const lines = [user("a"), as([{ type: "text", text: "uno" }], "claude-sonnet-5-5"), user("b"), as([{ type: "text", text: "dos" }], "claude-opus-5-5")];
    assert.equal(suggestBody(lines)!.model, "claude-opus-5-5");
    assert.equal(JSON.parse(suggestBody(lines)!.body).model, "claude-opus-5-5");
    assert.equal(suggestBody([...lines.slice(0, 2), user("b")])!.model, "claude-sonnet-5-5");
  });

  it('skips "<synthetic>" (Claude Code writes it on messages it made up) and keeps the last real model', () => {
    const lines = [user("a"), as([{ type: "text", text: "uno" }]), user("b"), as([{ type: "text", text: "No response requested." }], "<synthetic>")];
    assert.equal(suggestBody(lines)!.model, "claude-opus-5-5");
  });

  it("with no assistant, or only synthetic ones, there is no body and so no call, and no fallback model", () => {
    assert.equal(suggestBody([user("hola")]), null);
    assert.equal(suggestBody([]), null);
    assert.equal(suggestBody([user("hola"), as([{ type: "text", text: "x" }], "<synthetic>")]), null);
    assert.equal(suggestBody([user("hola"), as([{ type: "text", text: "x" }], "")]), null);
    assert.equal(suggestBody([user("hola"), line({ type: "assistant", message: { role: "assistant", content: "x" } })]), null); // no model field at all
  });

  it("takes the configured prompt as system, and the built-in one when it is blank (Dani 16-10: editable prompt)", () => {
    const body = JSON.parse(suggestBody([user("monta el pill"), as([{ type: "text", text: "listo" }])], "recomienda en una línea, en inglés")!.body);
    assert.equal(body.system[0].text, CLAUDE_CODE_SYSTEM);
    assert.equal(body.system.length, 2);
    assert.equal(body.system[1].text, "recomienda en una línea, en inglés");
    assert.equal(JSON.parse(suggestBody([user("monta el pill"), as([{ type: "text", text: "listo" }])], "   ")!.body).system[1].text, SUGGESTION_INSTRUCTION);
  });

  it("keeps the guard that a step the USER takes outside the conversation means no suggestion (measured 14-10: «mide la longitud del cañón»)", () => {
    assert.match(SUGGESTION_INSTRUCTION, /fuera de la conversación/);
    assert.match(SUGGESTION_INSTRUCTION, /lo que falta es acción o decisión del usuario[\s\S]*línea vacía/);
    assert.match(SUGGESTION_INSTRUCTION, /objetivo: lo que el usuario pidió al principio/);
    assert.match(SUGGESTION_INSTRUCTION, /está TERMINADO: no lo continúes/);
  });

  it("leaves a transcript that ends with the user untouched (the measured misfire)", () => {
    const body = JSON.parse(suggestBody([as([{ type: "text", text: "listo" }]), user("y ahora?")])!.body);
    assert.equal(body.messages.length, 3); // transcript (2) + trigger
    assert.equal(body.messages[1].content.length, 1);
  });

  it("strips tool calls and results: the model must see the conversation, not the tool noise (measured 14-10: answered «[called Bash]»)", () => {
    const body = JSON.parse(
      suggestBody([
        user("arregla el parseo"),
        as([{ type: "tool_use", name: "Bash", id: "t1" }, { type: "text", text: "arreglado, pasa el test" }]),
        user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
        as([{ type: "tool_use", name: "Bash", id: "t2" }]),
      ])!.body,
    );
    assert.equal(body.messages.length, 3); // user + assistant + trigger: the tool noise is gone
    assert.deepEqual(body.messages[1].content, [{ type: "text", text: "arreglado, pasa el test" }]);
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

  it("a question to the user is the assistant's voice, not a sendable order", () => {
    assert.equal(suggestionAnswer(answer("¿quieres que revise el log?")), "");
    assert.equal(suggestionAnswer(answer("revisa el log?")), "");
    assert.equal(suggestionAnswer(answer("revisa el log")), "revisa el log");
  });

  it("a transcript marker mimicked by the model is nothing to suggest", () => {
    assert.equal(suggestionAnswer(answer("[called Bash]")), "");
    assert.equal(suggestionAnswer(answer("[thinking]")), "");
    assert.equal(suggestionAnswer(answer("[ejecuta] los tests")), "[ejecuta] los tests");
  });
});

describe("the model door of this machine (LiteLLM, not the retired loopback router)", () => {
  it("reads url and token from the env file and refuses a partial one", async () => {
    const f = join(tmpdir(), `litellm-env-${process.pid}`);
    process.env.CLAUDE_LOCAL_ENV = f;
    try {
      writeFileSync(f, 'export ANTHROPIC_BASE_URL="https://litellm.example.test"\nexport OTHER=x\nexport ANTHROPIC_AUTH_TOKEN=\'sk-a=b\'\n');
      assert.deepEqual(await litellmDoor(), { url: "https://litellm.example.test", token: "sk-a=b" }); // the key may hold `=`
      writeFileSync(f, "export ANTHROPIC_BASE_URL=https://x\n"); // token missing
      assert.deepEqual(await litellmDoor(), { url: "", token: "" });
      writeFileSync(f, ""); // file empty
      assert.deepEqual(await litellmDoor(), { url: "", token: "" });
    } finally {
      delete process.env.CLAUDE_LOCAL_ENV;
      rmSync(f, { force: true });
    }
  });
});

describe("the off switch", () => {
  it("disabling drops everything and arms nothing", () => {
    suggest.setEnabled(false);
    try {
      suggest.arm("off1", { paseo: { agents: { list: async () => ({ entries: [] }) } } } as never);
      assert.equal(suggest.get("off1"), null);
    } finally {
      suggest.setEnabled(true);
    }
  });
});

describe("the state of a force (Dani 19-10: spinner while it runs, clear error if it does not)", () => {
  it("pends from the click and settles with a readable error when the session cannot be read", async () => {
    const broken = { paseo: { agents: { list: async () => { throw new Error("no daemon"); } } } } as any;
    suggest.force("f1", broken);
    assert.deepEqual(suggest.state("f1"), { pending: true, error: null });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(suggest.state("f1"), { pending: false, error: "the session could not be read on this machine" });
  });
});

describe("the quiet window", () => {
  it("does not fire without auto: the click of the pill is the only call (Dani 25-10)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const broken = { paseo: { agents: { list: async () => { throw new Error("no daemon"); } } } } as any;
      suggest.setAuto(false); // the default: no automatic generation
      suggest.arm("a0", broken);
      mock.timers.tick(61_000);
      await new Promise((r) => setImmediate(r));
      assert.equal(suggest.get("a0"), null);
      assert.equal(suggest.state("a0").error, null); // nothing was armed, so nothing failed
    } finally {
      suggest.dispose();
      mock.timers.reset();
    }
  });

  it("a cancelled agent has nothing, and a failed generation stays silent", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const broken = { paseo: { agents: { list: async () => { throw new Error("no daemon"); } } } } as any;
      suggest.setAuto(true); // the window only runs with auto on
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
