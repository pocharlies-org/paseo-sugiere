import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { gira } from "../client/estrella.ts";

// SC-5805: the ✦ learns everything from one held `suggest.watch`; this fake host holds it until the test pushes an answer.
function vigiaFalsa() {
  let version = 0;
  let suelta: (r: unknown) => void = () => {};
  const pedidas: unknown[] = [];
  return {
    pedidas,
    llamada: (input: unknown) => {
      pedidas.push(input);
      return new Promise((resolve) => { suelta = resolve; });
    },
    empuja: (agentes: Record<string, object>) => suelta({ agentes, version: ++version, completo: false }),
  };
}
const respuesta = (extra: object = {}) => ({
  text: null, pending: false, error: null, nada: false, en_plan: null, criterio: null, muted: false,
  autopilot: { estado: "sin-par", motivo: "" }, plan: null, ...extra,
});

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
    "@getpaseo/plugin/client/ui": { SettingsAction: "SettingsAction", SettingsSelect: "SettingsSelect" },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon", TextInput: "SheetAwareInput" },
    "../shared/contract.ts": { suggestGet: "get", suggestForce: "force", suggestFeedback: "feedback", autopilotStart: "start", autopilotStop: "stop", suggestWatch: "watch" },
    "../shared/suggest.ts": { SUGGEST_WAIT_MS: 300_000 },
    "./composer-bridge.ts": { insertSuggestion: () => false },
    "./estrella.ts": { gira },
  };
  const exports: any = {};
  new Function("require", "exports", outputText)((name: string) => { assert.ok(name in modules, name); return modules[name]; }, exports);
  let button: any;
  const sent: string[] = [];
  const vigia = vigiaFalsa();
  const llamadas: string[] = [];
  const stop = exports.addSuggestPill({
    addComposerPill: ({ id, button: next }: any) => {
      if (id !== "suggest") return { update() {}, remove() {} }; // «no es esto» lives in its own pill
      button = next;
      return { update: (next: unknown) => { button = next; }, remove() {} };
    },
    rpc: (name: string, input: unknown) => {
      llamadas.push(name);
      return name === "watch" ? vigia.llamada(input) : Promise.resolve({ text: "Original suggestion" });
    },
    paseo: { agents: {
      list: async () => ({ subscription: { subscribe: ({ snapshot }: any) => snapshot({
        entries: [{ agent: { id: "a", workspaceId: "w", status: "idle" } }, { agent: { id: "b", workspaceId: "w", status: "idle" } }],
      }) } }),
      ref: () => ({ send: (text: string) => { sent.push(text); } }),
    } },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(llamadas, ["watch"], "one held call for every agent, no `suggest.get` per agent");
  assert.deepEqual(vigia.pedidas, [{ agentes: ["a", "b"], since: 0 }]);
  vigia.empuja({ a: respuesta({ text: "Original suggestion" }) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(llamadas, ["watch", "watch"], "the next held call goes out when the last one answers");
  assert.deepEqual(vigia.pedidas.at(-1), { agentes: ["a", "b"], since: 1 });
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
    assert.equal(autopilot.props.par.estado, "sin-par", "the card carries the autopilot start form (the mobile card)");
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
    "@getpaseo/plugin/client/ui": { SettingsAction: "SettingsAction", SettingsSelect: "SettingsSelect" },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon", TextInput: "Input" },
    "../shared/contract.ts": { suggestGet: "get", suggestForce: "force", suggestFeedback: "feedback", autopilotStart: "start", autopilotStop: "stop", suggestWatch: "watch" },
    "../shared/suggest.ts": { SUGGEST_WAIT_MS: 300_000 },
    "./composer-bridge.ts": {
      insertSuggestion: (agentId: string, text: string) => { inserted.push(`${agentId} ${text}`); return true; },
      registerPillAnchor: () => () => {},
    },
    "./estrella.ts": { gira },
  };
  const exports: any = {};
  new Function("require", "exports", outputText)((name: string) => { assert.ok(name in modules, name); return modules[name]; }, exports);
  let button: any;
  const vigia = vigiaFalsa();
  const stop = exports.addSuggestPill({
    // The host's rule (validation.ts requireText): a label is undefined or non-blank, or the pill is never drawn.
    addComposerPill: ({ id, button: next }: any) => {
      const accept = (b: any) => { assert.ok(b.label === undefined || b.label.trim(), `the host refuses label ${JSON.stringify(b.label)}`); if (id === "suggest") button = b; };
      accept(next);
      return { update: accept, remove() {} };
    },
    rpc: (name: string, input: unknown) => (name === "watch" ? vigia.llamada(input) : Promise.resolve({ started: true })),
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
  assert.equal(panel.props.par.estado, "sin-par", "next to the autopilot start form");
  panel.props.suggestNow();
  assert.ok(closed, "pressing it closes the popover");
  await settled();
  await settled();
  assert.deepEqual(inserted, [], "the click only asks for a generation");
  vigia.empuja({ a: respuesta({ pending: true }) }); // the server confirms it is generating: still spinning
  await settled();
  vigia.empuja({ a: respuesta({ text: "Forzada" }) }); // the resident answers: the held call brings it, no polling
  await settled();
  assert.deepEqual(inserted, [], "the answer is not written into any prompt by itself");
  assert.equal(button.label, "Forzada", "it waits on the pill of its own window (the icon is already a Sparkles)");
  stop();
});

// With a live autopilot pair (the auditor pilots the session, 14-11) the ✦ only speaks for it: gold with «esperando: …», red
// with «necesita acción: …», its popover is the status and the «Parar» button, it stays reachable while a turn runs, and no
// suggestion or «no es esto» shows next to it.
test("a piloted ✦ is gold while it waits, red when it needs a person, and its popover is the status with «Parar»", async () => {
  const source = readFileSync(new URL("../client/suggest-pill.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const modules: Record<string, unknown> = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useState: (i: unknown) => [i, () => {}], useEffect: () => {}, useMemo: (f: () => unknown) => f(), useRef: () => ({ current: null }) },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", AccessibilityInfo: {} },
    "@getpaseo/plugin/client/ui": { SettingsAction: "SettingsAction", SettingsSelect: "SettingsSelect" },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon", TextInput: "Input" },
    "../shared/contract.ts": { suggestGet: "get", suggestForce: "force", suggestFeedback: "feedback", autopilotStart: "start", autopilotStop: "stop", suggestWatch: "watch" },
    "../shared/suggest.ts": { SUGGEST_WAIT_MS: 300_000 },
    "./composer-bridge.ts": { insertSuggestion: () => false, registerPillAnchor: () => () => {} },
    "./estrella.ts": { gira },
  };
  const exports: any = {};
  new Function("require", "exports", outputText)((name: string) => modules[name], exports);
  const vigia = vigiaFalsa();
  let reply: any = respuesta({ text: "una sugerencia vieja", en_plan: "en-plan", criterio: "c", autopilot: { estado: "esperando", motivo: "ESPERA: ci" } });
  const paros: unknown[] = [];
  const buttons: Record<string, any> = {};
  let update: (agent: object) => void = () => {};
  const stop = exports.addSuggestPill({
    addComposerPill: ({ id, button }: any) => {
      buttons[id] = button;
      return { update: (next: unknown) => { buttons[id] = next; }, remove() {} };
    },
    rpc: async (name: string, input: any) => {
      if (name === "watch") return vigia.llamada(input);
      if (name !== "stop") return reply;
      paros.push(input);
      reply = { ...reply, autopilot: { estado: "sin-par", motivo: "" } }; // the supervisor unregistered the pair
      return { ok: true };
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
  vigia.empuja({ a: reply });
  await settled();
  assert.equal(buttons.suggest.label, "esperando: ESPERA: ci", "gold, saying what it waits for — not the stale suggestion");
  assert.equal(buttons["suggest-no"].visible, false, "no «no es esto» next to a piloted ✦");
  const panel = buttons.suggest.behavior.Content({ theme: { colors: {} }, close() {} });
  assert.equal(panel.props.par.estado, "esperando");
  assert.equal(panel.props.suggestNow, undefined, "no «Sugerir ahora» while the auditor pilots: one generation per turn");
  const vistos: string[] = [];
  const deja = panel.props.sigue((par: { estado: string }) => vistos.push(par.estado)); // an open popover follows its pair
  reply = { ...reply, autopilot: { estado: "humano", motivo: "dinero" } };
  vigia.empuja({ a: reply });
  await settled();
  assert.deepEqual(vistos, ["humano"], "the open popover is told the change: the host does not repaint it");
  deja();
  assert.equal(buttons.suggest.label, "necesita acción: dinero");
  update({ id: "a", workspaceId: "w", status: "running" });
  assert.equal(buttons.suggest.visible, true, "reachable mid-turn, to stop the pair");
  assert.equal(buttons.suggest.label, "necesita acción: dinero", "mid-turn the pill keeps saying what the auditor needs");
  const r = await panel.props.parar();
  assert.deepEqual(paros, [{ agentId: "a" }]);
  assert.equal(r.ok, true);
  assert.equal(r.par!.estado, "sin-par");
  assert.equal(buttons.suggest.visible, false, "stopped, the ✦ is the plain one again: hidden while the turn runs");
  assert.equal(exports.autopilotLine({ estado: "pensando", motivo: "" }), "autopilot: el auditor está pensando");
  assert.equal(exports.autopilotLine({ estado: "degradada", motivo: "" }), "autopilot degradado: el auditor no responde");
  assert.equal(exports.autopilotLine({ estado: "entregada", motivo: "TAREA-1000001 verificado" }), "entregado: TAREA-1000001 verificado");
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.deepEqual(
    exports.autopilotDetails(
      { estado: "esperando", motivo: "jira ticket-1", desde: "2026-11-08T11:00:00Z", actualizado: "2026-11-08T11:59:30Z", pasos: { seguidos: 2, total: 9 }, ultimo_envio: "[AUTOPILOT] sigue", auditor: "Auditor de la historia" },
      now,
    ),
    ["sigue solo cuando llegue el EVENTO del supervisor", "2 pasos seguidos · 9 en la sesión", "en marcha hace 1 h · actualizado hace 30 s", "último envío: «[AUTOPILOT] sigue»", "auditor: Auditor de la historia"],
  );
  assert.deepEqual(exports.autopilotDetails({ estado: "activa", motivo: "" }, now), [], "nothing invented before the first decision");
  stop();
});
