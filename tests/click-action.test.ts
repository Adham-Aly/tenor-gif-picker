/**
 * Click-policy integration tests.
 *
 * These run the real decision function over EVERY anchor in a real captured
 * tenor search page. That matters because the two obvious policies are both
 * wrong: blanket-blocking navigation kills the 142 search chips (and search
 * itself), while blanket-allowing it means results navigate away instead of
 * copying.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

import { decideClickAction, type ClickAction } from '../src/shared/click-action.js';

const BASE = 'https://tenor.com/search/cat-gifs';
const plain = { baseUrl: BASE, plainClick: true };
const modified = { baseUrl: BASE, plainClick: false };

const html = readFileSync(new URL('./fixtures/tenor-search-cat.html', import.meta.url), 'utf8');
const { document } = parseHTML(html);

const anchors = [...document.querySelectorAll('a[href]')];
const hrefOf = (a: Element): string => a.getAttribute('href') ?? '';

describe('policy over the whole captured page', () => {
  it('classifies every anchor without throwing', () => {
    expect(anchors.length).toBeGreaterThan(150);
    for (const anchor of anchors) {
      const action = decideClickAction(hrefOf(anchor), plain);
      expect(['copy', 'search', 'external', 'allow']).toContain(action.kind);
    }
  });

  it('copies exactly the result anchors — no more, no less', () => {
    const copied = anchors.filter((a) => decideClickAction(hrefOf(a), plain).kind === 'copy');
    const resultAnchors = [...document.querySelectorAll('a[href^="/view/"]')];

    expect(copied.length).toBe(resultAnchors.length);
    expect(copied.length).toBeGreaterThanOrEqual(40);
  });

  it('produces a canonical URL for every copy decision', () => {
    for (const anchor of anchors) {
      const action = decideClickAction(hrefOf(anchor), plain);
      if (action.kind !== 'copy') continue;
      expect(action.url).toMatch(/^https:\/\/tenor\.com\/view\/[^/?#]+$/);
    }
  });

  it('routes the tag chips to search rather than blocking or ignoring them', () => {
    const searched = anchors.filter((a) => decideClickAction(hrefOf(a), plain).kind === 'search');
    // 142 of 209 on capture. If this collapsed to zero we would have silently
    // broken the majority of the page.
    expect(searched.length).toBeGreaterThan(50);
    for (const anchor of searched) {
      const action = decideClickAction(hrefOf(anchor), plain) as Extract<
        ClickAction,
        { kind: 'search' }
      >;
      expect(action.query.length).toBeGreaterThan(0);
      expect(action.query).not.toContain('/');
    }
  });

  it('never sends an in-site tenor link to an external tab', () => {
    for (const anchor of anchors) {
      const href = hrefOf(anchor);
      if (!href.startsWith('/')) continue;
      expect(decideClickAction(href, plain).kind).not.toBe('external');
    }
  });
});

describe('the promoted tile', () => {
  it('is never treated as a result, so it cannot produce a bogus clipboard write', () => {
    const tiles = [...document.querySelectorAll('.UniversalGifListItem')];
    const promoted = tiles.filter((tile) => tile.querySelector('a[href^="/view/"]') === null);
    expect(promoted.length).toBeGreaterThan(0);

    for (const tile of promoted) {
      for (const anchor of tile.querySelectorAll('a[href]')) {
        // Belt and braces with the CSS: even if the stylesheet fails entirely
        // and the user clicks the ad, it does what tenor intended and copies
        // nothing.
        expect(decideClickAction(hrefOf(anchor), plain).kind).not.toBe('copy');
      }
    }
  });
});

describe('clicking the image inside a tile', () => {
  it('resolves to the tile anchor, because that is what users actually click', () => {
    const images = [...document.querySelectorAll('.UniversalGifListItem img')];
    expect(images.length).toBeGreaterThan(10);

    let copies = 0;
    for (const image of images) {
      const anchor = image.closest('a');
      if (!anchor) continue;
      const action = decideClickAction(hrefOf(anchor), plain);
      if (action.kind === 'copy') copies += 1;
    }
    // Every real result image must resolve to a copy.
    expect(copies).toBeGreaterThanOrEqual(40);
  });
});

describe('modifier keys', () => {
  const resultHref = '/view/happy-cat-gif-10804346947536782797';
  const chipHref = '/search/kitten-gifs';

  it('copies results regardless of modifiers — new-tab is never the goal here', () => {
    expect(decideClickAction(resultHref, plain).kind).toBe('copy');
    expect(decideClickAction(resultHref, modified).kind).toBe('copy');
  });

  it('lets modified clicks on chips keep their conventional new-tab behaviour', () => {
    expect(decideClickAction(chipHref, plain).kind).toBe('search');
    expect(decideClickAction(chipHref, modified).kind).toBe('allow');
  });
});

describe('edge cases', () => {
  it('sends off-origin links to a real tab instead of hijacking the frame', () => {
    const action = decideClickAction('https://apps.apple.com/app/tenor', plain);
    expect(action).toEqual({ kind: 'external', url: 'https://apps.apple.com/app/tenor' });
  });

  it('leaves non-navigable schemes completely alone', () => {
    for (const href of ['javascript:void(0)', 'mailto:a@b.c', 'blob:https://tenor.com/x']) {
      expect(decideClickAction(href, plain).kind).toBe('allow');
    }
  });

  it('treats in-document links as ordinary navigation, not as tag chips', () => {
    // These resolve to the current URL, which on a search page is itself a
    // /search/ path — the trap this guards against.
    for (const href of ['', '   ', '#', '#top']) {
      expect(decideClickAction(href, plain).kind).toBe('allow');
    }
  });

  it('does not mistake a /view/ substring in a query string for a result', () => {
    expect(decideClickAction('/search/x-gifs?next=/view/cat-gif-1', plain).kind).toBe('search');
    expect(decideClickAction('https://evil.example/?u=/view/cat-gif-1', plain)).toEqual({
      kind: 'external',
      url: 'https://evil.example/?u=/view/cat-gif-1',
    });
  });

  it('handles an empty href without throwing', () => {
    expect(decideClickAction('', plain).kind).toBe('allow');
  });
});
