/**
 * Picker frame — our chrome, our pixels.
 *
 * Owns the search box, the state machine, the favourites panel and the
 * copy-feedback loop. Search navigates by setting the tenor iframe's `src`; the
 * load is masked by the skeleton plus the opacity gate, so the user never sees
 * an un-surgered tenor page.
 */

import {
  FRAME_SLOW_MS,
  FRAME_VERY_SLOW_MS,
  MAX_RECENTS,
  PICKER_PORT,
  STORAGE_KEYS,
  SUGGESTED_QUERIES,
  TENOR_ORIGIN,
  TILE_FEEDBACK_MS,
  TOAST_ERROR_MS,
  TOAST_MS,
} from '../shared/constants.js';
import { copyText } from '../shared/clipboard.js';
import {
  clearFavourites,
  loadFavourites,
  removeFavourite,
  watchFavourites,
  type Favourite,
} from '../shared/favourites.js';
import {
  assertNever,
  isSwToPickerMessage,
  nextRequestId,
  type FrameMessage,
  type HealthReport,
  type PickerMessage,
  type SwToPickerMessage,
} from '../shared/messages.js';
import { buildSearchUrl } from '../shared/urls.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`[tenor-gif-picker] missing element #${id}`);
  return found as T;
}

const frame = el<HTMLIFrameElement>('frame');
const queryInput = el<HTMLInputElement>('query');
const spinner = el<HTMLSpanElement>('spinner');
const clearBtn = el<HTMLButtonElement>('clear');
const favsToggle = el<HTMLButtonElement>('favs-toggle');
const closeBtn = el<HTMLButtonElement>('close');
const progress = el<HTMLDivElement>('progress');
const recentsBlock = el<HTMLDivElement>('recents-block');
const recentsWrap = el<HTMLDivElement>('recents');
const clearRecentsBtn = el<HTMLButtonElement>('clear-recents');
const suggestionsWrap = el<HTMLDivElement>('suggestions');
const skeleton = el<HTMLDivElement>('skeleton');
const slowHint = el<HTMLParagraphElement>('slow-hint');
const loadingLabel = el<HTMLSpanElement>('loading-label');
const favsGrid = el<HTMLDivElement>('favs-grid');
const favsEmpty = el<HTMLDivElement>('favs-empty');
const clearFavsBtn = el<HTMLButtonElement>('clear-favs');
const emptyBody = el<HTMLParagraphElement>('empty-body');
const emptyChips = el<HTMLDivElement>('empty-chips');
const errorBody = el<HTMLParagraphElement>('error-body');
const openTabBtn = el<HTMLButtonElement>('open-tab');
const retryBtn = el<HTMLButtonElement>('retry');
const retryOfflineBtn = el<HTMLButtonElement>('retry-offline');
const notice = el<HTMLDivElement>('notice');
const noticeText = el<HTMLSpanElement>('notice-text');
const noticeDismiss = el<HTMLButtonElement>('notice-dismiss');
const manual = el<HTMLDivElement>('manual');
const manualUrl = el<HTMLInputElement>('manual-url');
const toast = el<HTMLDivElement>('toast');

const panes = {
  idle: el<HTMLElement>('pane-idle'),
  loading: el<HTMLElement>('pane-loading'),
  favs: el<HTMLElement>('pane-favs'),
  empty: el<HTMLElement>('pane-empty'),
  error: el<HTMLElement>('pane-error'),
  offline: el<HTMLElement>('pane-offline'),
};

type View = 'idle' | 'loading' | 'ready' | 'favs' | 'empty' | 'error' | 'offline';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const rawTabId = Number.parseInt(new URLSearchParams(location.search).get('tabId') ?? '', 10);
const tabId = Number.isInteger(rawTabId) ? rawTabId : -1;

let port: chrome.runtime.Port | null = null;
let reconnectAttempts = 0;
let currentQuery = '';
let deliverMode: 'copy' | 'send' = 'copy';
let view: View = 'idle';
/** The view to return to when leaving the favourites panel. */
let viewBeforeFavs: View = 'idle';
let recents: string[] = [];
let favourites: Favourite[] = [];

let slowTimer: number | null = null;
let blockedTimer: number | null = null;
let toastTimer: number | null = null;

const pendingRequests = new Map<string, (message: SwToPickerMessage) => void>();

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

