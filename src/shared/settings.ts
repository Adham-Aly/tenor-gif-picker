/**
 * User settings.
 *
 * Mirrors `favourites.ts`: one source of truth for the shape, the defaults, and
 * change notifications, so all four isolated worlds (service worker / host
 * overlay / picker / tenor frame) agree. Each context reads on boot and
 * subscribes via `watchSettings`, so a toggle flipped in the picker propagates
 * live to the host and tenor frames through `chrome.storage.onChanged`.
 */

import { STORAGE_KEYS } from './constants.js';

export interface Settings {
  /**
   * When true (default), Cmd/Ctrl+G toggles the picker on Discord and suppresses
   * Discord's native GIF picker. When false, Cmd/Ctrl+G is left to Discord and
   * the browser, and only Cmd/Ctrl+Alt+/ opens the picker there.
   */
  cmdGDiscord: boolean;
}

export const DEFAULT_SETTINGS: Settings = { cmdGDiscord: true };

function normalise(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
  const record = raw as Record<string, unknown>;
  return {
    cmdGDiscord:
      typeof record['cmdGDiscord'] === 'boolean'
        ? record['cmdGDiscord']
        : DEFAULT_SETTINGS.cmdGDiscord,
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    return normalise(stored[STORAGE_KEYS.settings]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  try {
    const current = await loadSettings();
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...current, ...patch } });
  } catch {
    /* best-effort; a failed write must never break the picker */
  }
}

/** Subscribe to changes from any context. Returns an unsubscribe function. */
export function watchSettings(onChange: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    const change = changes[STORAGE_KEYS.settings];
    if (change) onChange(normalise(change.newValue));
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
