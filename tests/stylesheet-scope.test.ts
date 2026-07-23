/**
 * Guards the single most dangerous failure mode in this extension.
 *
 * `tenor-frame.css` is declared in the manifest, so Chrome delivers it to EVERY
 * tenor.com document — including when the user browses the real site. Every rule
 * is therefore gated on `html[data-tenor-picker]`, an attribute only ever set
 * inside our own iframe.
 *
 * A single unscoped rule would silently restyle tenor.com for the user, on a
 * site they never asked us to touch, and nothing else in the test suite would
 * notice. So this parses the shipped stylesheet and proves the invariant.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FRAME_ATTR } from '../src/shared/constants.js';

const cssPath = new URL('../src/content/tenor-frame.css', import.meta.url);
const css = readFileSync(cssPath, 'utf8');

interface Rule {
  selector: string;
  atRule: string | null;
}

/** Minimal CSS prelude walker — enough to enumerate every selector list. */
function extractRules(source: string): Rule[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const atStack: string[] = [];
  let buffer = '';

  for (const char of stripped) {
    if (char === '{') {
      const prelude = buffer.trim();
      buffer = '';
      if (prelude.startsWith('@')) {
        atStack.push(prelude);
      } else {
        atStack.push(''); // a style rule opens a block too
        if (prelude) {
          rules.push({
            selector: prelude,
            atRule: atStack.slice(0, -1).filter(Boolean).join(' ') || null,
          });
        }
      }
    } else if (char === '}') {
      atStack.pop();
      buffer = '';
    } else if (char === ';' && atStack.length === 0) {
      buffer = ''; // top-level at-statement such as @import
    } else {
      buffer += char;
    }
  }
  return rules;
}

const rules = extractRules(css);

/** Keyframe steps (`from`, `to`, `40%`) are not page selectors. */
function isKeyframeStep(rule: Rule): boolean {
  if (!rule.atRule?.includes('@keyframes')) return false;
  return rule.selector.split(',').every((part) => /^(from|to|\d+(\.\d+)?%)$/.test(part.trim()));
}

/** Selectors in a rule set that are NOT scoped to the picker attribute. */
function unscopedSelectors(source: string): string[] {
  return extractRules(source)
    .filter((rule) => !isKeyframeStep(rule))
    .filter((rule) => rule.selector.split(',').some((part) => !part.includes(`[${FRAME_ATTR}]`)))
    .map((rule) => `${rule.atRule ? `${rule.atRule} ` : ''}${rule.selector}`);
}

describe('the scoping detector itself', () => {
  // A guard that cannot fail is worthless, so prove it catches real leaks.
  it('flags an unscoped rule', () => {
    expect(unscopedSelectors('.NavBar { display: none; }')).toEqual(['.NavBar']);
  });

  it('flags an unscoped rule hidden inside a media query', () => {
    const bad = `@media (prefers-color-scheme: dark) { body { background: #000; } }`;
    expect(unscopedSelectors(bad)).toHaveLength(1);
  });

  it('flags a selector list where only SOME parts are scoped', () => {
    const bad = `html[${FRAME_ATTR}] .a, .b { color: red; }`;
    expect(unscopedSelectors(bad)).toHaveLength(1);
  });

  it('accepts a correctly scoped rule and ignores keyframe steps', () => {
    const good = `html[${FRAME_ATTR}] .a { color: red; } @keyframes x { from { opacity: 0 } to { opacity: 1 } }`;
    expect(unscopedSelectors(good)).toEqual([]);
  });
});

