/**
 * Runs inside the tenor.com document, at document_start, in every frame.
 *
 * This is where the product's actual stipulation happens: a click on a result
 * becomes a clipboard write instead of a navigation. It also injects the
 * favourite stars and reports readiness/health back to the picker.
 */

import {
  COPY_PENDING_MS,
  FRAME_ATTR,
  RESULT_POLL_INTERVAL_MS,
  RESULT_POLL_TIMEOUT_MS,
  STAR_CLASS,
  STAR_ON_CLASS,
  STORAGE_KEYS,
  TILE_BUSY_CLASS,
  TILE_COPIED_CLASS,
  TILE_FAILED_CLASS,
  TILE_FEEDBACK_MS,
} from '../shared/constants.js';
import { copyText } from '../shared/clipboard.js';
import { decideClickAction } from '../shared/click-action.js';
import { loadFavourites, toggleFavourite, watchFavourites } from '../shared/favourites.js';
import { loadSettings, watchSettings } from '../shared/settings.js';
import {
  assertNever,
  type FrameMessage,
  type HealthReport,
  type HealthStatus,
} from '../shared/messages.js';
import { canonicalViewUrl, parseSearchSlug, safeUrl } from '../shared/urls.js';

const TILE_SELECTOR = '.UniversalGifListItem';
const RESULT_SELECTOR = 'a[href^="/view/"]';

// ---------------------------------------------------------------------------
// Self-arming guard — MUST be the first thing that happens.
//
// This script matches *://tenor.com/*, so it ALSO runs when the user browses
// tenor.com normally. Without this guard, installing the extension silently
// breaks the real website: every GIF click there would copy instead of
// navigate. That is a regression on a site the user never asked us to touch.
// ---------------------------------------------------------------------------

function extensionOrigin(): string | null {
  try {
    return new URL(chrome.runtime.getURL('')).origin;
  } catch {
    return null;
  }
}

function isPickerFrame(): boolean {
  if (window.top === window.self) return false;

  const ancestors = location.ancestorOrigins;
  if (!ancestors || ancestors.length === 0) return false;

  const immediateParent = ancestors.item(0);
  if (!immediateParent) return false;

  // A web page cannot create a chrome-extension:// parent frame, so this cannot
  // be spoofed by a hostile site — and we additionally require that it be OUR
  // extension rather than merely some extension.
  const ours = extensionOrigin();
  return ours !== null && immediateParent === ours;
}

/**
 * Scope the manifest-declared stylesheet to this frame.
 *
 * `tenor-frame.css` is declared in the manifest so it lands before first paint
 * (an `insertCSS` later produces a visible flash of un-surgered tenor), but that
 * also means it is delivered on normal tenor.com browsing. Every rule in it is
 * gated on `html[data-tenor-picker]`, so it does nothing until this attribute
 * appears — and removing the attribute is how health check H2 self-heals.
 */
function markFrame(): boolean {
  const root = document.documentElement;
  if (!root) return false;
  root.setAttribute(FRAME_ATTR, '');
  return true;
}

