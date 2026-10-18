import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { insertSuggestion, registerPillAnchor } from "../client/composer-bridge.ts";

// The bridge writes into Paseo's real DOM, which node has not: a tiny tree stands in for it (selectors are not evaluated — every
// Box under an element counts as a composer there). What this cannot prove — that Paseo's React takes the typed text and the user's
// undo stack survives — is checked against Paseo's own web build (SC-2677).
class El {
  parentElement: El | null = null;
  children: El[] = [];
  add<T extends El>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  querySelectorAll(): Box[] {
    return this.children.flatMap((child) => (child instanceof Box ? [child] : child.querySelectorAll()));
  }
}

class Box extends El {
  static focused: Box | null = null;
  #value = "";
  visible = true;
  stubborn = false; // a box that drops every write
  caret = -1;
  scrollTop = 0;
  scrollHeight = 99;
  events: string[] = [];
  get value() {
    return this.#value;
  }
  set value(next: string) {
    if (!this.stubborn) this.#value = next;
  }
  focus() {
    Box.focused = this;
  }
  setSelectionRange(start: number) {
    this.caret = start;
  }
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  dispatchEvent(event: { type: string }) {
    this.events.push(event.type);
    return true;
  }
}

const g = globalThis as Record<string, unknown>;
const offs: Array<() => void> = [];
let body: El;
let frames: Array<() => void>;
let refuseCommand: boolean;

beforeEach(() => {
  body = new El();
  frames = [];
  refuseCommand = false;
  Box.focused = null;
  g.document = {
    body,
    execCommand: (command: string, _ui: boolean, piece: string) => {
      if (command !== "insertText" || refuseCommand || !Box.focused) return false;
      Box.focused.value += piece; // at the end: the bridge puts the caret there first
      return true;
    },
  };
  g.HTMLTextAreaElement = Box;
  g.InputEvent = class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  };
  g.requestAnimationFrame = (frame: () => void) => frames.push(frame);
});

afterEach(() => {
  for (const off of offs.splice(0)) off();
  for (const name of ["document", "HTMLTextAreaElement", "InputEvent", "requestAnimationFrame"]) delete g[name];
});

// A pane as Paseo draws it: the pill's icon in a track bar, the composer beside it, both under one surface.
const pane = (parent: El, agentId: string) => {
  const surface = parent.add(new El());
  const icon = surface.add(new El()).add(new El());
  const box = surface.add(new Box());
  offs.push(registerPillAnchor(agentId, icon as unknown as Element));
  return { surface, box };
};

describe("the composer bridge", () => {
  it("writes the suggestion into the prompt of the pane its pill sits in, caret at the end, and keeps the focus after the popover closes", () => {
    const { box } = pane(body, "a");
    assert.equal(insertSuggestion("a", "hola"), true);
    assert.equal(box.value, "hola");
    assert.equal(box.caret, 4);
    Box.focused = null; // the closing popover takes the focus back…
    for (const frame of frames) frame();
    assert.equal(Box.focused, box); // …and the next frame returns it to the prompt
  });

  it("appends a line below what the user already wrote and never replaces it", () => {
    const { box } = pane(body, "a");
    box.value = "ya escrito";
    assert.equal(insertSuggestion("a", "hola"), true);
    assert.equal(box.value, "ya escrito\nhola");
  });

  it("writes each pill's suggestion into its own pane when two are side by side", () => {
    const split = body.add(new El());
    const left = pane(split, "a");
    const right = pane(split, "b");
    assert.equal(insertSuggestion("b", "para b"), true);
    assert.equal(left.box.value, "");
    assert.equal(right.box.value, "para b");
    assert.equal(insertSuggestion("a", "para a"), true);
    assert.equal(left.box.value, "para a");
  });

  it("does not count a composer that is not displayed (an inactive tab)", () => {
    const { surface, box } = pane(body, "a");
    surface.add(new Box()).visible = false;
    assert.equal(insertSuggestion("a", "hola"), true);
    assert.equal(box.value, "hola");
  });

  it("refuses when the first ancestor holding a composer holds two: nothing is written", () => {
    const { surface, box } = pane(body, "a");
    const other = surface.add(new Box());
    assert.equal(insertSuggestion("a", "hola"), false);
    assert.equal(box.value + other.value, "");
  });

  it("falls back to the prototype setter and an input event when the editing command is refused", () => {
    const { box } = pane(body, "a");
    refuseCommand = true;
    assert.equal(insertSuggestion("a", "hola"), true);
    assert.equal(box.value, "hola");
    assert.deepEqual(box.events, ["input"]);
  });

  it("reports false when the box will not take the text, so the pill shows its card", () => {
    const { box } = pane(body, "a");
    box.stubborn = true;
    assert.equal(insertSuggestion("a", "hola"), false);
  });

  it("reports false without a pill for that agent, after the pill is gone, or with no document", () => {
    const { box } = pane(body, "a");
    assert.equal(insertSuggestion("b", "hola"), false);
    offs.splice(0).forEach((off) => off());
    assert.equal(insertSuggestion("a", "hola"), false);
    offs.push(registerPillAnchor("a", box.parentElement!.children[0]!.children[0]! as unknown as Element));
    delete g.document;
    assert.equal(insertSuggestion("a", "hola"), false);
    assert.equal(box.value, "");
  });
});
