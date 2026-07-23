/**
 * The tenor-markup canary (online half) — `npm run canary`.
 *
 * This is the highest-value maintenance test in the project. It catches TENOR
 * changing, days before a user hits a silently broken picker, and it converts
 * "the picker looks wrong now" into a named CI failure.
 *
 * Excluded from `npm test` on purpose: a normal test run must not depend on the
 * network or on a third party's uptime.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { parseHTML } from 'linkedom';

import { canonicalViewUrl } from '../src/shared/urls.js';

const SEARCH_URL = 'https://tenor.com/search/cat-gifs';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let headers: Headers;
let html: string;
let bundle: string;

beforeAll(async () => {
  const response = await fetch(SEARCH_URL, { headers: { 'user-agent': UA } });
  expect(response.status).toBe(200);
  headers = response.headers;
  html = await response.text();

  const bundleMatch = /src="(\/assets\/dist\/main\.min\.js[^"]*)"/.exec(html);
  expect(bundleMatch, 'could not locate tenor main bundle').not.toBeNull();
  const bundleResponse = await fetch(new URL(bundleMatch![1]!, SEARCH_URL), {
    headers: { 'user-agent': UA },
  });
  expect(bundleResponse.status).toBe(200);
  bundle = await bundleResponse.text();
}, 60_000);

describe('framing headers — the load-bearing assumption', () => {
  it('still sends x-frame-options, so the DNR rule is still needed', () => {
    expect(headers.get('x-frame-options')?.toLowerCase()).toBe('deny');
  });

  it('STILL has no frame-ancestors directive', () => {
    // This is the single biggest external dependency in the whole design.
    // `frame-ancestors` is the one CSP directive extensions cannot bypass, and
    // it does NOT fall back to default-src — so its absence is exactly why
    // removing one header is sufficient. If this ever fails, the iframe
    // approach is dead and no amount of DNR will save it.
    const csp = headers.get('content-security-policy') ?? '';
    expect(csp.length).toBeGreaterThan(0);
    expect(csp).not.toMatch(/frame-ancestors/i);
  });
});

describe('no framebusting', () => {
  it('the shipped bundle does not try to break out of frames', () => {
    const patterns = [
      /top\.location/,
      /self\s*!==\s*top/,
      /self\s*!=\s*top/,
      /top\s*!==\s*self/,
      /window\.top\s*!==/,
      /parent\s*!==\s*window/,
      /\.frameElement/,
      /ancestorOrigins/,
    ];
    const hits = patterns.filter((pattern) => pattern.test(bundle)).map(String);
    expect(hits, `framebusting patterns appeared in tenor's bundle: ${hits.join(', ')}`).toEqual(
      [],
    );
  });
});

describe('masonry thresholds — the basis of our geometry', () => {
  it('still switches to 3 columns above 576 and 4 above 1100', () => {
    // Our 400px default width exists precisely so the frame stays under 576 and
    // renders tenor's native 2-column layout. If these move, revisit geometry.
    expect(bundle).toMatch(/1100/);
    expect(bundle).toMatch(/576/);
  });
});

describe('live structure still matches our selectors', () => {
  it('serves results server-side, so first paint is already GIFs', () => {
    const { document } = parseHTML(html);
    const anchors = [...document.querySelectorAll('a[href^="/view/"]')];
    expect(anchors.length).toBeGreaterThanOrEqual(20);
    for (const anchor of anchors) {
      expect(canonicalViewUrl(anchor.getAttribute('href') ?? '')).not.toBeNull();
    }
  });

  it('still exposes .BaseApp > .SearchPage > .gallery-container', () => {
    const { document } = parseHTML(html);
    expect(document.querySelector('.BaseApp > .SearchPage')).not.toBeNull();
    expect(document.querySelector('.SearchPage > .gallery-container')).not.toBeNull();
  });

  it('still nests the results grid inside .gallery-container > .search', () => {
    // The extension must never `display:none` .search, because it wraps the grid.
    // If this ever fails on live tenor, that assumption changed.
    const { document } = parseHTML(html);
    const searchWrap = document.querySelector('.gallery-container > .search');
    expect(searchWrap).not.toBeNull();
    expect(searchWrap?.querySelector('.UniversalGifList')).not.toBeNull();
  });

  it('still keeps .BaseApp direct children in the expected band', () => {
    const { document } = parseHTML(html);
    const count = document.querySelector('.BaseApp')?.children.length ?? 0;
    expect(count).toBeGreaterThanOrEqual(5);
    expect(count).toBeLessThanOrEqual(10);
  });

  it('still renders two masonry columns', () => {
    const { document } = parseHTML(html);
    expect(document.querySelectorAll('.UniversalGifList .column')).toHaveLength(2);
  });

  it('still injects promoted tiles the /view/ invariant can catch', () => {
    const { document } = parseHTML(html);
    const tiles = [...document.querySelectorAll('.UniversalGifListItem')];
    const promoted = tiles.filter((tile) => tile.querySelector('a[href^="/view/"]') === null);
    // Zero is fine (campaign ended). What must hold is that anything which is
    // NOT a result is still detectable by the absence of a /view/ link.
    for (const tile of promoted) {
      const href = tile.querySelector('a')?.getAttribute('href') ?? '';
      expect(canonicalViewUrl(href)).toBeNull();
    }
  });
});
