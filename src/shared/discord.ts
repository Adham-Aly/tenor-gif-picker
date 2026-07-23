/**
 * Discord integration.
 *
 * On discord.com a picked GIF should land in the message box and send, rather
 * than only reaching the clipboard. Discord's composer is a Slate editor that
 * keeps its own model and renders its own text nodes; anything written straight
 * into the contenteditable DOM is foreign to that model. `execCommand('insertText')`
 * does exactly that — it drops a raw text node in, so the text is visible but
 * Slate still thinks the editor is empty (its placeholder stays, and Enter sends
 * nothing). That is the "label sitting over the placeholder" bug.
 *
 * The route that goes THROUGH Slate's model is a synthetic `paste`: Slate's
 * onPaste reads `event.clipboardData.getData('text/plain')` and inserts via its
 * own pipeline. Two details are load-bearing:
 *   - `clipboardData` MUST be passed through the ClipboardEvent constructor, so
 *     Chromium populates it natively and the value survives the content script's
 *     isolated-world -> page boundary. Attaching it afterwards with
 *     defineProperty leaves the page reading `null`.
 *   - Slate does not gate on `event.isTrusted`, so a dispatched event is honoured.
 */

const DISCORD_HOSTS = /(^|\.)discord\.com$/i;

export function isDiscord(hostname: string = location.hostname): boolean {
  return DISCORD_HOSTS.test(hostname);
}

/** Discord's message composer, across the markup variants they ship. */
export function findComposer(): HTMLElement | null {
  const candidates = [
    'div[role="textbox"][contenteditable="true"][data-slate-editor="true"]',
    'div[data-slate-editor="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][aria-multiline="true"]',
  ];
  for (const selector of candidates) {
    const found = document.querySelector<HTMLElement>(selector);
    if (found && found.isContentEditable) return found;
  }
  return null;
}

function placeCaretAtEnd(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Synthetic Enter that Discord's handlers accept. */
function pressEnter(target: HTMLElement): void {
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    const event = new KeyboardEvent(type, {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    // Discord reads the legacy properties in places, and the constructor will
    // not set them, so they are defined explicitly.
    Object.defineProperty(event, 'keyCode', { get: () => 13 });
    Object.defineProperty(event, 'which', { get: () => 13 });
    target.dispatchEvent(event);
  }
}

export interface DeliverResult {
  inserted: boolean;
  sent: boolean;
}

/** A native DataTransfer carrying `text` as text/plain, for a synthetic paste. */
function textTransfer(text: string): DataTransfer {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  return data;
}

/** Dispatch a paste Slate's onPaste handler will run. */
function pasteInto(composer: HTMLElement, text: string): void {
  composer.dispatchEvent(
    new ClipboardEvent('paste', {
      clipboardData: textTransfer(text),
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * Insert `text` into Discord's composer and send it.
 *
 * @param send when false the text is left in the box for the user to review.
 */
export async function deliverToDiscord(text: string, send = true): Promise<DeliverResult> {
  const composer = findComposer();
  if (!composer) return { inserted: false, sent: false };

  composer.focus({ preventScroll: true });
  placeCaretAtEnd(composer);

  try {
    pasteInto(composer, text);
  } catch {
    return { inserted: false, sent: false };
  }

  // Let React/Slate commit the model and re-render before we inspect or send;
  // sending too early submits an empty message.
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)));

  // With execCommand gone, the ONLY path text can reach the DOM is Slate
  // rendering its own model — so the text being present proves the model
  // updated (no more "label"), and its absence means we must not press Enter on
  // an empty composer. The clipboard copy still ran, so the link is pasteable.
  const live = findComposer() ?? composer;
  const inserted = (live.textContent ?? '').includes(text);
  if (!inserted) return { inserted: false, sent: false };
  if (!send) return { inserted: true, sent: false };

  pressEnter(live);
  return { inserted: true, sent: true };
}
