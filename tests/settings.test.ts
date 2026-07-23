import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../src/shared/constants.js';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  updateSettings,
  watchSettings,
} from '../src/shared/settings.js';

type ChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void;

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

let store: { data: Record<string, unknown> };

beforeEach(() => {
  store = installFakeStorage();
});

describe('loadSettings', () => {
  it('defaults cmdGDiscord to true when nothing is stored (fresh install = ON)', async () => {
    expect(await loadSettings()).toEqual({ cmdGDiscord: true });
    expect(DEFAULT_SETTINGS.cmdGDiscord).toBe(true);
  });

  it('reads a stored value', async () => {
    store.data[STORAGE_KEYS.settings] = { cmdGDiscord: false };
    expect(await loadSettings()).toEqual({ cmdGDiscord: false });
  });

  it('normalises malformed storage to the default rather than throwing', async () => {
    for (const junk of ['nope', 42, null, [], { cmdGDiscord: 'yes' }, {}]) {
      store.data[STORAGE_KEYS.settings] = junk;
      expect((await loadSettings()).cmdGDiscord).toBe(true);
    }
  });
});

describe('updateSettings', () => {
  it('persists a change and round-trips', async () => {
    await updateSettings({ cmdGDiscord: false });
    expect(await loadSettings()).toEqual({ cmdGDiscord: false });
    await updateSettings({ cmdGDiscord: true });
    expect(await loadSettings()).toEqual({ cmdGDiscord: true });
  });
});

describe('watchSettings', () => {
  it('notifies other contexts when the setting changes, and unsubscribes', async () => {
    const seen = vi.fn();
    const stop = watchSettings(seen);

    await updateSettings({ cmdGDiscord: false });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0]).toEqual({ cmdGDiscord: false });

    stop();
    await updateSettings({ cmdGDiscord: true });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('ignores changes to unrelated keys', async () => {
    const seen = vi.fn();
    watchSettings(seen);
    await chrome.storage.local.set({ [STORAGE_KEYS.recents]: ['cat'] });
    expect(seen).not.toHaveBeenCalled();
  });
});
