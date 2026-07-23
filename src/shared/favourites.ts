/**
 * Favourite GIFs.
 *
 * State lives in `chrome.storage.local` and every context reads it directly
 * rather than being told about it over messages. Both the tenor frame (which
 * draws the stars) and the picker (which renders the favourites panel) subscribe
 * to `chrome.storage.onChanged`, so a star toggled in one place updates the
 * other with no plumbing and no chance of the two drifting apart.
 */

import { MAX_FAVOURITES, STORAGE_KEYS } from './constants.js';
import { canonicalViewUrl } from './urls.js';

export interface Favourite {
  /** Canonical https://tenor.com/view/... link — the primary key. */
  url: string;
  /** Direct media URL used to render the tile in the favourites panel. */
  thumb: string | null;
  alt: string | null;
  addedAt: number;
}

function isFavourite(value: unknown): value is Favourite {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['url'] === 'string' && canonicalViewUrl(record['url']) !== null;
}

export async function loadFavourites(): Promise<Favourite[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.favourites);
    const raw: unknown = stored[STORAGE_KEYS.favourites];
    if (!Array.isArray(raw)) return [];
    return raw.filter(isFavourite);
  } catch {
    return [];
  }
}

async function save(list: Favourite[]): Promise<void> {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.favourites]: list.slice(0, MAX_FAVOURITES),
    });
  } catch {
    /* storage is best-effort; a failed write must not break the picker */
  }
}

export function containsUrl(list: readonly Favourite[], url: string): boolean {
  const canonical = canonicalViewUrl(url);
  if (!canonical) return false;
  return list.some((item) => item.url === canonical);
}

/** Adds if missing, removes if present. Resolves to the NEW favourited state. */
export async function toggleFavourite(candidate: Favourite): Promise<boolean> {
  const canonical = canonicalViewUrl(candidate.url);
  if (!canonical) return false;

  const list = await loadFavourites();
  const existing = list.findIndex((item) => item.url === canonical);

  if (existing >= 0) {
    list.splice(existing, 1);
    await save(list);
    return false;
  }

  // Newest first, so the favourites panel reads most-recent-first.
  list.unshift({
    url: canonical,
    thumb: candidate.thumb ?? null,
    alt: candidate.alt ?? null,
    addedAt: Date.now(),
  });
  await save(list);
  return true;
}

export async function removeFavourite(url: string): Promise<void> {
  const canonical = canonicalViewUrl(url);
  if (!canonical) return;
  const list = await loadFavourites();
  await save(list.filter((item) => item.url !== canonical));
}

export async function clearFavourites(): Promise<void> {
  await save([]);
}

/** Subscribe to changes from any context. Returns an unsubscribe function. */
export function watchFavourites(onChange: (list: Favourite[]) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    const change = changes[STORAGE_KEYS.favourites];
    if (!change) return;
    const next: unknown = change.newValue;
    onChange(Array.isArray(next) ? next.filter(isFavourite) : []);
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
