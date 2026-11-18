import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { gira } from "../client/estrella.ts";

// The pills' state is pushed through one held `suggest.watch`: `canal()` is that call, answered when the test pushes.
function canal() {
  const cola: unknown[] = [];
  let espera: ((respuesta: unknown) => void) | null = null;
  return {
    pide: () => (cola.length ? Promise.resolve(cola.shift()) : new Promise((sigue) => { espera = sigue; })),
    empuja: (respuesta: unknown) => {
      if (!espera) return void cola.push(respuesta);
      const sigue = espera;
      espera = null;
      sigue(respuesta);
    },
  };
}
const estado = (extra: object = {}) => ({ text: null, pending: false, error: null, nada: false, en_plan: null, criterio: null, muted: false, autopilot: { estado: "sin-par", motivo: "" }, plan: null, ...extra });
const sinSondeo = () => { throw new Error("the client never asks on a clock"); };
// 18-11: the client speaks `seguir` (start with the objective, stop with null), `plan.leer` (the objective to review) and
// `autopilot.stop` (a legacy pair can only be stopped). The old start route — autopilotStart, autopilotGoal, the auditor model —
// is gone from the contract and must not reappear in the client.
const contrato = { suggestWatch: "watch", suggestForce: "force", suggestFeedback: "feedback", autopilotStop: "stop", planLeer: "objetivo", seguir: "seguir", ESTADO_VACIO: estado() };

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
    "../shared/contract.ts": contrato,
    "./composer-bridge.ts": { insertSuggestion: () => false },
    "./estrella.ts": { gira },
  };
  const exports: any = {};
  new Function("require", "exports", "setInterval", "setTimeout", outputText)(
    (name: string) => { assert.ok(name in modules, name); return modules[name]; },
    exports,
    sinSondeo,
    sinSondeo,
  );
  let button: any;
  const sent: string[] = [];
  const watch = canal();
  watch.empuja({ version: 1, completo: true, agentes: { a: estado({ text: "Original suggestion" }) } });
  const stop = exports.addSuggestPill({
    addComposerPill: ({ id, button: next }: any) => {
      if (id !== "suggest") return { update() {}, remove() {} }; // «no es esto» lives in its own pill
      button = next;
      return { update: (next: unknown) => { button = next; }, remove() {} };
    },
    rpc: (name: string) => (name === "watch" ? watch.pide() : Promise.resolve({})),
    paseo: { agents: {
      list: async () => ({ subscription: { subscribe: ({ snapshot }: any) => snapshot({
        entries: [{ agent: { id: "a", workspaceId: "w", status: "idle" } }],
      }) } }),
      ref: () => ({ send: (text: string) => { sent.push(text); } }),
    } },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
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
    const [row, panel] = card.props.children;
    const [input, hint, send] = row.props.children;
    assert.equal(panel.props.par.estado, "sin-par", "the card carries the follow form under the field (the mobile card)");
    assert.equal(panel.props.seguimiento, null, "nothing is being followed yet");
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
    "../shared/contract.ts": contrato,
    "./composer-bridge.ts": {
      insertSuggestion: (agentId: string, text: string) => { inserted.push(`${agentId} ${text}`); return true; },
      registerPillAnchor: () => () => {},
    },
    "./estrella.ts": { gira },
  };
  const exports: any = {};
  new Function("require", "exports", "setInterval", "setTimeout", outputText)(
    (name: string) => { assert.ok(name in modules, name); return modules[name]; },
    exports,
    sinSondeo,
    sinSondeo,
  );
  const watch = canal();
  watch.empuja({ version: 1, completo: true, agentes: {} });
  let button: any;
  const stop = exports.addSuggestPill({
    // The host's rule (validation.ts requireText): a label is undefined or non-blank, or the pill is never drawn.
    addComposerPill: ({ id, button: next }: any) => {
      const accept = (b: any) => { assert.ok(b.label === undefined || b.label.trim(), `the host refuses label ${JSON.stringify(b.label)}`); if (id === "suggest") button = b; };
      accept(next);
      return { update: accept, remove() {} };
    },
    rpc: (name: string) => (name === "watch" ? watch.pide() : Promise.resolve({ started: true })),
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
  assert.equal(panel.props.par.estado, "sin-par", "next to the follow form");
  panel.props.suggestNow();
  assert.ok(closed, "pressing it closes the popover");
  await settled();
  await settled();
  assert.deepEqual(inserted, [], "the click only asks for a generation");
  watch.empuja({ version: 2, completo: false, agentes: { a: estado({ text: "Forzada" }) } }); // the resident answers, pushed
  await settled();
  assert.deepEqual(inserted, [], "the answer is not written into any prompt by itself");
  assert.equal(button.label, "Forzada", "it waits on the pill of its own window (the icon is already a Sparkles)");
  stop();
});

// 18-11: a legacy autopilot pair (auditor B, 14-11) can only be stopped from the plugin: the ✦ paints from its registry state,
// its popover is the status with «Parar», it stays reachable while a turn runs, and the old start route (Empezar, model select,
// Jira) never reappears.
function loadStatusPill() {
  const source = readFileSync(new URL("../client/suggest-pill.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const modules: Record<string, unknown> = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: { useState: (i: unknown) => [typeof i === "function" ? (i as () => unknown)() : i, () => {}], useEffect: () => {}, useMemo: (f: () => unknown) => f(), useRef: () => ({ current: null }) },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", AccessibilityInfo: {} },
    "@getpaseo/plugin/client/ui": { SettingsAction: "SettingsAction", SettingsSelect: "SettingsSelect" },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon", TextInput: "Input" },
    "../shared/contract.ts": contrato,
    "./composer-bridge.ts": { insertSuggestion: () => false, registerPillAnchor: () => () => {} },
    "./estrella.ts": { gira },
  };
  const exports: any = {};
  new Function("require", "exports", "setInterval", "setTimeout", outputText)(
    (name: string) => modules[name],
    exports,
    sinSondeo,
    sinSondeo,
  );
  return exports;
}

function idlePaseo(onUpdate: (send: (agent: object) => void) => void) {
  return { agents: {
      list: async () => ({ subscription: { subscribe: ({ snapshot, update: u }: any) => {
        onUpdate((agent) => u({ type: "agent_update", payload: { kind: "upsert", agent } }));
        snapshot({ entries: [{ agent: { id: "a", workspaceId: "w", status: "idle" } }] });
      } } }),
      ref: () => ({ send: () => {} }),
    } };
}

test("a piloted ✦ is gold while it waits, red when it needs a person, and its popover is the status with «Parar» — stop only", async () => {
  const exports = loadStatusPill();
  const watch = canal();
  watch.empuja({ version: 1, completo: true, agentes: { a: estado({ text: "una sugerencia vieja", en_plan: "en-plan", criterio: "c", autopilot: { estado: "esperando", motivo: "ESPERA: ci" } }) } });
  const paros: unknown[] = [];
  const buttons: Record<string, any> = {};
  let update: (agent: object) => void = () => {};
  const stop = exports.addSuggestPill({
    addComposerPill: ({ id, button }: any) => {
      buttons[id] = button;
      return { update: (next: unknown) => { buttons[id] = next; }, remove() {} };
    },
    rpc: (name: string, input: any) => {
      if (name === "watch") return watch.pide();
      paros.push(input);
      return Promise.resolve({ ok: true });
    },
    paseo: idlePaseo(fn => { update = fn; }),
  });
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settled();
  await settled();
  assert.equal(buttons.suggest.label, "esperando: ESPERA: ci", "gold, saying what it waits for — not the stale suggestion");
  assert.equal(buttons["suggest-no"].visible, false, "no «no es esto» next to a piloted ✦");
  const panel = buttons.suggest.behavior.Content({ theme: { colors: {} }, close() {} });
  assert.equal(panel.props.par.estado, "esperando");
  assert.equal(panel.props.suggestNow, undefined, "no «Sugerir ahora» while the auditor pilots: one generation per turn");
  const tree = JSON.stringify((panel.type as (p: unknown) => unknown)(panel.props));
  assert.ok(tree.includes("Parar"), "the popover is the status with «Parar»");
  assert.ok(!tree.includes("Empezar"), "the old start route is gone: a legacy pair can only be stopped");
  assert.ok(!tree.includes("SettingsSelect"), "no auditor model and no Jira choice");
  const oidos: string[] = [];
  const deja = panel.props.escucha((par: any) => oidos.push(par.estado)); // the open popover follows its pair
  watch.empuja({ version: 2, completo: false, agentes: { a: estado({ autopilot: { estado: "humano", motivo: "dinero" } }) } });
  await settled();
  assert.equal(buttons.suggest.label, "necesita acción: dinero");
  assert.deepEqual(oidos, ["humano"], "the open popover repaints with the pushed pair");
  deja();
  update({ id: "a", workspaceId: "w", status: "running" });
  assert.equal(buttons.suggest.visible, true, "reachable mid-turn, to stop the pair");
  assert.equal(buttons.suggest.label, "necesita acción: dinero", "mid-turn the pill keeps saying what the auditor needs");
  const r = await panel.props.parar();
  assert.deepEqual(paros, [{ agentId: "a" }]);
  assert.equal(r.ok, true);
  watch.empuja({ version: 3, completo: false, agentes: { a: estado() } }); // the supervisor unregistered the pair: pushed
  await settled();
  assert.equal(buttons.suggest.visible, false, "stopped, the ✦ is the plain one again: hidden while the turn runs");
  assert.equal(exports.autopilotLine({ estado: "pensando", motivo: "" }), "autopilot: el auditor está pensando");
  assert.equal(exports.autopilotLine({ estado: "degradada", motivo: "" }), "autopilot degradado: el auditor no responde");
  assert.equal(exports.autopilotLine({ estado: "entregada", motivo: "el plan está verificado" }), "entregado: el plan está verificado");
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

// 18-11: el formulario de «Seguir en automático» arranca con el objetivo de la conversación (plan.leer), prefijado para
// revisarlo —abrir no ejecuta nada— y «Seguir» manda exactamente lo que hay en el campo, editado y recortado. Sin modelo del
// auditor, sin Jira y sin selector de ningún tipo: la configuración anterior desapareció del popover.
test("the follow form prefills the conversation's objective, never runs by opening, and sends exactly what is reviewed", async () => {
  const source = readFileSync(new URL("../client/suggest-pill.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const jsx = (type: unknown, props: any) => ({ type, props });
  let states: unknown[] = [];
  let cursor = 0;
  let effects: Array<() => void> = [];
  const modules: Record<string, unknown> = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
        return [states[index], (value: unknown) => { states[index] = typeof value === "function" ? (value as (p: unknown) => unknown)(states[index]) : value; }];
      },
      useEffect(effect: () => void) { effects.push(effect); },
      useMemo: (factory: () => unknown) => factory(),
    },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", AccessibilityInfo: {} },
    "@getpaseo/plugin/client/ui": { SettingsAction: "SettingsAction", SettingsSelect: "SettingsSelect" },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon", TextInput: "Input" },
    "../shared/contract.ts": contrato,
    "./composer-bridge.ts": { insertSuggestion: () => false, registerPillAnchor: () => () => {} },
    "./estrella.ts": { gira },
  };
  const exports: any = {};
  new Function("require", "exports", "setInterval", "setTimeout", outputText)(
    (name: string) => { assert.ok(name in modules, name); return modules[name]; },
    exports,
    sinSondeo,
    sinSondeo,
  );
  const OBJETIVO = "Objetivo: dejar verde el CI\nCriterios:\nC1 [abierta] npm test en el pod";
  const seguirs: any[] = [];
  const watch = canal();
  watch.empuja({ version: 1, completo: true, agentes: { a: estado() } });
  let button: any;
  const stop = exports.addSuggestPill({
    addComposerPill: ({ id, button: next }: any) => {
      if (id === "suggest") button = next;
      return { update: (next: unknown) => { if (id === "suggest") button = next; }, remove() {} };
    },
    rpc: (name: string, input: any) => {
      if (name === "watch") return watch.pide();
      if (name === "objetivo") return Promise.resolve({ objetivo: OBJETIVO });
      if (name === "seguir") { seguirs.push(input); return Promise.resolve({ ok: true }); }
      return Promise.resolve({});
    },
    paseo: {
      agents: {
        list: async () => ({ subscription: { subscribe: ({ snapshot }: any) => snapshot({ entries: [{ agent: { id: "a", workspaceId: "w", status: "idle" } }] }) } }),
        ref: () => ({ send: () => {} }),
      },
    },
  });
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settled();
  await settled();
  const theme = { colors: { foreground: "white", foregroundMuted: "gray", border: "gray", accent: "green", accentForeground: "black" } };
  const element = button.behavior.Content({ theme, close() {} });
  const render = () => { cursor = 0; return element.type(element.props); };
  effects.length = 0;
  const first = render();
  effects.splice(0).forEach((e) => e()); // abre el popover: lee el objetivo para revisarlo, no ejecuta nada
  await settled();
  await settled();
  const tree = JSON.stringify(render());
  assert.ok(!tree.includes("SettingsSelect"), "sin selector de modelo del auditor y sin elección de Jira: la configuración anterior fuera");
  assert.ok(!tree.includes("Empezar"), "la ruta vieja de arranque no reaparece");
  const form = render().props.children[3].props.children;
  const [campo, accion] = [form[1], form[2]];
  assert.equal(campo.props.value, OBJETIVO, "prefijado con el texto real de la conversación, para revisarlo");
  assert.equal(accion.props.actionLabel, "Seguir", "el botón del popover es «Seguir en automático»");
  assert.equal(seguirs.length, 0, "abrir el popover no arranca el seguimiento");
  accion.props.onPress();
  await settled();
  assert.deepEqual(seguirs.at(-1), { agentId: "a", objetivo: OBJETIVO }, "se manda el objetivo revisado, tal cual está en el campo");
  campo.props.onChangeText("  otro objetivo editado  ");
  const form2 = render().props.children[3].props.children;
  assert.equal(form2[2].props.disabled, false, "con texto, «Seguir» está disponible");
  form2[2].props.onPress();
  await settled();
  assert.deepEqual(seguirs.at(-1), { agentId: "a", objetivo: "otro objetivo editado" }, "lo editado es lo que se manda, recortado");
  form2[1].props.onChangeText("");
  const form3 = render().props.children[3].props.children;
  assert.equal(form3[2].props.disabled, true, "sin objetivo no se arranca nada");
  stop();
});

// 18-11: siguiendo, la ✦ es la amarilla que gira y visible también a mitad de turno (el «Parar» tiene que estar al alcance);
// el popover es el estado —objetivo y qué está haciendo— con «Parar» en el mismo sitio del «Seguir», y parar manda objetivo null.
test("while following, the ✦ turns, stays reachable mid-turn, and the popover is the status with «Parar» in the same place", async () => {
  const exports = loadStatusPill();
  const OBJETIVO = "Dejar verde el CI y fusionar el PR";
  const seguirs: any[] = [];
  const watch = canal();
  watch.empuja({ version: 1, completo: true, agentes: { a: estado({ seguimiento: { activo: true, objetivo: OBJETIVO, motivo: "paso 2: abre el PR" } }) } });
  const buttons: Record<string, any> = {};
  let update: (agent: object) => void = () => {};
  const stop = exports.addSuggestPill({
    addComposerPill: ({ id, button }: any) => {
      buttons[id] = button;
      return { update: (next: unknown) => { buttons[id] = next; }, remove() {} };
    },
    rpc: (name: string, input: any) => {
      if (name === "watch") return watch.pide();
      if (name === "seguir") { seguirs.push(input); return Promise.resolve({ ok: true }); }
      return Promise.resolve({ ok: true });
    },
    paseo: idlePaseo(fn => { update = fn; }),
  });
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settled();
  await settled();
  assert.equal(buttons.suggest.label, "siguiendo", "la ✦ dice que la sesión avanza sola (y gira: el estado es el amarillo en marcha)");
  const panel = buttons.suggest.behavior.Content({ theme: { colors: { foreground: "white", foregroundMuted: "gray" } }, close() {} });
  const block = (panel.type as (p: unknown) => any)(panel.props).props.children[1];
  assert.equal(block.props.children[0].props.children[1], "paso 2: abre el PR", "qué está haciendo ahora");
  assert.equal(block.props.children[1].props.children, OBJETIVO, "el objetivo que persigue, a la vista");
  assert.equal(block.props.children[2].props.actionLabel, "Parar", "«Parar» en el mismo sitio del «Seguir»");
  assert.equal(block.props.children[2].props.label, "Seguir en automático");
  const tree = JSON.stringify((panel.type as (p: unknown) => unknown)(panel.props));
  assert.ok(!tree.includes("Empezar") && !tree.includes("SettingsSelect"), "ni arranque viejo ni configuración de auditor/Jira en el popover");
  block.props.children[2].props.onPress();
  await settled();
  assert.deepEqual(seguirs, [{ agentId: "a", objetivo: null }], "parar es seguir con objetivo null: una pulsación, sin nada que escribir");
  update({ id: "a", workspaceId: "w", status: "running" });
  assert.equal(buttons.suggest.visible, true, "a mitad de turno el «Parar» sigue al alcance");
  assert.equal(buttons.suggest.label, "siguiendo", "y la píldora lo sigue diciendo");
  watch.empuja({ version: 2, completo: false, agentes: { a: estado({ seguimiento: { activo: false, objetivo: OBJETIVO, motivo: "" } }) } }); // parado, empujado
  await settled();
  assert.equal(buttons.suggest.visible, false, "parado, la ✦ vuelve a ser la normal: oculta mientras dura el turno");
  stop();
});