function connect(): void {
  try {
    port = chrome.runtime.connect({ name: PICKER_PORT });
  } catch {
    port = null;
    return;
  }

  send({ type: 'picker:hello', tabId });

  port.onMessage.addListener((raw: unknown) => {
    if (!isSwToPickerMessage(raw)) return;
    handleSwMessage(raw);
  });

  port.onDisconnect.addListener(() => {
    port = null;
    // The service worker can be torn down mid-session. Reconnecting is what
    // keeps `ensureArmed()` able to re-arm the DNR rule before the next search.
    if (reconnectAttempts < 5) {
      reconnectAttempts += 1;
      window.setTimeout(connect, 150 * reconnectAttempts);
    }
  });

  reconnectAttempts = 0;
}

function send(message: PickerMessage): void {
  try {
    port?.postMessage(message);
  } catch {
    /* reconnect logic will pick this up */
  }
}

/** Round-trip request with a timeout, keyed by request id. */
function request(
  message: Extract<PickerMessage, { requestId: string }>,
  match: SwToPickerMessage['type'],
  timeoutMs = 4000,
): Promise<SwToPickerMessage | null> {
  return new Promise((resolve) => {
    if (!port) {
      resolve(null);
      return;
    }
    const timer = window.setTimeout(() => {
      pendingRequests.delete(message.requestId);
      resolve(null);
    }, timeoutMs);

    pendingRequests.set(message.requestId, (reply) => {
      if (reply.type !== match) return;
      window.clearTimeout(timer);
      pendingRequests.delete(message.requestId);
      resolve(reply);
    });

    send(message);
  });
}

/**
 * Arm the XFO strip and WAIT for the ack before navigating.
 *
 * Called before every navigation, not just the first: if `src` is set before the
 * rule exists the navigation races it and the frame is blocked with no obvious
 * cause. Re-arming is idempotent on the service worker side.
 */
async function ensureArmed(): Promise<boolean> {
  if (!port) connect();
  // Retry once: on a cold service worker the first round trip can lose the race
  // while the worker spins up, which was a source of the "retry a few times and
  // it works" reports.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await request(
      { type: 'picker:arm', requestId: nextRequestId('arm') },
      'sw:armed',
    );
    if (reply?.type === 'sw:armed' && reply.ok) return true;
    if (!port) connect();
    await new Promise((resolve) => window.setTimeout(resolve, 180));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function setBusy(busy: boolean, label = 'Searching'): void {
  progress.hidden = !busy;
  spinner.hidden = !busy;
  loadingLabel.textContent = label;
}

function setView(next: View): void {
  view = next;
  const framed = next === 'ready';
  frame.classList.toggle('is-visible', framed);
  for (const [name, node] of Object.entries(panes)) {
    node.hidden = name !== next;
  }
  if (next !== 'loading') slowHint.hidden = true;
  setBusy(next === 'loading');
  favsToggle.setAttribute('aria-pressed', next === 'favs' ? 'true' : 'false');
  favsToggle.setAttribute('aria-label', next === 'favs' ? 'Back to search' : 'Show favourites');
}

function clearTimers(): void {
  if (slowTimer !== null) window.clearTimeout(slowTimer);
  if (blockedTimer !== null) window.clearTimeout(blockedTimer);
  slowTimer = null;
  blockedTimer = null;
}

function startLoadWatchdogs(): void {
  clearTimers();
  slowTimer = window.setTimeout(() => {
    slowHint.hidden = false;
  }, FRAME_SLOW_MS);
  // A frame blocked by X-Frame-Options does not reliably fire a catchable
  // error, and a cross-origin frame is opaque whether it succeeded or failed —
  // `contentDocument` is null and reading location throws in BOTH cases. So the
  // only reliable detector is the ABSENCE of our own in-frame handshake.
  blockedTimer = window.setTimeout(() => {
    showBlocked("This page's security policy may be blocking the picker, or Tenor is unreachable.");
  }, FRAME_VERY_SLOW_MS);
}

function showBlocked(reason: string): void {
  clearTimers();
  errorBody.textContent = reason;
  setView('error');
}

function showNotice(text: string): void {
  noticeText.textContent = text;
  notice.hidden = false;
}

