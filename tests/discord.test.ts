// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverToDiscord, findComposer, isDiscord } from '../src/shared/discord.js';

const URL_A = 'https://tenor.com/view/happy-cat-gif-10804346947536782797';

function buildComposer(attrs = 'data-slate-editor="true" role="textbox"'): HTMLElement {
  document.body.innerHTML = `<div contenteditable="true" ${attrs}></div>`;
  const el = document.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!el) throw new Error('composer not built');
  // jsdom does not implement isContentEditable from the attribute.
  Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });
  return el;
}

beforeEach(() => {
  document.body.replaceChildren();
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

describe('deliverToDiscord', () => {
  it('inserts via execCommand, which is what Slate actually listens for', async () => {
    const composer = buildComposer();
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;

    const result = await deliverToDiscord(URL_A);

    expect(execCommand).toHaveBeenCalledWith('insertText', false, URL_A);
    expect(result.inserted).toBe(true);
    expect(document.activeElement).toBe(composer);
  });

  it('presses Enter so the message sends without the user doing it', async () => {
    const composer = buildComposer();
    document.execCommand = vi.fn(() => true);

    const keys: string[] = [];
    for (const type of ['keydown', 'keypress', 'keyup']) {
      composer.addEventListener(type, (event) => {
        const key = (event as KeyboardEvent).key;
        const legacy = (event as unknown as { keyCode: number }).keyCode;
        keys.push(`${type}:${key}:${String(legacy)}`);
      });
    }

    const result = await deliverToDiscord(URL_A);

    expect(result.sent).toBe(true);
    // Discord reads the legacy keyCode in places, so it must be present.
    expect(keys).toEqual(['keydown:Enter:13', 'keypress:Enter:13', 'keyup:Enter:13']);
  });

  it('can insert without sending', async () => {
    const composer = buildComposer();
    document.execCommand = vi.fn(() => true);
    const onKey = vi.fn();
    composer.addEventListener('keydown', onKey);

    const result = await deliverToDiscord(URL_A, false);

    expect(result).toEqual({ inserted: true, sent: false });
    expect(onKey).not.toHaveBeenCalled();
  });

  it('reports failure rather than pretending when there is no composer', async () => {
    document.execCommand = vi.fn(() => true);
    expect(await deliverToDiscord(URL_A)).toEqual({ inserted: false, sent: false });
  });

  it('never sends when the text could not be inserted', async () => {
    const composer = buildComposer();
    // execCommand fails AND the paste fallback cannot run (jsdom has no
    // DataTransfer) — an empty message must not be dispatched.
    document.execCommand = vi.fn(() => false);
    const onKey = vi.fn();
    composer.addEventListener('keydown', onKey);

    const result = await deliverToDiscord(URL_A);

    expect(result.sent).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
  });

  it('does not throw when execCommand itself throws', async () => {
    buildComposer();
    document.execCommand = vi.fn(() => {
      throw new Error('boom');
    });
    await expect(deliverToDiscord(URL_A)).resolves.toEqual({ inserted: false, sent: false });
  });
});
