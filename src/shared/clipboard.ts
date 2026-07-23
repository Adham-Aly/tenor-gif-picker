/**
 * The clipboard ladder.
 *
 * This is the single most defect-prone part of the extension, because the user
 * gesture happens inside a CROSS-ORIGIN iframe and several of the obvious
 * designs fail *silently*. What is written here is the result of reading
 * Chromium source; see implementation-plan.md §5.3 and §7.4.
 *
 * Two designs that look right and are not:
 *   - Copying in the TOP frame. `document.hasFocus()` is false there (focus is
 *     inside the iframe), so `writeText` rejects with NotAllowedError and the
 *     user sees nothing happen.
 *   - `chrome.offscreen` + `navigator.clipboard`, despite the API naming
 *     CLIPBOARD as a reason. Offscreen documents can never be focused, so the
 *     async Clipboard API always throws there. `execCommand` works, and is what
 *     Chrome's own official sample uses.
 *
 * So: the write happens INSIDE the tenor frame, in the click handler.
 */

import type { CopyTier } from './messages.js';

export interface CopyResult {
  ok: boolean;
  tier: CopyTier | null;
  error?: string;
}

/**
 * Tier 1 + Tier 2, in that order.
 *
 * `writeText` goes first even though it is *more* gated than `execCommand`
 * (it additionally checks Permissions Policy `clipboard-write` and
 * `document.hasFocus()`), because it is **side-effect free**. `execCommand`
 * injects a <textarea> into a third-party document and — via `select()` —
 * steals the caret from whatever the user was focused on. Paying that cost on
 * every single click to dodge a failure that only occurs on the rare host page
 * shipping `Permissions-Policy: clipboard-write=()` is the wrong trade.
 *
 * Must be invoked synchronously from a real user-gesture handler.
 */
export async function copyText(text: string): Promise<CopyResult> {
  const viaAsync = await tryWriteText(text);
  if (viaAsync.ok) return viaAsync;

  const viaLegacy = execCommandCopy(text);
  if (viaLegacy.ok) return viaLegacy;

  return {
    ok: false,
    tier: null,
    error: viaLegacy.error ?? viaAsync.error ?? 'clipboard unavailable',
  };
}

async function tryWriteText(text: string): Promise<CopyResult> {
  try {
    if (!navigator.clipboard?.writeText) {
      return { ok: false, tier: null, error: 'navigator.clipboard unavailable' };
    }
    await navigator.clipboard.writeText(text);
    return { ok: true, tier: 'writeText' };
  } catch (error) {
    return { ok: false, tier: null, error: describe(error) };
  }
}

/**
 * Tier 2 — the legacy path. Deprecated, universally functional, and gated only
 * on transient user activation (no Permissions Policy check, no focus check).
 *
 * The two paths fail on *different* conditions, which is what makes this a real
 * fallback rather than a second attempt at the same failure.
 */
export function execCommandCopy(text: string): CopyResult {
  const selection = document.getSelection();
  const savedRanges: Range[] = [];
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i += 1) {
      savedRanges.push(selection.getRangeAt(i).cloneRange());
    }
  }
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.setAttribute('tabindex', '-1');
  textarea.style.cssText =
    'position:fixed;top:0;left:-9999px;width:1px;height:1px;padding:0;border:0;' +
    'outline:0;opacity:0;pointer-events:none;';

  let listenerFired = false;

  /**
   * Guarantees the exact payload lands on the clipboard, and stops any tenor
   * page handler from rewriting it (we are on capture, at the document).
   */
  const onCopy = (event: Event): void => {
    const clipboardEvent = event as ClipboardEvent;
    clipboardEvent.clipboardData?.setData('text/plain', text);
    clipboardEvent.preventDefault();
    clipboardEvent.stopImmediatePropagation();
    listenerFired = true;
  };

  // ---------------------------------------------------------------------
  // NEVER use { once: true } here. It ships a clipboard hijack.
  //
  // `{ once: true }` self-removes only when the event actually FIRES. On the
  // exact path we care about — CanWriteClipboard false -> EnabledCopy false ->
  // execCommand returns false WITHOUT ever dispatching `copy` — the listener is
  // never consumed and stays registered on this document forever. The next time
  // the user selects text in tenor's search box and presses Cmd/Ctrl+C they get
  // OUR url instead of their own selection.
  //
  // It only arms after a prior copy failure, so no happy-path test will ever
  // surface it. Remove explicitly in `finally`; safe because execCommand
  // dispatches synchronously, so the event has already fired by then.
  // ---------------------------------------------------------------------
  document.addEventListener('copy', onCopy, true);

  let ok = false;
  let error: string | undefined;

  try {
    document.documentElement.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    // execCommand reports failure by RETURNING FALSE. It does not throw.
    // Treating a thrown error as the only failure mode silently copies nothing.
    ok = document.execCommand('copy');
    if (!ok) error = 'execCommand("copy") returned false';
  } catch (thrown) {
    ok = false;
    error = describe(thrown);
  } finally {
    document.removeEventListener('copy', onCopy, true);
    textarea.remove();
    restoreSelection(selection, savedRanges);
    restoreFocus(previouslyFocused);
  }

  if (ok && !listenerFired) {
    // Not a failure — the textarea's own selection carried the same string —
    // but it means our payload guarantee did not apply. Worth knowing.
    console.warn('[tenor-gif-picker] copy succeeded without our copy listener firing');
  }

  return ok ? { ok: true, tier: 'execCommand' } : { ok: false, tier: null, error };
}

/**
 * `TextControlElement::select()` calls `Focus()` internally, so tier 2 *does*
 * move focus even though `execCommand` itself has no focus requirement. Put it
 * back.
 */
function restoreFocus(element: HTMLElement | null): void {
  if (!element || typeof element.focus !== 'function') return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    /* the element may have been detached; nothing useful to do */
  }
}

function restoreSelection(selection: Selection | null, ranges: Range[]): void {
  if (!selection) return;
  try {
    selection.removeAllRanges();
    for (const range of ranges) selection.addRange(range);
  } catch {
    /* ranges can be invalidated by DOM churn; a lost selection is not fatal */
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
