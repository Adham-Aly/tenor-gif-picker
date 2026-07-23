/**
 * Every message that crosses an isolation boundary.
 *
 * This project's genuine risk surface is message passing across four worlds
 * (service worker / host-page content script / picker frame / tenor frame),
 * which is the specific reason the codebase is TypeScript at all. Discriminated
 * unions plus the exhaustiveness helper below turn "I forgot to handle that
 * case" from a silent runtime no-op into a compile error.
 *
 * SECURITY: all of this rides `chrome.runtime` messaging, never
 * `window.postMessage`. The tenor frame's content script and the picker frame
 * are different frames of the same extension; if they talked over postMessage,
 * the receiver would see `event.origin === 'https://tenor.com'` — which is
 * *also* the origin of tenor's own page scripts running in the main world of
 * that very frame. Origin checking cannot close that gap because the origins
 * are identical, so any script on the page could forge a "user picked this GIF"
 * message and have an attacker-chosen string written to the clipboard. With
 * `chrome.runtime`, sender identity is asserted by the browser
 * (`sender.id` / `sender.origin` / `sender.frameId`) and page scripts cannot
 * reach the API at all.
 */

/** Which rung of the clipboard ladder actually performed the write. */
export type CopyTier = 'writeText' | 'execCommand' | 'offscreen' | 'manual';

/** Result of the in-frame health assertions (see implementation-plan.md §7.6). */
export interface HealthReport {
  /** H1: number of `a[href^="/view/"]` anchors present. */
  resultCount: number;
  /** H2: how many of those actually have a non-zero client rect. */
  visibleResults: number;
  /** H3: direct children of `.BaseApp` — expected 7. */
  baseAppChildren: number;
  /** H4: rendered masonry column count — expected 2 at our width. */
  columns: number;
  /** Observed tenor build, parsed from their asset URL, for bug reports. */
  release: string | null;
  status: HealthStatus;
}

export type HealthStatus =
  | 'ok'
  /** H1 failed: tenor genuinely returned nothing. Not a surgery failure. */
  | 'empty'
  /** H2 failed: results exist but WE hid them. Stylesheet has been ripped out. */
  | 'degraded'
  /** H3 failed: their structure moved. CSS kept, but flag it. */
  | 'structure-drift';

// ---------------------------------------------------------------------------
// tenor frame -> service worker
// ---------------------------------------------------------------------------

export type FrameMessage =
  | { type: 'frame:ready'; health: HealthReport; query: string | null }
  | { type: 'frame:health'; health: HealthReport }
  | { type: 'frame:copy-pending'; url: string }
  | { type: 'frame:copied'; url: string; tier: CopyTier }
  | { type: 'frame:copy-failed'; url: string }
  | { type: 'frame:search-chip'; query: string }
  | { type: 'frame:dismiss' }
  | { type: 'frame:focus-back' }
  | { type: 'frame:open-external'; url: string };

// ---------------------------------------------------------------------------
// host-page overlay <-> service worker
// ---------------------------------------------------------------------------

export type SwToHostMessage = { type: 'sw:toggle'; tabId: number } | { type: 'sw:close' };

export type HostMessage = { type: 'host:closed' };

// ---------------------------------------------------------------------------
// picker frame <-> service worker (long-lived port)
// ---------------------------------------------------------------------------

export type PickerMessage =
  | { type: 'picker:hello'; tabId: number }
  /**
   * Arm the DNR rule and wait for the ack BEFORE navigating the tenor iframe.
   * Ordering is load-bearing: if `src` is set before the rule exists, the
   * navigation races it and you get a blocked frame with no obvious cause.
   * Called before EVERY navigation, not just the first — the service worker
   * can be torn down mid-session, and re-arming is idempotent.
   */
  | { type: 'picker:arm'; requestId: string }
  | { type: 'picker:close' }
  | { type: 'picker:copy-offscreen'; url: string; requestId: string }
  | { type: 'picker:open-external'; url: string };

export type SwToPickerMessage =
  | { type: 'sw:armed'; requestId: string; ok: boolean }
  | { type: 'sw:copy-offscreen-result'; requestId: string; ok: boolean }
  | { type: 'sw:frame-event'; event: FrameMessage };

// ---------------------------------------------------------------------------
// service worker <-> offscreen document
// ---------------------------------------------------------------------------

export type OffscreenMessage = { type: 'offscreen:copy'; target: 'offscreen'; text: string };
export type OffscreenReply = { ok: boolean };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasStringType(value: unknown): value is { type: string } {
  return isRecord(value) && typeof value['type'] === 'string';
}

const FRAME_TYPES = new Set<FrameMessage['type']>([
  'frame:ready',
  'frame:health',
  'frame:copy-pending',
  'frame:copied',
  'frame:copy-failed',
  'frame:search-chip',
  'frame:dismiss',
  'frame:focus-back',
  'frame:open-external',
]);

export function isFrameMessage(value: unknown): value is FrameMessage {
  return hasStringType(value) && FRAME_TYPES.has(value.type as FrameMessage['type']);
}

const SW_TO_HOST_TYPES = new Set<SwToHostMessage['type']>(['sw:toggle', 'sw:close']);

export function isSwToHostMessage(value: unknown): value is SwToHostMessage {
  return hasStringType(value) && SW_TO_HOST_TYPES.has(value.type as SwToHostMessage['type']);
}

const PICKER_TYPES = new Set<PickerMessage['type']>([
  'picker:hello',
  'picker:arm',
  'picker:close',
  'picker:copy-offscreen',
  'picker:open-external',
]);

export function isPickerMessage(value: unknown): value is PickerMessage {
  return hasStringType(value) && PICKER_TYPES.has(value.type as PickerMessage['type']);
}

const SW_TO_PICKER_TYPES = new Set<SwToPickerMessage['type']>([
  'sw:armed',
  'sw:copy-offscreen-result',
  'sw:frame-event',
]);

export function isSwToPickerMessage(value: unknown): value is SwToPickerMessage {
  return hasStringType(value) && SW_TO_PICKER_TYPES.has(value.type as SwToPickerMessage['type']);
}

export function isOffscreenMessage(value: unknown): value is OffscreenMessage {
  if (!isRecord(value)) return false;
  return (
    value['type'] === 'offscreen:copy' &&
    value['target'] === 'offscreen' &&
    typeof value['text'] === 'string'
  );
}

/**
 * Compile-time exhaustiveness guard. Placing this in a switch's `default`
 * makes an unhandled union member a type error rather than silence.
 */
export function assertNever(value: never, context: string): void {
  console.warn(`[tenor-gif-picker] unhandled ${context}:`, value);
}

let requestCounter = 0;
export function nextRequestId(prefix = 'r'): string {
  requestCounter += 1;
  return `${prefix}${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}
