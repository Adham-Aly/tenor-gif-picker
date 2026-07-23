/**
 * URL construction and validation.
 *
 * These are the functions that actually deliver the product's stipulation
 * ("clicking a GIF copies its link"), so they are pure, exported, and unit
 * tested. Every other module treats them as the single source of truth —
 * notably the service worker re-validates URLs with `canonicalViewUrl` even
 * though the content script already did, because the SW is the component that
 * ultimately causes a clipboard write and must not trust a string it did not
 * parse itself.
 */

import { TENOR_ORIGIN } from './constants.js';

/** `tenor.com` and any subdomain of it. Anchored — `nottenor.com` must not match. */
const TENOR_HOST_RE = /^(?:[a-z0-9-]+\.)*tenor\.com$/i;

export function isTenorHost(hostname: string): boolean {
  return TENOR_HOST_RE.test(hostname);
}

/** Parse without throwing. */
export function safeUrl(href: string, base?: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

/**
 * Resolve an href to the canonical, query-free `https://tenor.com/view/<slug>`
 * URL — exactly the shape the user asked to have copied — or null if this is
 * not a GIF result link.
 *
 * Deliberate details:
 *  - The check is `pathname.startsWith('/view/')`, NOT a substring test on the
 *    whole href. `href*="/view/"` false-positives on `?next=/view/x`.
 *  - The query string and hash are dropped. Tenor decorates some links with
 *    tracking params; the example URL in the spec is clean and a stray
 *    `?utm_source=` would be a visible defect on paste.
 *  - The origin is normalised to `https://tenor.com` so the output is
 *    deterministic even if the anchor was resolved against `www.tenor.com`.
 */
export function canonicalViewUrl(href: string, base: string = TENOR_ORIGIN): string | null {
  const u = safeUrl(href, base);
  if (!u) return null;
  if (u.protocol !== 'https:') return null;
  if (!isTenorHost(u.hostname)) return null;
  if (!u.pathname.startsWith('/view/')) return null;

  const slug = u.pathname.slice('/view/'.length);
  if (!slug || slug === '/') return null;

  return `${TENOR_ORIGIN}${u.pathname.replace(/\/+$/, '')}`;
}

/** Convenience predicate over {@link canonicalViewUrl}. */
export function isTenorViewUrl(href: string): boolean {
  return canonicalViewUrl(href) !== null;
}

/**
 * Turn a human query into tenor's search slug.
 * "Happy   Cat" -> "happy-cat", which becomes /search/happy-cat-gifs
 */
export function slugifyQuery(query: string): string | null {
  const normalised = query.trim().replace(/\s+/g, ' ');
  if (!normalised) return null;
  return normalised.toLowerCase().split(' ').map(encodeURIComponent).join('-');
}

/**
 * Build the URL we point the iframe at. Results are server-rendered into this
 * document, so first paint is already GIFs — never route a search through the
 * homepage.
 */
export function buildSearchUrl(query: string): string | null {
  const slug = slugifyQuery(query);
  if (!slug) return null;
  return `${TENOR_ORIGIN}/search/${slug}-gifs`;
}

/** Suffixes tenor appends to search slugs, longest first so `-gifs` wins over `-gif`. */
const SEARCH_SUFFIXES = ['-stickers', '-memes', '-gifs', '-gif'];

/**
 * Inverse of {@link buildSearchUrl}: recover the human query from a tenor
 * `/search/...` pathname. Used when the user clicks one of tenor's own related
 * tag chips, so we can keep OUR search box in sync rather than letting the
 * frame silently diverge from it.
 */
export function parseSearchSlug(pathname: string): string | null {
  if (!pathname.startsWith('/search/')) return null;

  let slug = pathname.slice('/search/'.length).replace(/\/+$/, '');
  if (!slug) return null;

  for (const suffix of SEARCH_SUFFIXES) {
    if (slug.endsWith(suffix) && slug.length > suffix.length) {
      slug = slug.slice(0, -suffix.length);
      break;
    }
  }
  if (!slug) return null;

  const query = slug
    .split('-')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join(' ')
    .trim();

  return query || null;
}

/** Extract the query from a full tenor search href, or null. */
export function searchQueryFromHref(href: string, base: string = TENOR_ORIGIN): string | null {
  const u = safeUrl(href, base);
  if (!u || !isTenorHost(u.hostname)) return null;
  return parseSearchSlug(u.pathname);
}

/**
 * Pages we can never inject into. Chrome refuses content scripts on its own
 * UI, the Web Store, and other extensions; this lets us say so clearly instead
 * of presenting a toolbar button that silently does nothing.
 */
export function isInjectableUrl(url: string | undefined): boolean {
  if (!url) return false;
  const u = safeUrl(url);
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'chromewebstore.google.com') return false;
  if (host === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return false;
  return true;
}
