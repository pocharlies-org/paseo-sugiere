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

const composersUnder = (root: Element) => Array.from(root.querySelectorAll<HTMLTextAreaElement>(COMPOSER));

// The composer of the pane the pill sits in: the first ancestor that holds any composer, taken only when it holds exactly one and that
// one is displayed. Stopping at the first ancestor holding a VISIBLE composer let the climb walk over the pane whose composer was
// hidden — the window the user left — and land on the single visible composer of the window now on screen, writing there (Dani 02-11:
// «si he cambiado de ventana lo injecta en la ventana que no toca»). A hidden composer of its own means the pill's window is not the
// one in front: nothing is written and the suggestion stays on its button until it is pressed. Two composers in the first ancestor
// (panes side by side) remain as ambiguous as they were.
function composerFor(anchor: Element): HTMLTextAreaElement | null {
  if (anchor.getClientRects().length === 0) return null; // the pill itself is off screen: its window is not the one in front
  for (let el = anchor.parentElement; el && el !== document.body; el = el.parentElement) {
    const found = composersUnder(el);
    if (found.length) return found.length === 1 && found[0]!.getClientRects().length > 0 ? found[0]! : null;
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
