import { describe, expect, it } from 'vitest';

import {
  buildSearchUrl,
  canonicalViewUrl,
  isInjectableUrl,
  isTenorHost,
  isTenorViewUrl,
  parseSearchSlug,
  searchQueryFromHref,
  slugifyQuery,
} from '../src/shared/urls.js';

/** The exact URL from the product spec. */
const SPEC_URL = 'https://tenor.com/view/oh-hiiii-oh-hi-hi-hello-lizard-gif-5877185002260097302';

describe('isTenorHost', () => {
  it('accepts tenor.com and its subdomains', () => {
    expect(isTenorHost('tenor.com')).toBe(true);
    expect(isTenorHost('www.tenor.com')).toBe(true);
    expect(isTenorHost('media1.tenor.com')).toBe(true);
    expect(isTenorHost('TENOR.COM')).toBe(true);
  });

  it('is anchored so lookalike domains cannot pass', () => {
    expect(isTenorHost('nottenor.com')).toBe(false);
    expect(isTenorHost('tenor.com.evil.example')).toBe(false);
    expect(isTenorHost('eviltenor.com')).toBe(false);
    expect(isTenorHost('tenor.co')).toBe(false);
  });
});

describe('canonicalViewUrl', () => {
  it('round-trips the URL from the spec unchanged', () => {
    expect(canonicalViewUrl(SPEC_URL)).toBe(SPEC_URL);
  });

  it('resolves the relative hrefs tenor actually ships', () => {
    expect(canonicalViewUrl('/view/happy-cat-gif-10804346947536782797')).toBe(
      'https://tenor.com/view/happy-cat-gif-10804346947536782797',
    );
  });

  it('strips query strings and fragments so a paste is never polluted', () => {
    expect(canonicalViewUrl('/view/cat-gif-1?utm_source=search&foo=bar')).toBe(
      'https://tenor.com/view/cat-gif-1',
    );
    expect(canonicalViewUrl('/view/cat-gif-1#comments')).toBe('https://tenor.com/view/cat-gif-1');
  });

  it('normalises the origin so output is deterministic', () => {
    expect(canonicalViewUrl('https://www.tenor.com/view/cat-gif-1')).toBe(
      'https://tenor.com/view/cat-gif-1',
    );
  });

  it('strips a trailing slash', () => {
    expect(canonicalViewUrl('/view/cat-gif-1/')).toBe('https://tenor.com/view/cat-gif-1');
  });

  it('checks the PATH, not a substring of the href', () => {
    // This is the case that `href*="/view/"` gets wrong.
    expect(canonicalViewUrl('/search/cats-gifs?next=/view/cat-gif-1')).toBeNull();
    expect(canonicalViewUrl('https://tenor.com/gif-maker?r=/view/x')).toBeNull();
  });

  it('rejects non-tenor hosts even when the path looks right', () => {
    expect(canonicalViewUrl('https://evil.example/view/cat-gif-1')).toBeNull();
    expect(canonicalViewUrl('https://tenor.com.evil.example/view/cat-gif-1')).toBeNull();
  });

  it('rejects non-https schemes', () => {
    expect(canonicalViewUrl('http://tenor.com/view/cat-gif-1')).toBeNull();
    expect(canonicalViewUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalViewUrl('data:text/html,<h1>x</h1>')).toBeNull();
  });

  it('rejects a /view/ path with no slug', () => {
    expect(canonicalViewUrl('/view/')).toBeNull();
    expect(canonicalViewUrl('/view')).toBeNull();
  });

  it('rejects unparseable input without throwing', () => {
    expect(canonicalViewUrl('')).toBeNull();
    expect(canonicalViewUrl('   ')).toBeNull();
    expect(canonicalViewUrl('://////')).toBeNull();
  });

  it('isTenorViewUrl agrees with canonicalViewUrl', () => {
    expect(isTenorViewUrl(SPEC_URL)).toBe(true);
    expect(isTenorViewUrl('https://tenor.com/search/cat-gifs')).toBe(false);
  });
});