function markFrameWhenReady(): void {
  if (markFrame()) return;
  const observer = new MutationObserver(() => {
    if (markFrame()) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function send(message: FrameMessage): void {
  try {
    const result: unknown = chrome.runtime.sendMessage(message);
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    /* the service worker may be mid-restart; nothing actionable here */
  }
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

let favouriteUrls = new Set<string>();
let cmdGEnabled = true;

function tileUrl(tile: Element): string | null {
  const anchor = tile.querySelector<HTMLAnchorElement>(RESULT_SELECTOR);
  if (!anchor) return null;
  return canonicalViewUrl(anchor.getAttribute('href') ?? '', location.href);
}

function tileThumb(tile: Element): string | null {
  const img = tile.querySelector('img');
  // getAttribute('src') rather than currentSrc: tenor's <picture> can resolve
  // to an .mp4 source, which would not render in the favourites panel's <img>.
  const raw = img?.getAttribute('src');
  return raw ? (safeUrl(raw, location.href)?.href ?? null) : null;
}

function syncStarState(star: HTMLElement, url: string): void {
  const on = favouriteUrls.has(url);
  star.classList.toggle(STAR_ON_CLASS, on);
  star.setAttribute('aria-pressed', on ? 'true' : 'false');
  star.setAttribute('aria-label', on ? 'Remove from favourites' : 'Add to favourites');
  star.title = on ? 'Remove from favourites' : 'Add to favourites';
}

function syncAllStars(): void {
  for (const star of document.querySelectorAll<HTMLElement>(`.${STAR_CLASS}`)) {
    const url = star.dataset['url'];
    if (url) syncStarState(star, url);
  }
}

/**
 * Inject a star into every result tile that lacks one.
 *
 * The button is appended to the <figure>, i.e. as a SIBLING of the tile's
 * anchor rather than inside it. That is what makes clicking the star incapable
 * of also triggering the GIF — the anchor is simply not on the event path.
 * Promoted/ad tiles get no star, because they have no /view/ link.
 */
function ensureStars(root: ParentNode = document): void {
  for (const tile of root.querySelectorAll<HTMLElement>(TILE_SELECTOR)) {
    if (tile.querySelector(`.${STAR_CLASS}`)) continue;
    const url = tileUrl(tile);
    if (!url) continue;

    const star = document.createElement('button');
    star.className = STAR_CLASS;
    star.type = 'button';
    star.dataset['url'] = url;
    star.setAttribute('tabindex', '-1');
    syncStarState(star, url);
    tile.appendChild(star);
  }
}

function starFromEvent(event: Event): HTMLElement | null {
  for (const node of event.composedPath()) {
    const element = node as HTMLElement | null;
    if (!element || element.nodeType !== 1) continue;
    if (element.classList?.contains(STAR_CLASS)) return element;
  }
  return null;
}

async function handleStarClick(star: HTMLElement): Promise<void> {
  const url = star.dataset['url'];
  if (!url) return;
  const tile = star.closest<HTMLElement>(TILE_SELECTOR);

  const on = await toggleFavourite({
    url,
    thumb: tile ? tileThumb(tile) : null,
    alt: tile?.querySelector('img')?.getAttribute('alt') ?? null,
    addedAt: Date.now(),
  });

  if (on) favouriteUrls.add(url);
  else favouriteUrls.delete(url);
  syncStarState(star, url);
  star.classList.remove('tgp-star--pop');
  void star.offsetWidth;
  star.classList.add('tgp-star--pop');
}

// ---------------------------------------------------------------------------
// Click interception
// ---------------------------------------------------------------------------

/** First <a> on the event's composed path, or null. */
function closestAnchor(event: Event): HTMLAnchorElement | null {
  for (const node of event.composedPath()) {
    const element = node as HTMLElement | null;
    if (!element || element.nodeType !== 1) continue;
    if (element.tagName === 'A') return element as HTMLAnchorElement;
  }
  return null;
}

function tileFor(anchor: HTMLElement): HTMLElement {
  return anchor.closest<HTMLElement>(TILE_SELECTOR) ?? anchor;
}

function markTile(tile: HTMLElement, className: string, duration: number): void {
  tile.classList.remove(TILE_COPIED_CLASS, TILE_FAILED_CLASS, TILE_BUSY_CLASS);
  tile.classList.add(className);
  window.setTimeout(() => tile.classList.remove(className), duration);
}

async function handleResultClick(url: string, anchor: HTMLAnchorElement): Promise<void> {
  const tile = tileFor(anchor);
  tile.classList.remove(TILE_COPIED_CLASS, TILE_FAILED_CLASS);

  // Never leave a dead gap where nothing appears to have happened.
  const spinnerTimer = window.setTimeout(
    () => tile.classList.add(TILE_BUSY_CLASS),
    COPY_PENDING_MS,
  );
  send({ type: 'frame:copy-pending', url });

  const result = await copyText(url);

  window.clearTimeout(spinnerTimer);
  tile.classList.remove(TILE_BUSY_CLASS);

  if (result.ok) {
    markTile(tile, TILE_COPIED_CLASS, TILE_FEEDBACK_MS);
    send({ type: 'frame:copied', url, tier: result.tier ?? 'execCommand' });
  } else {
    // The picker will try the offscreen tier and, failing that, offer manual
    // copy. Never fake a checkmark.
    markTile(tile, TILE_FAILED_CLASS, 4000);
    send({ type: 'frame:copy-failed', url });
  }
}

function onActivate(event: MouseEvent): void {
  // The star is checked first and swallows the event entirely, so favouriting
  // can never also copy or send the GIF.
  const star = starFromEvent(event);
  if (star) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void handleStarClick(star);
    return;
  }

  const anchor = closestAnchor(event);
  if (!anchor) return;

  const href = anchor.getAttribute('href') ?? anchor.href;
  const plainClick =
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

  // Policy lives in a pure function so it can be tested exhaustively against
  // real captured markup rather than only through the DOM.
  const action = decideClickAction(href, { baseUrl: location.href, plainClick });

  switch (action.kind) {
    case 'copy':
      // Deliberately unconditional: plain, modified and middle clicks all copy.
      // The escape hatch is right-click -> "Copy link address", untouched.
      event.preventDefault();
      event.stopImmediatePropagation();
      void handleResultClick(action.url, anchor);
      return;
    case 'search':
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ type: 'frame:search-chip', query: action.query });
      return;
    case 'external':
      // Keep the frame pinned to tenor so the picker can never become a random
      // website — but do not trap the user: open it in a real tab.
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ type: 'frame:open-external', url: action.url });
      return;
    case 'allow':
      return;
    default:
      assertNever(action, 'click action');
  }
}

