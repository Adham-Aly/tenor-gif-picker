/**
 * The tenor-markup canary (offline half).
 *
 * Every cosmetic and behavioural decision in this extension rests on structural
 * facts about tenor's shipped HTML. These tests pin those facts against a real
 * captured page, so that a change in our own selectors breaks a test rather
 * than silently producing a blank picker.
 *
 * The online half — which catches TENOR changing rather than us — lives in
 * canary.live.test.ts and runs via `npm run canary`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

import { canonicalViewUrl, parseSearchSlug } from '../src/shared/urls.js';

const html = readFileSync(new URL('./fixtures/tenor-search-cat.html', import.meta.url), 'utf8');
const { document } = parseHTML(html);

const tiles = (): Element[] => [...document.querySelectorAll('.UniversalGifListItem')];
const resultAnchors = (): Element[] => [...document.querySelectorAll('a[href^="/view/"]')];

describe('Tier A allow-list assumptions', () => {
  it('has a single .BaseApp root', () => {
    expect(document.querySelectorAll('.BaseApp')).toHaveLength(1);
  });

  it('.BaseApp has the expected small number of direct children', () => {
    // The allow-list hides `.BaseApp > *:not(.SearchPage)`. If this count moves
    // a long way, their structure has shifted and the surgery needs review —
    // this is the same signal as runtime health check H3.
    const children = document.querySelector('.BaseApp')?.children.length ?? 0;
    expect(children).toBeGreaterThanOrEqual(5);
    expect(children).toBeLessThanOrEqual(10);
  });

  it('.SearchPage is a direct child of .BaseApp', () => {
    const searchPage = document.querySelector('.BaseApp > .SearchPage');
    expect(searchPage).not.toBeNull();
  });

  it('.gallery-container is a direct child of .SearchPage', () => {
    // Tier A's second selector depends on exactly this relationship. If it
    // breaks, the allow-list hides the results and H2 self-heals — but we would
    // much rather find out here.
    expect(document.querySelector('.SearchPage > .gallery-container')).not.toBeNull();
  });

  it('still ships the related-query rail our Tier B rule targets', () => {
    // We hide this rather than remove it. If tenor renames it, the rail would
    // reappear inside the picker, so the selector is pinned here.
    expect(document.querySelector('.SearchPage .TagList')).not.toBeNull();
    expect(document.querySelector('.gallery-container > .search')).not.toBeNull();
  });

  it('the results grid lives INSIDE .gallery-container > .search', () => {
    // This is the fact that makes the "never hide .search" CSS guard load-bearing:
    // hiding .search hides the grid. If tenor ever moves the grid OUT of .search,
    // this fails and we can safely simplify — but until then, .search must stay
    // visible. `.search`'s children on a search page are the rail, the format
    // toggle, and the grid itself.
    const searchWrap = document.querySelector('.gallery-container > .search');
    expect(searchWrap).not.toBeNull();
    expect(searchWrap?.querySelector('.UniversalGifList')).not.toBeNull();
    expect(searchWrap?.querySelectorAll('a[href^="/view/"]').length ?? 0).toBeGreaterThan(20);
  });
});

describe('result extraction — the product stipulation', () => {
  it('finds a full page of results', () => {
    expect(resultAnchors().length).toBeGreaterThanOrEqual(40);
  });

  it('produces a canonical tenor.com/view/ URL for EVERY result anchor', () => {
    const anchors = resultAnchors();
    expect(anchors.length).toBeGreaterThan(0);

    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') ?? '';
      const url = canonicalViewUrl(href);
      expect(url, `failed for href=${href}`).not.toBeNull();
      expect(url).toMatch(/^https:\/\/tenor\.com\/view\/[^/?#]+$/);
    }
  });

  it('matches the URL shape from the product spec', () => {
    const first = resultAnchors()[0];
    expect(first).toBeDefined();
    const url = canonicalViewUrl(first?.getAttribute('href') ?? '');
    // e.g. https://tenor.com/view/oh-hiiii-...-gif-5877185002260097302
    expect(url).toMatch(/^https:\/\/tenor\.com\/view\/[a-z0-9-]+-gif-\d+$/);
  });
});

describe('Tier D — promoted tiles', () => {
  it('there are more tiles than results, i.e. tenor injects promos into the grid', () => {
    expect(tiles().length).toBeGreaterThan(resultAnchors().length);
  });

  it('the /view/ invariant identifies exactly the non-result tiles', () => {
    // This is the logic behind `.UniversalGifListItem:not(:has(a[href^="/view/"]))`,
    // expressed with traversal so it is portable across DOM implementations.
    const promoted = tiles().filter((tile) => tile.querySelector('a[href^="/view/"]') === null);

    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted.length).toBeLessThanOrEqual(3);

    // And every one of them is an internal upsell, not a GIF.
    for (const tile of promoted) {
      const href = tile.querySelector('a')?.getAttribute('href') ?? '';
      expect(canonicalViewUrl(href)).toBeNull();
    }
  });

  it('a promoted tile can never produce a clipboard write', () => {
    // Belt and braces: even with the stylesheet entirely disabled, the click
    // interceptor keys on the same invariant.
    const promoted = tiles().filter((tile) => tile.querySelector('a[href^="/view/"]') === null);
    for (const tile of promoted) {
      for (const anchor of tile.querySelectorAll('a')) {
        expect(canonicalViewUrl(anchor.getAttribute('href') ?? '')).toBeNull();
      }
    }
  });
});

describe('search chips', () => {
  it('the page is dominated by /search/ links, so blanket blocking would be wrong', () => {
    const searchLinks = [...document.querySelectorAll('a[href^="/search/"]')];
    // Blocking all navigation would kill these — 142 of 209 anchors on capture.
    expect(searchLinks.length).toBeGreaterThan(resultAnchors().length);
  });

  it('every chip href yields a usable query for our search box', () => {
    const chips = [...document.querySelectorAll('.TagList a[href^="/search/"]')];
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      const query = parseSearchSlug(chip.getAttribute('href') ?? '');
      expect(query, `failed for ${chip.getAttribute('href')}`).toBeTruthy();
    }
  });
});

describe('layout assumptions', () => {
  it('renders two masonry columns at the captured width', () => {
    // The entire 400px geometry decision rests on tenor's own JS threshold
    // (`containerWidth > 576 ? 3 : 2`).
    expect(document.querySelectorAll('.UniversalGifList .column')).toHaveLength(2);
  });

  it('the search form has no action/method — search is JS-routed', () => {
    // This is why we own the search box instead of driving theirs: with no form
    // semantics we would be a passenger unable to read the query.
    const form = document.querySelector('form.SearchBar');
    expect(form).not.toBeNull();
    expect(form?.getAttribute('action')).toBeNull();
    expect(form?.getAttribute('method')).toBeNull();
    expect(form?.querySelector('button')).toBeNull();
  });

  it('exposes a release string we can record in bug reports', () => {
    const el = document.querySelector('script[src*="release="], link[href*="release="]');
    const raw = el?.getAttribute('src') ?? el?.getAttribute('href') ?? '';
    expect(raw).toMatch(/release=/);
  });
});