describe('slugifyQuery / buildSearchUrl', () => {
  it('builds the URL shape tenor serves', () => {
    expect(buildSearchUrl('cat')).toBe('https://tenor.com/search/cat-gifs');
    expect(buildSearchUrl('happy cat')).toBe('https://tenor.com/search/happy-cat-gifs');
  });

  it('normalises case and runs of whitespace', () => {
    expect(buildSearchUrl('  Happy   CAT  ')).toBe('https://tenor.com/search/happy-cat-gifs');
  });

  it('encodes characters that would otherwise break the path', () => {
    expect(buildSearchUrl('50% off')).toBe('https://tenor.com/search/50%25-off-gifs');
    expect(buildSearchUrl('a/b')).toBe('https://tenor.com/search/a%2Fb-gifs');
    expect(buildSearchUrl('q?x=1')).toBe('https://tenor.com/search/q%3Fx%3D1-gifs');
    expect(buildSearchUrl('#tag')).toBe('https://tenor.com/search/%23tag-gifs');
  });

  it('returns null for empty input rather than a broken URL', () => {
    expect(buildSearchUrl('')).toBeNull();
    expect(buildSearchUrl('    ')).toBeNull();
    expect(slugifyQuery('\n\t ')).toBeNull();
  });

  it('leaves hyphenated queries alone', () => {
    expect(buildSearchUrl('spider-man')).toBe('https://tenor.com/search/spider-man-gifs');
  });
});

describe('parseSearchSlug', () => {
  it('recovers the query from tenor search paths', () => {
    expect(parseSearchSlug('/search/cat-gifs')).toBe('cat');
    expect(parseSearchSlug('/search/happy-cat-gifs')).toBe('happy cat');
  });

  it('handles the other suffixes tenor uses', () => {
    expect(parseSearchSlug('/search/cat-stickers')).toBe('cat');
    expect(parseSearchSlug('/search/cat-memes')).toBe('cat');
  });

  it('decodes percent-encoded segments', () => {
    expect(parseSearchSlug('/search/50%25-off-gifs')).toBe('50% off');
  });

  it('round-trips through buildSearchUrl for ordinary queries', () => {
    for (const query of ['cat', 'happy cat', 'thank you', 'good morning']) {
      const url = buildSearchUrl(query);
      expect(url).not.toBeNull();
      expect(parseSearchSlug(new URL(url as string).pathname)).toBe(query);
    }
  });

  it('rejects non-search paths', () => {
    expect(parseSearchSlug('/view/cat-gif-1')).toBeNull();
    expect(parseSearchSlug('/')).toBeNull();
    expect(parseSearchSlug('/search/')).toBeNull();
  });

  it('does not strip a suffix that is the whole slug', () => {
    expect(parseSearchSlug('/search/gifs')).toBe('gifs');
  });
});

describe('searchQueryFromHref', () => {
  it('extracts queries from the relative chip hrefs on a tenor page', () => {
    expect(searchQueryFromHref('/search/kitten-gifs')).toBe('kitten');
  });

  it('ignores non-tenor hosts', () => {
    expect(searchQueryFromHref('https://evil.example/search/kitten-gifs')).toBeNull();
  });
});

describe('isInjectableUrl', () => {
  it('allows ordinary web pages', () => {
    expect(isInjectableUrl('https://github.com/foo')).toBe(true);
    expect(isInjectableUrl('http://example.com')).toBe(true);
  });

  it('blocks surfaces Chrome will not let us touch', () => {
    expect(isInjectableUrl('chrome://extensions')).toBe(false);
    expect(isInjectableUrl('chrome-extension://abc/page.html')).toBe(false);
    expect(isInjectableUrl('about:blank')).toBe(false);
    expect(isInjectableUrl('file:///Users/me/x.pdf')).toBe(false);
    expect(isInjectableUrl('https://chromewebstore.google.com/detail/x')).toBe(false);
    expect(isInjectableUrl('https://chrome.google.com/webstore/detail/x')).toBe(false);
    expect(isInjectableUrl(undefined)).toBe(false);
  });
});
