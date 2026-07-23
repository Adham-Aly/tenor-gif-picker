/**
 * Click policy for the tenor frame, separated from the DOM plumbing so it can
 * be exhaustively tested against real captured markup.
 *
 * This is the single most behaviour-defining decision in the extension: on a
 * page where 142 of 209 anchors are search chips and only 49 are results, both
 * "block everything" and "block nothing" are wrong.
 */

import { canonicalViewUrl, isTenorHost, parseSearchSlug, safeUrl } from './urls.js';

export type ClickAction =
  /** A GIF result: copy its canonical link instead of navigating. */
  | { kind: 'copy'; url: string }
  /** One of tenor's related-tag chips: relay the query to our own search box. */
  | { kind: 'search'; query: string }
  /** Leaves tenor.com: open in a real tab so the picker stays a picker. */
  | { kind: 'external'; url: string }
  /** In-site navigation we deliberately let happen (pagination, etc). */
  | { kind: 'allow' };

export interface ClickContext {
  /** Absolute URL of the document the anchor lives in. */
  baseUrl: string;
  /**
   * Plain left click with no modifier keys. Modified clicks on chips keep their
   * conventional new-tab behaviour; modified clicks on RESULTS still copy,
   * because inside a GIF picker "open in a new tab" is never the goal.
   */
  plainClick: boolean;
}

export function decideClickAction(href: string, context: ClickContext): ClickAction {
  const { baseUrl, plainClick } = context;

  // In-document links resolve to the CURRENT url, which on a search page is
  // itself a /search/ path — so without this they would be misread as tag chips
  // and trigger a pointless re-search.
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return { kind: 'allow' };

  // Results win unconditionally — including middle-click and Cmd/Ctrl-click.
  const viewUrl = canonicalViewUrl(href, baseUrl);
  if (viewUrl) return { kind: 'copy', url: viewUrl };

  const target = safeUrl(href, baseUrl);
  if (!target) return { kind: 'allow' };

  // Non-navigable schemes (javascript:, mailto:, blob:) are left entirely alone.
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return { kind: 'allow' };

  if (isTenorHost(target.hostname)) {
    if (!plainClick) return { kind: 'allow' };
    const query = parseSearchSlug(target.pathname);
    if (query) return { kind: 'search', query };
    return { kind: 'allow' };
  }

  return { kind: 'external', url: target.href };
}