describe('tenor-frame.css scoping', () => {
  it('parses a meaningful number of rules', () => {
    // Sanity: if the walker broke, the invariant test below would pass vacuously.
    expect(rules.length).toBeGreaterThan(20);
  });

  it('scopes EVERY selector under the picker-only attribute', () => {
    const unscoped = rules
      .filter((rule) => !isKeyframeStep(rule))
      .filter((rule) => rule.selector.split(',').some((part) => !part.includes(`[${FRAME_ATTR}]`)))
      .map((rule) => `${rule.atRule ? `${rule.atRule} ` : ''}${rule.selector}`);

    expect(
      unscoped,
      `these rules would leak onto the real tenor.com:\n  ${unscoped.join('\n  ')}`,
    ).toEqual([]);
  });

  it('anchors the scope at the document root, not just anywhere', () => {
    for (const rule of rules) {
      if (isKeyframeStep(rule)) continue;
      for (const part of rule.selector.split(',')) {
        expect(part.trim(), `selector not root-anchored: ${part}`).toMatch(
          new RegExp(`^html\\[${FRAME_ATTR}\\]`),
        );
      }
    }
  });

  it('uses the same attribute name the content script sets', () => {
    // If these ever drift, the stylesheet silently does nothing at all.
    expect(css).toContain(`[${FRAME_ATTR}]`);
    const frameScript = readFileSync(
      new URL('../src/content/tenor-frame.ts', import.meta.url),
      'utf8',
    );
    expect(frameScript).toContain('FRAME_ATTR');
  });

  it('kills promoted tiles by the /view/ invariant, not by a campaign class name', () => {
    expect(css).toContain(":not(:has(a[href^='/view/']))");
    // Matching on `.Card` would break the day tenor runs a different campaign.
    expect(css).not.toMatch(/\.Gif\.Card/);
  });

  it('hides the related-query suggestion rail', () => {
    // The picker shows search results and nothing else. Both the rail and its
    // wrapper go, so no empty gap is left above the grid.
    expect(css).toMatch(/\.TagList\s*\{[\s\S]*?display:\s*none/);
    expect(css).toContain('.gallery-container > .search');
  });

  it('is dark unconditionally rather than following the OS theme', () => {
    // tenor.com is light-only, so a light frame inside dark chrome would read
    // as broken. The theme is ours and is not negotiable at runtime.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/@media[^{]*prefers-color-scheme/);
    expect(withoutComments).toContain('color-scheme: dark');
  });

  it('injects the favourite star OUTSIDE the tile anchor', () => {
    // Positioned absolutely above the anchor, and appended as its sibling by
    // tenor-frame.ts, so clicking the star can never also copy the GIF.
    expect(css).toContain('.tgp-star');
    expect(css).toMatch(/\.tgp-star\s*\{[\s\S]*?position:\s*absolute/);
    expect(css).toMatch(/\.tgp-star\s*\{[\s\S]*?z-index/);
  });
});

describe('manifest sanity', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

  it('is manifest v3', () => {
    expect(manifest['manifest_version']).toBe(3);
  });

  it('does NOT request <all_urls> host permissions', () => {
    // This is what keeps the install prompt to "your data on tenor.com" rather
    // than "all your data on all websites". The overlay is injected on demand
    // through activeTab instead.
    const hosts = manifest['host_permissions'] as string[];
    expect(hosts).toEqual(['*://tenor.com/*', '*://*.tenor.com/*']);
    const permissions = manifest['permissions'] as string[];
    expect(permissions).toContain('activeTab');
    expect(permissions).not.toContain('tabs');
    expect(permissions).not.toContain('clipboardRead');
  });

  it('declares the permissions the clipboard ladder actually needs', () => {
    const permissions = manifest['permissions'] as string[];
    expect(permissions).toContain('clipboardWrite');
    expect(permissions).toContain('offscreen');
    expect(permissions).toContain('declarativeNetRequestWithHostAccess');
  });

  it('injects into the tenor frame at document_start, in all frames', () => {
    const scripts = manifest['content_scripts'] as Array<Record<string, unknown>>;
    const tenor = scripts.find((script) => (script['js'] as string[]).includes('tenor-frame.js'));
    expect(tenor).toBeDefined();
    // document_start matters: our capture listeners must beat tenor's bundle.
    expect(tenor?.['run_at']).toBe('document_start');
    // all_frames matters: the tenor document IS a sub-frame.
    expect(tenor?.['all_frames']).toBe(true);
    expect(tenor?.['matches']).toEqual(['*://tenor.com/*', '*://*.tenor.com/*']);
  });

  it('runs the overlay only in the top frame of each page', () => {
    const scripts = manifest['content_scripts'] as Array<Record<string, unknown>>;
    const overlay = scripts.find((script) =>
      (script['js'] as string[]).includes('host-overlay.js'),
    );
    expect(overlay).toBeDefined();
    // all_frames:false — otherwise every ad iframe spawns its own picker.
    expect(overlay?.['all_frames']).toBe(false);
    expect(overlay?.['matches']).toEqual(['<all_urls>']);
  });

  it('has no default_popup, so action.onClicked fires and grants activeTab', () => {
    const action = manifest['action'] as Record<string, unknown>;
    expect(action['default_popup']).toBeUndefined();
  });
});
