import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Render the plugin with host primitives, without loading React Native's native runtime in Node.
test("suggestion card uses the sheet-aware input, edits before sending and has a reachable mobile button", async () => {
  const source = readFileSync(new URL("../client/suggest-pill.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  let states: unknown[] = [];
  let cursor = 0;
  let effects: Array<() => void> = [];
  const jsx = (type: unknown, props: any) => ({ type, props });
  const modules: Record<string, unknown> = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial; // React runs lazy initializers
        return [states[index], (value: unknown) => { states[index] = value; }];
      },
      useEffect(effect: () => void) { if (!states.length || states[0] === null) effects.push(effect); },
      useMemo: (factory: () => unknown) => factory(),
    },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", TextInput: "UnsafeInput" },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon", TextInput: "SheetAwareInput" },
    "../shared/contract.ts": { suggestGet: "get", suggestForce: "force" },
    "./composer-bridge.ts": { insertSuggestion: () => false },
  };
  const exports: any = {};
  let poll: () => void = () => {};
  new Function("require", "exports", "setInterval", "clearInterval", outputText)(
    (name: string) => { assert.ok(name in modules, name); return modules[name]; },
    exports,
    (callback: () => void) => { poll = callback; return 1; },
    () => {},
  );
  let button: any;
  const sent: string[] = [];
  const stop = exports.addSuggestPill({
    addComposerPill: ({ button: next }: any) => {
      button = next;
      return { update: (next: unknown) => { button = next; }, remove() {} };
    },
    rpc: async () => ({ text: "Original suggestion" }),
    paseo: { agents: {
      list: async () => ({ subscription: { subscribe: ({ snapshot }: any) => snapshot({
        entries: [{ agent: { id: "a", workspaceId: "w", status: "idle" } }],
      }) } }),
      ref: () => ({ send: (text: string) => { sent.push(text); } }),
    } },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  poll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(button.behavior.kind, "popover", JSON.stringify(button));
  const theme = { colors: { foreground: "white", accent: "green", accentForeground: "black" } };
  for (const compact of [true, false]) {
    states = [];
    let closed = false;
    const element = button.behavior.Content({ theme, layout: { compact }, close: () => { closed = true; } });
    const render = () => { cursor = 0; return element.type(element.props); };
    assert.equal(render(), null);
    effects.splice(0).forEach((effect) => effect());
    let card = render();
    const [input, hint, send] = card.props.children;
    assert.equal(hint, null, "a short suggestion needs no scroll hint");
    assert.equal(input.type, "SheetAwareInput");
    assert.equal(closed, false);
    assert.equal(card.props.style.flexDirection, compact ? "column" : "row");
    if (compact) {
      assert.ok(send.props.style.height >= 44);
      assert.ok(send.props.style.minWidth >= 44);
      assert.equal(send.props.style.alignSelf, "flex-start");
      assert.ok(input.props.style.fontSize >= 16);
      assert.ok(input.props.style.height >= 4 * 22, "mobile field shows at least four rows");
      assert.equal(input.props.style.borderWidth, 1, "mobile field is framed so its edge reads as a scrollable box");
    }
    input.props.onChangeText("Edited suggestion");
    card = render();
    card.props.children[2].props.onPress();
    assert.equal(sent.at(-1), "Edited suggestion");
    assert.equal(closed, true);
  }
  stop();
  assert.equal(exports.textRows("corta"), 1);
  assert.equal(exports.textRows("a".repeat(68) + "\nb"), 3);
  assert.ok(exports.textRows("palabra ".repeat(60)) > 10, "a long suggestion overflows ten rows and gets the hint");
});
