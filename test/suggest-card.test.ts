import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { gira } from "../client/estrella.ts";

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
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", TextInput: "UnsafeInput", AccessibilityInfo: {} },
    "@getpaseo/plugin/client/ui": { SettingsAction: "SettingsAction", SettingsSwitch: "SettingsSwitch" },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon", TextInput: "SheetAwareInput" },
    "../shared/contract.ts": { suggestGet: "get", suggestForce: "force", suggestFeedback: "feedback", autopilotSet: "autopilot" },
    "../shared/suggest.ts": { SUGGEST_WAIT_MS: 300_000 },
    "./composer-bridge.ts": { insertSuggestion: () => false },
    "./estrella.ts": { gira },
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
    addComposerPill: ({ id, button: next }: any) => {
      if (id !== "suggest") return { update() {}, remove() {} }; // «no es esto» lives in its own pill
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
    const [row, autopilot] = card.props.children;
    const [input, hint, send] = row.props.children;
    assert.equal(autopilot.props.autopilot.on, false, "the card carries the Autopilot switch (the mobile card)");
    assert.equal(hint, null, "a short suggestion needs no scroll hint");
    assert.equal(input.type, "SheetAwareInput");
    assert.equal(closed, false);
    assert.equal(row.props.style.flexDirection, compact ? "column" : "row");
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
    card.props.children[0].props.children[2].props.onPress();
    assert.equal(sent.at(-1), "Edited suggestion");
    assert.equal(closed, true);
  }
  stop();
  assert.equal(exports.textRows("corta"), 1);
  assert.equal(exports.textRows("a".repeat(68) + "\nb"), 3);
  assert.ok(exports.textRows("palabra ".repeat(60)) > 10, "a long suggestion overflows ten rows and gets the hint");
});

// A generation that finishes while the user is in another window must not put its text in that window's prompt: it waits on the
// pill of its own window until that button is pressed (Dani 02-11). The bridge here answers `true` — a working bridge — to prove
// the pill does not use it on its own.
test("a forced suggestion stays on the pill until its button is pressed", async () => {
  const source = readFileSync(new URL("../client/suggest-pill.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const inserted: string[] = [];
  const modules: Record<string, unknown> = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useState: (i: unknown) => [typeof i === "function" ? (i as () => unknown)() : i, () => {}], useEffect: () => {}, useMemo: (f: () => unknown) => f(), useRef: () => ({ current: null }) },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", AccessibilityInfo: {} },
    "@getpaseo/plugin/client/ui": { SettingsAction: "SettingsAction", SettingsSwitch: "SettingsSwitch" },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon", TextInput: "Input" },
    "../shared/contract.ts": { suggestGet: "get", suggestForce: "force", suggestFeedback: "feedback", autopilotSet: "autopilot" },
    "../shared/suggest.ts": { SUGGEST_WAIT_MS: 300_000 },
    "./composer-bridge.ts": {
      insertSuggestion: (agentId: string, text: string) => { inserted.push(`${agentId} ${text}`); return true; },
      registerPillAnchor: () => () => {},
    },
    "./estrella.ts": { gira },
  };
  let tick: () => void = () => {};
  const exports: any = {};
  new Function("require", "exports", "setInterval", "clearInterval", outputText)(
    (name: string) => { assert.ok(name in modules, name); return modules[name]; },
    exports,
    (callback: () => void) => { tick = callback; return 1; },
    () => {},
  );
  let button: any;
  const stop = exports.addSuggestPill({
    // The host's rule (validation.ts requireText): a label is undefined or non-blank, or the pill is never drawn.
    addComposerPill: ({ id, button: next }: any) => {
      const accept = (b: any) => { assert.ok(b.label === undefined || b.label.trim(), `the host refuses label ${JSON.stringify(b.label)}`); if (id === "suggest") button = b; };
      accept(next);
      return { update: accept, remove() {} };
    },
    rpc: async () => ({ started: true, text: "Forzada" }),
    paseo: {
      agents: {
        list: async () => ({ subscription: { subscribe: ({ snapshot }: any) => snapshot({ entries: [{ agent: { id: "a", workspaceId: "w", status: "idle" } }] }) } }),
        ref: () => ({ send: () => {} }),
      },
    },
  });
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settled();
  assert.equal(button.behavior.kind, "popover", "an idle agent with no suggestion yet shows the plain ✦, whose popover offers «Sugerir ahora»");
  let closed = false;
  const panel = button.behavior.Content({ theme: { colors: {} }, close: () => { closed = true; } });
  assert.equal(panel.props.autopilot.on, false, "next to the Autopilot switch");
  panel.props.suggestNow();
  assert.ok(closed, "pressing it closes the popover");
  await settled();
  await settled();
  assert.deepEqual(inserted, [], "the click only asks for a generation");
  tick(); // the resident answers
  await settled();
  assert.deepEqual(inserted, [], "the answer is not written into any prompt by itself");
  assert.equal(button.label, "Forzada", "it waits on the pill of its own window (the icon is already a Sparkles)");
  stop();
});