function onDragStart(event: DragEvent): void {
  const anchor = closestAnchor(event);
  if (!anchor) return;
  const url = canonicalViewUrl(anchor.getAttribute('href') ?? anchor.href, location.href);
  if (!url || !event.dataTransfer) return;
  // Dragging a result out drops the canonical link rather than the raw href.
  event.dataTransfer.setData('text/plain', url);
  event.dataTransfer.setData('text/uri-list', url);
}

function isDiscordFrame(): boolean {
  return document.documentElement.getAttribute('data-deliver') === 'send';
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // Focus is inside a cross-origin frame, so the parent document never sees
    // this keydown. Without the relay, Esc silently stops working the moment the
    // user clicks anything in the grid — i.e. always.
    event.preventDefault();
    event.stopImmediatePropagation();
    send({ type: 'frame:dismiss' });
    return;
  }

  // The close shortcuts must be handled here too: once the user clicks the grid,
  // focus is in this frame, so neither the host page nor the picker sees the key.
  const slash = event.code === 'Slash' || event.key === '/' || event.key === '÷';
  if (slash && event.altKey && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    send({ type: 'frame:dismiss' });
    return;
  }
  if (
    !event.repeat &&
    event.code === 'KeyG' &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    isDiscordFrame() &&
    cmdGEnabled
  ) {
    // Also suppresses Chrome's Find Next default for this frame.
    event.preventDefault();
    event.stopImmediatePropagation();
    send({ type: 'frame:dismiss' });
    return;
  }

  if (event.key === 'Tab' && event.shiftKey) {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      event.preventDefault();
      send({ type: 'frame:focus-back' });
    }
  }
}

// ---------------------------------------------------------------------------
// Health checks (implementation-plan.md §7.6)
// ---------------------------------------------------------------------------

function readRelease(): string | null {
  const el = document.querySelector('script[src*="release="], link[href*="release="]');
  const raw = el?.getAttribute('src') ?? el?.getAttribute('href');
  if (!raw) return null;
  return safeUrl(raw, location.href)?.searchParams.get('release') ?? null;
}

/**
 * Is the results grid GENUINELY collapsed by our own CSS — i.e. it exists but
 * has been given zero layout height — as opposed to merely "not painted yet"?
 *
 * This is the only signal strong enough to justify self-heal. A transient
 * zero client-rect on the anchors (masonry mid-layout, images still decoding)
 * must never trigger it; that false positive is exactly what stripped the
 * stylesheet and dumped the full page in the previous version.
 */
function gridGenuinelyCollapsed(resultCount: number): boolean {
  if (resultCount === 0) return false;
  const grid = document.querySelector<HTMLElement>('.UniversalGifList');
  if (!grid) return false;
  if (grid.offsetHeight > 0) return false;
  return getComputedStyle(grid).display === 'none' || grid.offsetParent === null;
}

function runHealthChecks(): HealthReport {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(RESULT_SELECTOR));
  const resultCount = anchors.length;

  // Measures a client RECT rather than counting nodes: it distinguishes
  // "tenor returned nothing" from "results exist but aren't laid out yet".
  const visibleResults = anchors.filter((anchor) => {
    const rect = anchor.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).length;

  const baseApp = document.querySelector('.BaseApp');
  const baseAppChildren = baseApp ? baseApp.children.length : 0;
  const columns = document.querySelectorAll('.UniversalGifList .column').length;

  let status: HealthStatus = 'ok';
  if (resultCount === 0) {
    status = 'empty'; // tenor genuinely returned nothing
  } else if (gridGenuinelyCollapsed(resultCount)) {
    status = 'degraded'; // our surgery collapsed a grid that has real results
  } else if (baseAppChildren > 0 && (baseAppChildren < 5 || baseAppChildren > 10)) {
    status = 'structure-drift';
  }

  return { resultCount, visibleResults, baseAppChildren, columns, release: readRelease(), status };
}

/**
 * Poll until the grid is actually laid out before reporting readiness.
 *
 * tenor server-renders the anchors, then its masonry moves them into column
 * containers, so an early read can legitimately see zero results or zero client
 * rects. We settle as soon as results have real layout, and — crucially — the
 * timeout path is NON-destructive: it reports whatever state we have and lets
 * the picker decide, never strips the stylesheet.
 */