function showToast(text: string, kind: 'ok' | 'error' = 'ok'): void {
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toast.textContent = text;
  toast.classList.toggle('is-error', kind === 'error');
  toast.hidden = false;
  // Force a reflow so the entry transition runs on repeat copies.
  void toast.offsetWidth;
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(
    () => {
      toast.classList.remove('is-visible');
      toastTimer = window.setTimeout(() => {
        toast.hidden = true;
      }, 200);
    },
    kind === 'error' ? TOAST_ERROR_MS : TOAST_MS,
  );
}

function showManualCopy(url: string): void {
  manualUrl.value = url;
  manual.hidden = false;
  manualUrl.focus();
  manualUrl.select();
}

function hideManualCopy(): void {
  manual.hidden = true;
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

const SKELETON_HEIGHTS = [
  [150, 210, 130, 190, 160],
  [190, 140, 200, 150, 180],
];

function buildSkeleton(): void {
  skeleton.replaceChildren();
  for (const column of SKELETON_HEIGHTS) {
    const col = document.createElement('div');
    col.className = 'skeleton__col';
    for (const height of column) {
      const tile = document.createElement('div');
      tile.className = 'skeleton__tile';
      tile.style.height = `${height}px`;
      col.appendChild(tile);
    }
    skeleton.appendChild(col);
  }
}

// ---------------------------------------------------------------------------
// Recents
// ---------------------------------------------------------------------------

async function loadRecents(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.recents);
    const value: unknown = stored[STORAGE_KEYS.recents];
    if (Array.isArray(value)) {
      recents = value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, MAX_RECENTS);
    }
  } catch {
    recents = [];
  }
  renderIdle();
}

function pushRecent(query: string): void {
  const normalised = query.trim();
  if (!normalised) return;
  recents = [normalised, ...recents.filter((item) => item !== normalised)].slice(0, MAX_RECENTS);
  void chrome.storage.local.set({ [STORAGE_KEYS.recents]: recents }).catch(() => undefined);
  renderIdle();
}

