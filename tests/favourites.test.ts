import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_FAVOURITES, STORAGE_KEYS } from '../src/shared/constants.js';
import {
  clearFavourites,
  containsUrl,
  loadFavourites,
  removeFavourite,
  toggleFavourite,
  watchFavourites,
  type Favourite,
} from '../src/shared/favourites.js';

type ChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void;

/** Minimal chrome.storage stand-in with working change notifications. */
function installFakeStorage(): { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  const listeners: ChangeListener[] = [];

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: data[key] }),
        set: (patch: Record<string, unknown>) => {
          const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
          for (const [key, value] of Object.entries(patch)) {
            changes[key] = { oldValue: data[key], newValue: value };
            data[key] = value;
          }
          for (const listener of [...listeners]) listener(changes, 'local');
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (listener: ChangeListener) => listeners.push(listener),
        removeListener: (listener: ChangeListener) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
    },
  };

  return { data };
}

const A = 'https://tenor.com/view/happy-cat-gif-10804346947536782797';
const B = 'https://tenor.com/view/other-gif-2';

function fav(url: string, thumb = 'https://media.tenor.com/x/y.gif'): Favourite {
  return { url, thumb, alt: 'a gif', addedAt: 0 };
}

let store: { data: Record<string, unknown> };

beforeEach(() => {
  store = installFakeStorage();
});

describe('toggleFavourite', () => {
  it('adds then removes, reporting the new state each time', async () => {
    expect(await toggleFavourite(fav(A))).toBe(true);
    expect(await loadFavourites()).toHaveLength(1);

    expect(await toggleFavourite(fav(A))).toBe(false);
    expect(await loadFavourites()).toHaveLength(0);
  });

  it('stores the canonical url, not whatever it was handed', async () => {
    await toggleFavourite(fav(`${A}?utm_source=search#x`));
    const [saved] = await loadFavourites();
    expect(saved?.url).toBe(A);
  });

  it('refuses anything that is not a tenor view link', async () => {
    expect(await toggleFavourite(fav('https://evil.example/view/x'))).toBe(false);
    expect(await toggleFavourite(fav('/search/cat-gifs'))).toBe(false);
    expect(await loadFavourites()).toHaveLength(0);
  });

  it('keeps newest first', async () => {
    await toggleFavourite(fav(A));
    await toggleFavourite(fav(B));
    const list = await loadFavourites();
    expect(list.map((item) => item.url)).toEqual([B, A]);
  });

  it('does not duplicate an already-favourited gif', async () => {
    await toggleFavourite(fav(A));
    await toggleFavourite(fav(A)); // removes
    await toggleFavourite(fav(A)); // re-adds
    expect(await loadFavourites()).toHaveLength(1);
  });

  it('preserves the thumbnail so the panel can render offline of tenor', async () => {
    await toggleFavourite(fav(A, 'https://media.tenor.com/abc/cat.gif'));
    const [saved] = await loadFavourites();
    expect(saved?.thumb).toBe('https://media.tenor.com/abc/cat.gif');
  });
});

describe('loadFavourites', () => {
  it('survives corrupted storage without throwing', async () => {
    store.data[STORAGE_KEYS.favourites] = 'not an array';
    expect(await loadFavourites()).toEqual([]);

    store.data[STORAGE_KEYS.favourites] = [null, 42, { url: 'nonsense' }, { url: A }];
    const list = await loadFavourites();
    expect(list).toHaveLength(1);
    expect(list[0]?.url).toBe(A);
  });

  it('caps the stored list', async () => {
    const many = Array.from({ length: MAX_FAVOURITES + 25 }, (_, i) => ({
      url: `https://tenor.com/view/gif-${i}`,
      thumb: null,
      alt: null,
      addedAt: i,
    }));
    store.data[STORAGE_KEYS.favourites] = many;
    await toggleFavourite(fav(A));
    const list = await loadFavourites();
    expect(list.length).toBeLessThanOrEqual(MAX_FAVOURITES);
  });
});

describe('containsUrl', () => {
  it('matches regardless of query string or trailing slash', () => {
    const list = [fav(A)];
    expect(containsUrl(list, A)).toBe(true);
    expect(containsUrl(list, `${A}?utm=1`)).toBe(true);
    expect(containsUrl(list, `${A}/`)).toBe(true);
    expect(containsUrl(list, B)).toBe(false);
    expect(containsUrl(list, 'garbage')).toBe(false);
  });
});

describe('removeFavourite / clearFavourites', () => {
  it('removes one', async () => {
    await toggleFavourite(fav(A));
    await toggleFavourite(fav(B));
    await removeFavourite(A);
    const list = await loadFavourites();
    expect(list.map((item) => item.url)).toEqual([B]);
  });

  it('clears all', async () => {
    await toggleFavourite(fav(A));
    await clearFavourites();
    expect(await loadFavourites()).toEqual([]);
  });
});

describe('watchFavourites', () => {
  it('notifies other contexts when the list changes', async () => {
    // This is how the tenor frame's stars and the picker's panel stay in sync
    // without any message plumbing between them.
    const seen = vi.fn();
    const stop = watchFavourites(seen);

    await toggleFavourite(fav(A));

    expect(seen).toHaveBeenCalledTimes(1);
    const list = seen.mock.calls[0]?.[0] as Favourite[];
    expect(list.map((item) => item.url)).toEqual([A]);

    stop();
    await toggleFavourite(fav(B));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('ignores changes to unrelated storage keys', async () => {
    const seen = vi.fn();
    watchFavourites(seen);
    await chrome.storage.local.set({ [STORAGE_KEYS.recents]: ['cat'] });
    expect(seen).not.toHaveBeenCalled();
  });
});
