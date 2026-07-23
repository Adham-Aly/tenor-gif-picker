/**
 * Source-level guards for three bugs that are invisible to unit tests because
 * they only manifest against live tenor/Discord in a real browser. Each pins
 * the specific line that, if reverted, brings the bug back.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('star re-injection survives tenor’s SPA re-render', () => {
  const frame = read('src/content/tenor-frame.ts');

  it('observes a stable root, not the replaceable results grid', () => {
    // tenor is an Inferno SPA that render()s into #root and discards the SSR
    // `.UniversalGifList`. An observer bound to that grid goes deaf on mount, so
    // the injected stars are never re-added. Observing document.body survives it.
    const watchGrid = /function watchGrid\(\): void \{[\s\S]*?\n\}/.exec(frame)?.[0] ?? '';
    expect(watchGrid).toContain('document.body');
    expect(watchGrid).not.toMatch(/observe\([^)]*querySelector\('\.UniversalGifList'\)/);
  });
});

describe('Discord insertion goes through Slate’s model', () => {
  const discord = read('src/shared/discord.ts');
  // Strip comments — the header explains the execCommand bug by name.
  const code = discord.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('does not CALL execCommand (the raw-DOM path that produced the label)', () => {
    expect(code).not.toMatch(/\bexecCommand\s*\(/);
  });

  it('inserts via a paste event with constructor-supplied clipboardData', () => {
    // The constructor is load-bearing: it populates clipboardData natively so it
    // crosses the isolated-world -> page boundary.
    expect(discord).toMatch(/new ClipboardEvent\(\s*'paste',\s*\{[\s\S]*?clipboardData:/);
  });

  it('verifies the text landed before pressing Enter (never sends empty)', () => {
    expect(discord).toContain('.includes(text)');
  });
});

describe('Cmd+G is handled in every frame that can hold focus', () => {
  it('the picker handles the close shortcut itself (fixing the Find-bar bug)', () => {
    const picker = read('src/picker/picker.ts');
    // A window-level capture keydown that preventDefaults Cmd+G / Cmd+Alt+/.
    expect(picker).toMatch(/addEventListener\(\s*'keydown'[\s\S]*?'KeyG'[\s\S]*?preventDefault/);
    expect(picker).toContain("searchParams.get('discord')");
  });

  it('the tenor frame relays the close shortcut too', () => {
    const frame = read('src/content/tenor-frame.ts');
    expect(frame).toMatch(/'KeyG'[\s\S]*?frame:dismiss/);
  });

  it('the host gates the open shortcut on the setting', () => {
    const host = read('src/content/host-overlay.ts');
    expect(host).toMatch(/onDiscord &&\s*cmdGEnabled/);
  });

  it('the picker exposes the settings toggle, pane, and switch', () => {
    const html = read('src/picker/picker.html');
    expect(html).toContain('id="settings-toggle"');
    expect(html).toContain('id="pane-settings"');
    expect(html).toContain('id="set-cmdg"');
  });

  it('the setting defaults to ON', () => {
    const settings = read('src/shared/settings.ts');
    expect(settings).toMatch(/DEFAULT_SETTINGS[^=]*=\s*\{\s*cmdGDiscord:\s*true/);
  });
});
