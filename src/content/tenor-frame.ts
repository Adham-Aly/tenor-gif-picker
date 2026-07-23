/**
 * Runs inside the tenor.com document, at document_start, in every frame.
 *
 * This is where the product's actual stipulation happens: a click on a result
 * becomes a clipboard write instead of a navigation.
 */

import {
  COPY_PENDING_MS,
  FRAME_ATTR,
  TILE_BUSY_CLASS,
  TILE_COPIED_CLASS,
  TILE_FAILED_CLASS,
  TILE_FEEDBACK_MS,
} from '../shared/constants.js';
import { copyText } from '../shared/clipboard.js';
import { decideClickAction } from '../shared/click-action.js';
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

  // A web page cannot create a chrome-extension:// parent frame, so this
  // cannot be spoofed by a hostile site — and we additionally require that it
  // be OUR extension rather than merely some extension.
  const ours = extensionOrigin();
  return ours !== null && immediateParent === ours;
}

/**
 * Scope the manifest-declared stylesheet to this frame.
 *
 * `tenor-frame.css` is declared in the manifest so that it lands before first
 * paint (an `insertCSS` later produces a visible flash of un-surgered tenor),
 * but that also means it is delivered on normal tenor.com browsing. Every rule
 * in it is gated on `html[data-tenor-picker]`, so it does nothing until this
 * attribute appears — and removing the attribute is how health check H2
 * self-heals.
 */
function markFrame(): boolean {
  const root = document.documentElement;
  if (!root) return false;
  root.setAttribute(FRAME_ATTR, '');
  return true;
}

function markFrameWhenReady(): void {
  if (markFrame()) return;
  // Exceptionally early document_start: <html> does not exist yet.
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
      // The escape hatch is right-click -> "Copy link address", which we leave
      // completely untouched.
      event.preventDefault();
      event.stopImmediatePropagation();
      void handleResultClick(action.url, anchor);
      return;
    case 'search':
      // Tenor's own related-tag chips. Blanket-blocking them would break 74% of
      // the page; ignoring them would let the frame drift out of sync with our
      // search box. So relay the query and let the picker drive.
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

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // Focus is inside a cross-origin frame, so the parent document never sees
    // this keydown. Without the relay, Esc silently stops working the moment
    // the user clicks anything in the grid — i.e. always.
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

function runHealthChecks(): HealthReport {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(RESULT_SELECTOR));
  const resultCount = anchors.length;

  // H2 measures a client RECT rather than counting nodes. That is the whole
  // point: it is what distinguishes "tenor returned nothing" from "results
  // exist and we accidentally hid them". A naive single check conflates them.
  const visibleResults = anchors.filter((anchor) => {
    const rect = anchor.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).length;

  const baseApp = document.querySelector('.BaseApp');
  const baseAppChildren = baseApp ? baseApp.children.length : 0;
  const columns = document.querySelectorAll('.UniversalGifList .column').length;

  let status: HealthStatus = 'ok';
  if (resultCount === 0) {
    status = 'empty'; // H1 — not a surgery failure
  } else if (visibleResults === 0) {
    status = 'degraded'; // H2 — we hid them
  } else if (baseAppChildren > 0 && (baseAppChildren < 5 || baseAppChildren > 10)) {
    status = 'structure-drift'; // H3
  }

  if (status === 'degraded') {
    // Self-heal. An ugly picker showing real GIFs beats a beautiful empty one.
    document.documentElement.removeAttribute(FRAME_ATTR);
  }

  return { resultCount, visibleResults, baseAppChildren, columns, release: readRelease(), status };
}

function reportReady(): void {
  const health = runHealthChecks();
  send({ type: 'frame:ready', health, query: parseSearchSlug(location.pathname) });
}

function watchForDrift(): void {
  let timer: number | null = null;
  const recheck = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      send({ type: 'frame:health', health: runHealthChecks() });
    }, 400);
  };
  const list = document.querySelector('.UniversalGifList') ?? document.body;
  if (!list) return;
  new MutationObserver(recheck).observe(list, { childList: true, subtree: false });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (isPickerFrame()) {
  markFrameWhenReady();

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

  const boot = (): void => {
    // Let layout settle before measuring client rects for H2.
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        reportReady();
        watchForDrift();
      }, 60);
    });
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
  window.addEventListener('load', () => send({ type: 'frame:health', health: runHealthChecks() }));
}
