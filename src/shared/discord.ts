/**
 * Discord integration.
 *
 * On discord.com a picked GIF should land in the message box and send, rather
 * than only reaching the clipboard. Discord's composer is a Slate editor, so
 * writing to the DOM directly does not work — Slate keeps its own model and
 * would overwrite anything we inserted.
 *
 * `document.execCommand('insertText')` is the reliable route: it emits the same
 * `beforeinput`/`input` sequence a real keystroke does, which Slate listens for.
 * Everything here runs in the content script's isolated world but operates on
 * the real document, so the editor cannot tell the difference.
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

  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch {
    inserted = false;
  }

  if (!inserted) {
    // Fallback: a synthetic paste, which Slate also understands.
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      composer.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
      inserted = true;
    } catch {
      inserted = false;
    }
  }

  if (!inserted) return { inserted: false, sent: false };
  if (!send) return { inserted: true, sent: false };

  // Give Slate a frame to reconcile its model before the Enter arrives;
  // sending too early submits an empty message.
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)));

  const stillThere = findComposer();
  if (!stillThere) return { inserted: true, sent: false };
  pressEnter(stillThere);
  return { inserted: true, sent: true };
}