function pollUntilReady(): void {
  const started = Date.now();

  const attempt = (): void => {
    const health = runHealthChecks();
    const settled = health.resultCount > 0 && health.visibleResults > 0;
    const timedOut = Date.now() - started >= RESULT_POLL_TIMEOUT_MS;

    if (settled || timedOut) {
      ensureStars();
      maybeSelfHeal(health);
      send({ type: 'frame:ready', health, query: parseSearchSlug(location.pathname) });
      return;
    }

    window.setTimeout(attempt, RESULT_POLL_INTERVAL_MS);
  };

  attempt();
}

// Self-heal only fires after this many consecutive genuinely-collapsed reads,
// so a single odd frame can never rip out the stylesheet.
let collapsedStreak = 0;

/**
 * Reversible, conservative self-heal.
 *
 * If — and only if — the grid is genuinely collapsed (zero layout height) for
 * two consecutive checks, remove the surgery so the user sees real GIFs instead
 * of a blank box. If a later check shows the grid is fine again, restore it.
 * This is the safety net for tenor changing its markup between canary runs; it
 * is deliberately hard to trigger.
 */
function maybeSelfHeal(health: HealthReport): void {
  if (health.status === 'degraded') {
    collapsedStreak += 1;
    if (collapsedStreak >= 2) document.documentElement.removeAttribute(FRAME_ATTR);
  } else {
    collapsedStreak = 0;
    if (health.visibleResults > 0 && !document.documentElement.hasAttribute(FRAME_ATTR)) {
      // Recovered — re-apply the surgery.
      markFrame();
    }
  }
}

/**
 * Watch the grid for tenor's own re-renders (client-side routing, infinite
 * scroll) so stars are re-injected and a late-arriving result set can rescue a
 * picker that already showed "no results".
 */
function watchGrid(): void {
  let healthTimer: number | null = null;
  let starScheduled = false;

  const recheck = (): void => {
    // Coalesce star re-injection to one pass per frame: a body-level subtree
    // observer fires far more often than a grid-level one.
    if (!starScheduled) {
      starScheduled = true;
      requestAnimationFrame(() => {
        starScheduled = false;
        ensureStars();
      });
    }
    if (healthTimer !== null) window.clearTimeout(healthTimer);
    healthTimer = window.setTimeout(() => {
      healthTimer = null;
      const health = runHealthChecks();
      maybeSelfHeal(health);
      send({ type: 'frame:health', health });
    }, 250);
  };

  // Observe a STABLE root, not the results grid.
  //
  // tenor is an Inferno SPA that client-renders into #root with render() (NOT
  // hydrate() — verified: zero hydrate() calls in their bundle), so it discards
  // the server-rendered `.UniversalGifList` wholesale and rebuilds it. An
  // observer bound to that SSR grid goes deaf the instant tenor mounts, and our
  // injected stars — unlike the document-delegated click handler and the CSS
  // ::after label, which both survive — would never be re-added. `document.body`
  // persists across every re-render; tenor renders INTO #root, it never replaces
  // body.
  const target = document.body ?? document.documentElement;
  if (!target) return;
  new MutationObserver(recheck).observe(target, { childList: true, subtree: true });
}

/**
 * Reflect the delivery mode set by the host overlay so each tile's hover label
 * reads "Send" on Discord and "Copy link" everywhere else.
 */
function applyDeliverMode(): void {
  try {
    void chrome.storage.local.get(STORAGE_KEYS.deliver).then((stored) => {
      const mode: unknown = stored[STORAGE_KEYS.deliver];
      if (mode === 'send') document.documentElement.setAttribute('data-deliver', 'send');
      else document.documentElement.removeAttribute('data-deliver');
    });
  } catch {
    /* storage unavailable — the default "Copy link" label is still correct */
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (isPickerFrame()) {
  markFrameWhenReady();
  applyDeliverMode();

  void loadSettings().then((s) => {
    cmdGEnabled = s.cmdGDiscord;
  });
  watchSettings((s) => {
    cmdGEnabled = s.cmdGDiscord;
  });

  // Capture phase, registered at document_start: this must be in place before
  // tenor's own bundle runs, so no page handler can stopImmediatePropagation()
  // ahead of us.
  //
  // Delegated on `document` rather than per-anchor, which is mandatory rather
  // than stylistic: tenor's grid is destroyed and recreated on every search and
  // every infinite-scroll page, so per-anchor listeners would work exactly once
  // and then silently stop.
  document.addEventListener('click', onActivate, true);
  document.addEventListener('auxclick', onActivate, true);
  document.addEventListener('dragstart', onDragStart, true);
  document.addEventListener('keydown', onKeyDown, true);

  watchFavourites((list) => {
    favouriteUrls = new Set(list.map((item) => item.url));
    syncAllStars();
  });

  const boot = (): void => {
    void loadFavourites().then((list) => {
      favouriteUrls = new Set(list.map((item) => item.url));
      ensureStars();
      syncAllStars();
    });
    pollUntilReady();
    watchGrid();
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
}
