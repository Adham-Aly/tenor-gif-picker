// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverToDiscord, findComposer, isDiscord } from '../src/shared/discord.js';

const URL_A = 'https://tenor.com/view/happy-cat-gif-10804346947536782797';

/**
 * jsdom does not honour the `clipboardData` member of the ClipboardEvent
 * constructor, which is the whole mechanism the fix relies on. Shim it so the
 * test exercises the real contract: the dispatched paste event must carry the
 * text via `clipboardData.getData('text/plain')`.
 */
function shimClipboardEvent(): void {
  class FakeClipboardEvent extends Event {
    clipboardData: DataTransfer | null;
    constructor(type: string, init?: { clipboardData?: DataTransfer } & EventInit) {
      super(type, init);
      this.clipboardData = init?.clipboardData ?? null;
    }
  }
  (globalThis as unknown as { ClipboardEvent: unknown }).ClipboardEvent = FakeClipboardEvent;

  if (typeof (globalThis as unknown as { DataTransfer?: unknown }).DataTransfer === 'undefined') {
    class FakeDataTransfer {
      private store = new Map<string, string>();
      setData(type: string, value: string): void {
        this.store.set(type, value);
      }
      getData(type: string): string {
        return this.store.get(type) ?? '';
      }
    }
    (globalThis as unknown as { DataTransfer: unknown }).DataTransfer = FakeDataTransfer;
  }
}

function buildComposer(attrs = 'data-slate-editor="true" role="textbox"'): HTMLElement {
  document.body.innerHTML = `<div contenteditable="true" ${attrs}></div>`;
  const el = document.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!el) throw new Error('composer not built');
  Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });
  return el;
}

/**
 * Attach a fake Slate paste handler: reads the pasted text/plain and RENDERS a
 * real text node (as Slate would), so the composer's textContent reflects the
 * model. This is what makes the test able to distinguish a real insert from the
 * old "label" that never reached the model.
 */
function attachSlatePaste(composer: HTMLElement): void {
  composer.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) composer.appendChild(document.createTextNode(text));
  });
}

beforeEach(() => {
  document.body.replaceChildren();
  shimClipboardEvent();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isDiscord', () => {
  it('matches discord.com and its subdomains only', () => {
    expect(isDiscord('discord.com')).toBe(true);
    expect(isDiscord('canary.discord.com')).toBe(true);
    expect(isDiscord('ptb.discord.com')).toBe(true);

    expect(isDiscord('notdiscord.com')).toBe(false);
    expect(isDiscord('discord.com.evil.example')).toBe(false);
    expect(isDiscord('discordapp.example')).toBe(false);
    expect(isDiscord('github.com')).toBe(false);
  });
});

describe('findComposer', () => {
  it('finds Discord’s slate editor', () => {
    const composer = buildComposer();
    expect(findComposer()).toBe(composer);
  });

  it('falls back to a generic role=textbox composer', () => {
    const composer = buildComposer('role="textbox"');
    expect(findComposer()).toBe(composer);
  });

  it('returns null when there is no composer on the page', () => {
    expect(findComposer()).toBeNull();
  });
});

describe('deliverToDiscord — insertion goes THROUGH the model (paste)', () => {
  it('inserts via a paste event carrying the text as text/plain', async () => {
    const composer = buildComposer();
    let pastedText: string | null = null;
    composer.addEventListener('paste', (event) => {
      pastedText = event.clipboardData?.getData('text/plain') ?? null;
      if (pastedText) composer.appendChild(document.createTextNode(pastedText));
    });

    const result = await deliverToDiscord(URL_A);

    // The text reached the model via clipboardData — not a raw DOM mutation.
    expect(pastedText).toBe(URL_A);
    expect(result.inserted).toBe(true);
    expect(composer.textContent).toContain(URL_A);
  });

  it('does NOT use execCommand (the path that produced the label)', async () => {
    const composer = buildComposer();
    attachSlatePaste(composer);
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;

    await deliverToDiscord(URL_A);

    expect(execCommand).not.toHaveBeenCalled();
  });

  it('presses Enter (keyCode 13) only after the text is really in the composer', async () => {
    const composer = buildComposer();
    attachSlatePaste(composer);

    const keys: string[] = [];
    for (const type of ['keydown', 'keypress', 'keyup']) {
      composer.addEventListener(type, (event) => {
        const legacy = (event as unknown as { keyCode: number }).keyCode;
        keys.push(`${type}:${(event as KeyboardEvent).key}:${String(legacy)}`);
      });
    }

    const result = await deliverToDiscord(URL_A);

    expect(result).toEqual({ inserted: true, sent: true });
    expect(keys).toEqual(['keydown:Enter:13', 'keypress:Enter:13', 'keyup:Enter:13']);
  });

  it('can insert without sending', async () => {
    const composer = buildComposer();
    attachSlatePaste(composer);
    const onKey = vi.fn();
    composer.addEventListener('keydown', onKey);

    const result = await deliverToDiscord(URL_A, false);

    expect(result).toEqual({ inserted: true, sent: false });
    expect(onKey).not.toHaveBeenCalled();
  });
});

describe('deliverToDiscord — never sends an empty message (the regression guard)', () => {
  it('when the model stays empty (no Slate handler), reports failure and does NOT press Enter', async () => {
    // No paste listener => nothing reaches the composer's textContent => the fix
    // must refuse to send. This is exactly the case the old execCommand-first
    // path green-lit by mutating the DOM without the model.
    const composer = buildComposer();
    const onKey = vi.fn();
    composer.addEventListener('keydown', onKey);

    const result = await deliverToDiscord(URL_A);

    expect(result).toEqual({ inserted: false, sent: false });
    expect(onKey).not.toHaveBeenCalled();
  });

  it('reports failure when there is no composer at all', async () => {
    expect(await deliverToDiscord(URL_A)).toEqual({ inserted: false, sent: false });
  });
});
