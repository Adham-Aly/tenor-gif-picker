// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyText, execCommandCopy } from '../src/shared/clipboard.js';

const URL_A = 'https://tenor.com/view/happy-cat-gif-10804346947536782797';
const URL_B = 'https://tenor.com/view/other-gif-2';

function stubClipboard(impl: (text: string) => Promise<void>): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

/** A `copy` event shaped enough for the code under test. */
function makeCopyEvent(): Event & { clipboardData: { setData: ReturnType<typeof vi.fn> } } {
  const event = new Event('copy', { bubbles: true, cancelable: true });
  const setData = vi.fn();
  Object.defineProperty(event, 'clipboardData', {
    value: { setData },
    configurable: true,
  });
  return event as Event & { clipboardData: { setData: ReturnType<typeof vi.fn> } };
}

/** Simulates a user pressing Cmd/Ctrl+C on their own selection. */
function simulateUserCopy(): ReturnType<typeof vi.fn> {
  const event = makeCopyEvent();
  document.dispatchEvent(event);
  return event.clipboardData.setData;
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('copyText — tier ordering', () => {
  it('uses writeText first and leaves the DOM completely untouched', async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    const createElement = vi.spyOn(document, 'createElement');

    const result = await copyText(URL_A);

    expect(result).toEqual({ ok: true, tier: 'writeText' });
    expect(writeText).toHaveBeenCalledWith(URL_A);
    // The whole reason writeText is first: it has no side effects. execCommand
    // injects a <textarea> into a third-party document and moves focus.
    expect(createElement).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when writeText is blocked', async () => {
    stubClipboard(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')));
    const execCommand = vi.fn(() => {
      document.dispatchEvent(makeCopyEvent());
      return true;
    });
    document.execCommand = execCommand;

    const result = await copyText(URL_A);

    expect(result).toEqual({ ok: true, tier: 'execCommand' });
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('reports failure when both tiers fail, rather than a false success', async () => {
    stubClipboard(() => Promise.reject(new Error('nope')));
    document.execCommand = vi.fn(() => false);

    const result = await copyText(URL_A);

    expect(result.ok).toBe(false);
    expect(result.tier).toBeNull();
    expect(result.error).toBeTruthy();
  });
});

describe('execCommandCopy — the silent-failure bug class', () => {
  it('treats a `false` return as failure (execCommand does not throw)', () => {
    document.execCommand = vi.fn(() => false);

    const result = execCommandCopy(URL_A);

    // The natural `try { ... } catch { ... }` shape would report success here,
    // because execCommand signals failure by RETURNING false, never by throwing.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('returned false');
  });

  it('puts our exact payload on the clipboard via the copy event', () => {
    let captured: string | null = null;
    document.execCommand = vi.fn(() => {
      const event = makeCopyEvent();
      document.dispatchEvent(event);
      const call = event.clipboardData.setData.mock.calls[0];
      captured = call ? (call[1] as string) : null;
      return true;
    });

    const result = execCommandCopy(URL_A);

    expect(result.ok).toBe(true);
    expect(captured).toBe(URL_A);
  });
});

describe('execCommandCopy — clipboard hijack regression', () => {
  /**
   * The defect this guards against:
   *
   * If the `copy` listener is registered with `{ once: true }`, it self-removes
   * only when the event FIRES. When `execCommand` returns false WITHOUT
   * dispatching `copy` — which is exactly the failure path — the listener
   * survives forever, and the next time the user presses Cmd+C on their own
   * selection they silently get our GIF URL instead.
   *
   * It only arms AFTER a prior failure, so no happy-path test would surface it.
   */
  it('does not leave a listener behind when execCommand fails without dispatching copy', () => {
    document.execCommand = vi.fn(() => false); // fails; never dispatches `copy`

    const result = execCommandCopy(URL_A);
    expect(result.ok).toBe(false);

    const setData = simulateUserCopy();
    expect(setData).not.toHaveBeenCalled();
  });

  it('does not leave a listener behind when execCommand throws', () => {
    document.execCommand = vi.fn(() => {
      throw new Error('boom');
    });

    expect(execCommandCopy(URL_A).ok).toBe(false);

    const setData = simulateUserCopy();
    expect(setData).not.toHaveBeenCalled();
  });

  it('does not leak a listener across repeated successful copies', () => {
    document.execCommand = vi.fn(() => {
      document.dispatchEvent(makeCopyEvent());
      return true;
    });

    expect(execCommandCopy(URL_A).ok).toBe(true);
    expect(execCommandCopy(URL_B).ok).toBe(true);

    const setData = simulateUserCopy();
    expect(setData).not.toHaveBeenCalled();
  });
});

describe('execCommandCopy — good-guest behaviour', () => {
  /** Faithful stub: a real successful execCommand always dispatches `copy`. */
  const succeedRealistically = (): ReturnType<typeof vi.fn> =>
    vi.fn(() => {
      document.dispatchEvent(makeCopyEvent());
      return true;
    });

  it('removes the scratch textarea on success and on failure', () => {
    document.execCommand = succeedRealistically();
    execCommandCopy(URL_A);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);

    document.execCommand = vi.fn(() => false);
    execCommandCopy(URL_A);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);

    document.execCommand = vi.fn(() => {
      throw new Error('boom');
    });
    execCommandCopy(URL_A);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('restores focus to whatever the user was on', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    document.execCommand = succeedRealistically();
    execCommandCopy(URL_A);

    // `select()` calls `Focus()` internally, so this path genuinely does move
    // focus and genuinely does have to put it back.
    expect(document.activeElement).toBe(input);
  });

  it('restores the user selection', () => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'some text the user had selected';
    document.body.appendChild(paragraph);

    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.rangeCount).toBe(1);

    document.execCommand = succeedRealistically();
    execCommandCopy(URL_A);

    expect(document.getSelection()?.rangeCount).toBe(1);
    expect(document.getSelection()?.toString()).toBe('some text the user had selected');
  });

  it('warns — but still reports success — if the copy event never reached us', () => {
    // Not a failure: the textarea's own selection carried the same string. But
    // our payload guarantee did not apply, and that is worth surfacing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    document.execCommand = vi.fn(() => true); // returns true, dispatches nothing

    expect(execCommandCopy(URL_A).ok).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });
});