function chip(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function renderIdle(): void {
  recentsWrap.replaceChildren();
  for (const item of recents) {
    recentsWrap.appendChild(chip(item, () => void search(item)));
  }
  recentsBlock.hidden = recents.length === 0;

  if (suggestionsWrap.childElementCount === 0) {
    for (const item of SUGGESTED_QUERIES) {
      suggestionsWrap.appendChild(chip(item, () => void search(item)));
    }
  }
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

function renderFavourites(): void {
  favsGrid.replaceChildren();

  for (const favourite of favourites) {
    const tile = document.createElement('div');
    tile.className = 'fav';
    tile.dataset['label'] = 'Click to copy link';

    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'fav__hit';
    hit.setAttribute('aria-label', favourite.alt ?? 'Use this GIF');

    const image = document.createElement('img');
    image.src = favourite.thumb ?? '';
    image.alt = favourite.alt ?? '';
    image.loading = 'lazy';
    // A saved thumbnail can 404 later; fall back to a labelled placeholder
    // rather than a broken-image icon.
    image.addEventListener('error', () => {
      image.remove();
      hit.textContent = favourite.url.replace(`${TENOR_ORIGIN}/view/`, '');
      hit.style.padding = '18px 10px';
      hit.style.lineHeight = '1.3';
      hit.style.fontSize = '11px';
      hit.style.color = 'var(--muted)';
      hit.style.wordBreak = 'break-word';
    });

    hit.appendChild(image);
    hit.addEventListener('click', () => void useGif(favourite.url, tile));

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'fav__star';
    star.setAttribute('aria-label', 'Remove from favourites');
    star.title = 'Remove from favourites';
    star.addEventListener('click', (event) => {
      // Never let un-favouriting also use the GIF.
      event.preventDefault();
      event.stopPropagation();
      void removeFavourite(favourite.url);
    });

    tile.appendChild(hit);
    tile.appendChild(star);
    favsGrid.appendChild(tile);
  }

  favsEmpty.hidden = favourites.length > 0;
  clearFavsBtn.hidden = favourites.length === 0;
}

function toggleFavouritesView(): void {
  if (view === 'favs') {
    setView(viewBeforeFavs === 'favs' ? 'idle' : viewBeforeFavs);
    return;
  }
  viewBeforeFavs = view;
  renderFavourites();
  setView('favs');
}

// ---------------------------------------------------------------------------
// Using a GIF from our own panel
// ---------------------------------------------------------------------------

async function useGif(url: string, tile?: HTMLElement): Promise<void> {
  const result = await copyText(url);

  if (result.ok) {
    manualUrl.value = url;
    showToast(deliverMode === 'send' ? 'Sent' : 'Copied');
    if (tile) {
      tile.classList.add('is-copied');
      window.setTimeout(() => tile.classList.remove('is-copied'), TILE_FEEDBACK_MS);
    }
  } else {
    await handleCopyFailure(url);
  }

  // Tells the host page. On Discord this inserts the link into the composer and
  // sends it; everywhere else the clipboard is the delivery mechanism and this
  // is a no-op.
  send({ type: 'picker:deliver', url });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Monotonic navigation id. Every search bumps it; the frame's readiness reports
 * are matched against `navId` rather than against the human query string, so a
 * slug tenor canonicalises (e.g. "cats" -> "cat") can never be mistaken for a
 * stale report and dropped — which used to strand the picker in "loading".
 */
let navId = 0;
let navRetried = false;
let retryTimer: number | null = null;

async function search(rawQuery: string, options: { remember?: boolean } = {}): Promise<void> {
  const query = rawQuery.trim();
  const url = buildSearchUrl(query);
  if (!url) return;

  currentQuery = query;
  queryInput.value = query;
  updateClearButton();
  hideManualCopy();

  if (!navigator.onLine) {
    setView('offline');
    return;
  }

  navId += 1;
  navRetried = false;
  setView('loading');
  startLoadWatchdogs();

  const armed = await ensureArmed();
  if (!armed) {
    showBlocked('The picker could not prepare this tab. Try reopening it.');
    return;
  }

  navigateFrame(url);
  if (options.remember !== false) pushRecent(query);
}

/**
 * Point the frame at a URL and schedule a single automatic reload if the
 * in-frame handshake never lands — covering a cold-worker race where the header
 * strip is armed a beat too late and the first load comes back blocked.
 */
function navigateFrame(url: string): void {
  const mine = navId;
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  frame.src = url;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (mine === navId && !navRetried && view === 'loading') {
      navRetried = true;
      frame.src = url;
    }
  }, FRAME_SLOW_MS);
}

function updateClearButton(): void {
  clearBtn.hidden = queryInput.value.length === 0;
}

// ---------------------------------------------------------------------------
// Messages from the service worker
// ---------------------------------------------------------------------------

function handleSwMessage(message: SwToPickerMessage): void {
  if ('requestId' in message) {
    const resolver = pendingRequests.get(message.requestId);
    if (resolver) {
      resolver(message);
      return;
    }
  }
  if (message.type === 'sw:frame-event') handleFrameEvent(message.event);
}

function applyHealth(health: HealthReport): void {
  if (health.status === 'degraded') {
    // The in-frame script has already ripped out its own stylesheet, so the
    // picker still works — it just looks like plain tenor. Say so rather than
    // letting the user wonder whether the product is broken.
    showNotice("Tenor's layout changed — the picker may look off.");
  }
  void chrome.storage.local
    .set({ [STORAGE_KEYS.health]: { ...health, at: new Date().toISOString() } })
    .catch(() => undefined);
}

/**
 * Reveal the frame only when results genuinely have layout. Revealing on a mere
 * node count would un-hide an unpainted frame — the "black page". If the frame
 * is not showing search results, keep the skeleton up.
 */
function reveal(health: HealthReport): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  clearTimers();
  if (health.visibleResults > 0 || health.resultCount > 0) {
    setView('ready');
  }
}

