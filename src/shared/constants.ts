/**
 * Shared constants. Anything that appears in more than one isolated context
 * (service worker / host page / picker frame / tenor frame / offscreen) lives
 * here so the four worlds cannot drift apart.
 */

export const TENOR_ORIGIN = 'https://tenor.com';

/**
 * Attribute set on <html> inside the tenor iframe, by `tenor-frame.ts`, only
 * once the self-arming guard has confirmed we are inside OUR picker.
 *
 * Every rule in `tenor-frame.css` is scoped under `html[data-tenor-picker]`.
 * This is load-bearing: the stylesheet is declared in the manifest so it lands
 * before first paint, which means it is also delivered when the user browses
 * tenor.com normally. Without this scoping we would restyle the real website.
 *
 * It doubles as the self-heal switch — removing the attribute instantly
 * disables all of our cosmetic surgery (see health check H2).
 */
export const FRAME_ATTR = 'data-tenor-picker';

/** Marker class applied to a result tile while showing copy feedback. */
export const TILE_COPIED_CLASS = 'tgp-copied';
export const TILE_FAILED_CLASS = 'tgp-failed';
export const TILE_BUSY_CLASS = 'tgp-busy';

/** Long-lived port name: picker frame <-> service worker. */
export const PICKER_PORT = 'tenor-gif-picker';

/** Guard flag on the host page's isolated world, so re-injection is idempotent. */
export const HOST_INSTALLED_FLAG = '__tenorGifPickerInstalled__';

/** Element id of the shadow host we attach to documentElement. */
export const HOST_ELEMENT_ID = 'tenor-gif-picker-root';

// ---------------------------------------------------------------------------
// Geometry (see implementation-plan.md §6 — derived from tenor's own masonry
// breakpoints, not guessed: their column count is `>1100 ? 4 : >576 ? 3 : 2`,
// so a content width under 576 gives us the native 2-column Discord layout.)
// ---------------------------------------------------------------------------

export const DEFAULT_WIDTH = 400;
export const DEFAULT_HEIGHT = 540;
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 320;
export const MAX_WIDTH = 900;
export const MAX_HEIGHT = 900;
export const EDGE_OFFSET = 20;
export const VIEWPORT_MARGIN = 24;

/** Below this viewport width the picker goes near-fullscreen with tighter insets. */
export const SMALL_VIEWPORT = 480;
export const SMALL_VIEWPORT_INSET = 12;

/** tenor switches to 3 columns above this content width. */
export const TENOR_THREE_COLUMN_THRESHOLD = 576;

// ---------------------------------------------------------------------------
// Timings (ms)
// ---------------------------------------------------------------------------

export const OPEN_ANIM_MS = 140;
export const CLOSE_ANIM_MS = 100;
export const REDUCED_MOTION_MS = 100;

/** No `frame:ready` within this window => the frame is blocked/broken. */
export const FRAME_READY_TIMEOUT_MS = 3000;
export const FRAME_SLOW_MS = 3000;
export const FRAME_VERY_SLOW_MS = 8000;

/** If the clipboard write has not resolved by this point, show a spinner. */
export const COPY_PENDING_MS = 250;
export const TILE_FEEDBACK_MS = 900;
export const TILE_FEEDBACK_FADE_MS = 200;
export const TOAST_MS = 1400;
export const TOAST_ERROR_MS = 4000;

export const STORAGE_KEYS = {
  size: 'picker.size',
  recents: 'picker.recents',
  health: 'picker.lastHealth',
  settings: 'picker.settings',
} as const;

export const MAX_RECENTS = 8;

/** Suggestion chips shown on the idle surface before the first search. */
export const SUGGESTED_QUERIES = [
  'thank you',
  'lol',
  'nice',
  'good morning',
  'congrats',
  'facepalm',
  'shrug',
  'happy dance',
] as const;