// With the autopilot on (Dani 07-11) the ✦ only speaks for it: gold with «esperando: …», red with «necesita acción: …», its
// popover is the switch, it stays reachable while a turn runs, and no suggestion or «no es esto» shows next to it.
test("a piloted ✦ is gold while it waits, red when it needs a person, and its popover is the switch", async () => {
  const source = readFileSync(new URL("../client/suggest-pill.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const modules: Record<string, unknown> = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useState: (i: unknown) => [i, () => {}], useEffect: () => {}, useMemo: (f: () => unknown) => f(), useRef: () => ({ current: null }) },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", AccessibilityInfo: {} },
    "@getpaseo/plugin/client/ui": { SettingsAction: "SettingsAction", SettingsSwitch: "SettingsSwitch" },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon", TextInput: "Input" },
    "../shared/contract.ts": { suggestGet: "get", suggestForce: "force", suggestFeedback: "feedback", autopilotSet: "autopilot" },
    "../shared/suggest.ts": { SUGGEST_WAIT_MS: 300_000 },
    "./composer-bridge.ts": { insertSuggestion: () => false, registerPillAnchor: () => () => {} },
    "./estrella.ts": { gira },
  };
  let poll: () => void = () => {};
  const exports: any = {};
  new Function("require", "exports", "setInterval", "clearInterval", outputText)(
    (name: string) => modules[name],
    exports,
    (callback: () => void) => { poll = callback; return 1; },
    () => {},
  );
  let reply: any = { text: "una sugerencia vieja", en_plan: "en-plan", criterio: "c", muted: false, autopilot: { on: true, estado: "esperando", motivo: "ESPERA: ci" } };
  const toggles: unknown[] = [];
  const buttons: Record<string, any> = {};
  let update: (agent: object) => void = () => {};
  const stop = exports.addSuggestPill({
    addComposerPill: ({ id, button }: any) => {
      buttons[id] = button;
      return { update: (next: unknown) => { buttons[id] = next; }, remove() {} };
    },
    rpc: async (name: string, input: any) => {
      if (name !== "autopilot") return reply;
      toggles.push(input);
      return { on: input.on, estado: input.on ? "activo" : "apagado", motivo: "" };
    },
    paseo: { agents: {
      list: async () => ({ subscription: { subscribe: ({ snapshot, update: u }: any) => {
        update = (agent) => u({ type: "agent_update", payload: { kind: "upsert", agent } });
        snapshot({ entries: [{ agent: { id: "a", workspaceId: "w", status: "idle" } }] });
      } } }),
      ref: () => ({ send: () => {} }),
    } },
  });
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settled();
  poll();
  await settled();
  assert.equal(buttons.suggest.label, "esperando: ESPERA: ci", "gold, saying what it waits for — not the stale suggestion");
  assert.equal(buttons["suggest-no"].visible, false, "no «no es esto» next to a piloted ✦");
  const panel = buttons.suggest.behavior.Content({ theme: { colors: {} }, close() {} });
  assert.equal(panel.props.autopilot.on, true);
  assert.equal(panel.props.suggestNow, undefined, "no «Sugerir ahora» while it pilots: one generation per turn");
  reply = { ...reply, autopilot: { on: true, estado: "humano", motivo: "dinero" } };
  poll();
  await settled();
  assert.equal(buttons.suggest.label, "necesita acción: dinero");
  update({ id: "a", workspaceId: "w", status: "running" });
  assert.equal(buttons.suggest.visible, true, "reachable mid-turn, to switch it off");
  assert.equal(buttons.suggest.label, "autopilot");
  const next = await panel.props.toggle(false);
  assert.deepEqual(toggles, [{ agentId: "a", on: false }]);
  assert.equal(next.on, false);
  assert.equal(buttons.suggest.visible, false, "off, the ✦ is the plain one again: hidden while the turn runs");
  assert.equal(exports.autopilotLine({ on: true, estado: "pensando", motivo: "" }), "autopilot: pidiendo el siguiente paso");
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.deepEqual(
    exports.autopilotDetails(
      { on: true, estado: "esperando", motivo: "jira ticket-1", desde: "2026-11-08T11:00:00Z", decidido: "2026-11-08T11:59:30Z", pasos: { seguidos: 2, total: 9 }, enviado: "[AUTOPILOT] sigue" },
      now,
    ),
    ["sigue solo cuando llegue el EVENTO del supervisor", "2 pasos seguidos · 9 en la sesión", "encendido hace 1 h · última decisión hace 30 s", "último envío: «[AUTOPILOT] sigue»"],
  );
  assert.deepEqual(exports.autopilotDetails({ on: true, estado: "activo", motivo: "" }, now), [], "nothing invented before the first decision");
  stop();
});