function handleFrameEvent(event: FrameMessage): void {
  switch (event.type) {
    case 'frame:ready': {
      applyHealth(event.health);
      // Keep our own box in sync with the slug tenor actually landed on.
      if (event.query) {
        currentQuery = event.query;
        queryInput.value = event.query;
        updateClearButton();
      }
      if (event.health.resultCount === 0 && event.health.visibleResults === 0) {
        emptyBody.textContent = currentQuery
          ? `Nothing matched "${currentQuery}".`
          : 'Try a different search.';
        renderEmptySuggestions();
        clearTimers();
        setView('empty');
      } else {
        reveal(event.health);
      }
      return;
    }
    case 'frame:health':
      applyHealth(event.health);
      // Results can arrive after we concluded there were none — tenor re-renders
      // its grid on client-side routes and on infinite scroll. Rescue only once
      // they actually have layout, so we never reveal an unpainted frame.
      if (event.health.visibleResults > 0 && (view === 'empty' || view === 'loading')) {
        reveal(event.health);
      }
      return;
    case 'frame:copy-pending':
      return;
    case 'frame:copied':
      manualUrl.value = event.url;
      showToast(deliverMode === 'send' ? 'Sent' : 'Copied');
      return;
    case 'frame:copy-failed':
      void handleCopyFailure(event.url);
      return;
    case 'frame:search-chip':
      void search(event.query);
      return;
    case 'frame:dismiss':
      close();
      return;
    case 'frame:focus-back':
      queryInput.focus();
      queryInput.select();
      return;
    case 'frame:open-external':
      return; // handled by the service worker
    default:
      assertNever(event, 'frame event');
  }
}

/** Tier 3 then tier 4 of the clipboard ladder. Never fake a checkmark. */
async function handleCopyFailure(url: string): Promise<void> {
  const reply = await request(
    { type: 'picker:copy-offscreen', url, requestId: nextRequestId('copy') },
    'sw:copy-offscreen-result',
  );
  if (reply?.type === 'sw:copy-offscreen-result' && reply.ok) {
    manualUrl.value = url;
    showToast(deliverMode === 'send' ? 'Sent' : 'Copied');
    return;
  }
  showToast("Couldn't copy — press ⌘/Ctrl + C", 'error');
  showManualCopy(url);
}

function renderEmptySuggestions(): void {
  emptyChips.replaceChildren();
  for (const item of SUGGESTED_QUERIES.slice(0, 4)) {
    emptyChips.appendChild(chip(item, () => void search(item)));
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function close(): void {
  send({ type: 'picker:close' });
}

function openInTab(): void {
  const url = currentQuery ? (buildSearchUrl(currentQuery) ?? TENOR_ORIGIN) : TENOR_ORIGIN;
  send({ type: 'picker:open-external', url });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

queryInput.addEventListener('input', updateClearButton);

queryInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void search(queryInput.value);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (queryInput.value) {
      queryInput.value = '';
      updateClearButton();
    } else {
      close();
    }
  }
});

clearBtn.addEventListener('click', () => {
  queryInput.value = '';
  updateClearButton();
  queryInput.focus();
  currentQuery = '';
  hideManualCopy();
  setView('idle');
});

favsToggle.addEventListener('click', toggleFavouritesView);
closeBtn.addEventListener('click', close);
openTabBtn.addEventListener('click', openInTab);
retryBtn.addEventListener('click', () => void search(currentQuery || 'gif', { remember: false }));
retryOfflineBtn.addEventListener(
  'click',
  () => void search(currentQuery || 'gif', { remember: false }),
);

clearRecentsBtn.addEventListener('click', () => {
  recents = [];
  void chrome.storage.local.set({ [STORAGE_KEYS.recents]: [] }).catch(() => undefined);
  renderIdle();
});

clearFavsBtn.addEventListener('click', () => void clearFavourites());

noticeDismiss.addEventListener('click', () => {
  notice.hidden = true;
});

manualUrl.addEventListener('focus', () => manualUrl.select());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.activeElement !== queryInput) {
    event.preventDefault();
    close();
  }
});

window.addEventListener('online', () => {
  if (view === 'offline') void search(currentQuery || 'gif', { remember: false });
});

window.addEventListener('offline', () => {
  if (view === 'ready' || view === 'favs') return;
  setView('offline');
});

// bfcache / frame restore: the port will have died, so re-establish it.
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !port) {
    reconnectAttempts = 0;
    connect();
  }
});

watchFavourites((list) => {
  favourites = list;
  if (view === 'favs') renderFavourites();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void chrome.storage.local
  .get(STORAGE_KEYS.deliver)
  .then((stored) => {
    if (stored[STORAGE_KEYS.deliver] === 'send') deliverMode = 'send';
  })
  .catch(() => undefined);

buildSkeleton();
renderIdle();
connect();
void loadRecents();
void loadFavourites().then((list) => {
  favourites = list;
  if (view === 'favs') renderFavourites();
});
setView('idle');
queryInput.focus();
