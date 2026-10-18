// shortcut: puente por el DOM de Paseo web/escritorio. La SDK no tiene API del borrador del composer (getpaseo/paseo, discusión
// #4688), así que el texto se escribe en el textarea del prompt. Se borra cuando esa API exista. Si un update de Paseo mueve los
// selectores, `insertSuggestion` devuelve false y la píldora abre su popover. El texto entra como si se tecleara, así que el
// `onChangeText` del host sigue siendo el único que escribe el borrador.
const COMPOSER = '[data-testid="message-input-root"] textarea[data-composer-input]';

const anchors = new Map<string, Set<Element>>(); // agentId -> the pill icon(s) of that agent; one agent can be open in two panes

export function registerPillAnchor(agentId: string, node: Element): () => void {
  const nodes = anchors.get(agentId) ?? new Set<Element>();
  nodes.add(node);
  anchors.set(agentId, nodes);
  return () => {
    nodes.delete(node);
    if (!nodes.size && anchors.get(agentId) === nodes) anchors.delete(agentId);
  };
}

const visibleComposers = (root: Element) =>
  Array.from(root.querySelectorAll<HTMLTextAreaElement>(COMPOSER)).filter((box) => box.getClientRects().length > 0);

// The composer of the pane the pill sits in: climb from the pill until an ancestor holds a visible composer, and take it only if it
// is the only one there. Two panes side by side meet at an ancestor with two, which is ambiguous: no insertion, never the wrong agent.
function composerFor(anchor: Element): HTMLTextAreaElement | null {
  for (let el = anchor.parentElement; el && el !== document.body; el = el.parentElement) {
    const found = visibleComposers(el);
    if (found.length) return found.length === 1 ? found[0]! : null;
  }
  return null;
}

// Appends (a line below what the user already wrote) and never replaces; true only when the box ends up holding exactly that.
function append(box: HTMLTextAreaElement, text: string): boolean {
  const before = box.value;
  const piece = before ? `\n${text}` : text;
  const wanted = before + piece;
  box.focus();
  box.setSelectionRange(before.length, before.length);
  // execCommand keeps the user's undo stack (deprecated but alive in Chromium, WebKit and Gecko); the prototype setter plus an
  // `input` event is the way back when it refuses, and only if the box is still untouched.
  const done = document.execCommand("insertText", false, piece);
  if ((!done || box.value !== wanted) && box.value === before) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, wanted);
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: piece }));
  }
  if (box.value !== wanted) return false;
  const toEnd = () => {
    box.focus(); // the popover closing right after can take the focus back
    box.setSelectionRange(wanted.length, wanted.length);
    box.scrollTop = box.scrollHeight;
  };
  toEnd();
  requestAnimationFrame(toEnd);
  return true;
}

export function insertSuggestion(agentId: string, text: string): boolean {
  if (typeof document === "undefined") return false;
  for (const anchor of anchors.get(agentId) ?? []) {
    const box = composerFor(anchor);
    if (box && append(box, text)) return true;
  }
  return false;
}
