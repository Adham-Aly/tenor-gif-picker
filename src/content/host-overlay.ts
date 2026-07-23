/**
 * Host-page overlay.
 *
 * Owns a closed shadow root containing one iframe pointing at our own extension
 * page. It deliberately holds no product logic — that lives inside picker.html,
 * in a document we control, where the host page's CSS, its Trusted Types policy
 * and its JS cannot reach it.
 *
 * Two things beyond hosting:
 *   - global hotkeys (Cmd/Ctrl+Alt+/ everywhere, Cmd/Ctrl+G on Discord)
 *   - delivering a picked GIF into Discord's composer
 */

import {
  CLOSE_ANIM_MS,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  EDGE_OFFSET,
  HOST_ELEMENT_ID,
  HOST_INSTALLED_FLAG,
  MAX_HEIGHT,
  MAX_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  OPEN_ANIM_MS,
  SMALL_VIEWPORT,
  SMALL_VIEWPORT_INSET,
  STORAGE_KEYS,
  VIEWPORT_MARGIN,
} from '../shared/constants.js';
import { deliverToDiscord, isDiscord } from '../shared/discord.js';
import { isSwToHostMessage, type WhoAmIReply } from '../shared/messages.js';

interface Size {
  width: number;
  height: number;
}

const SHADOW_CSS = `
:host { all: initial !important; }
.wrap {
  position: fixed;
  right: var(--tgp-inset, ${EDGE_OFFSET}px);
  bottom: var(--tgp-inset, ${EDGE_OFFSET}px);
  width: var(--tgp-w, ${DEFAULT_WIDTH}px);
  height: var(--tgp-h, ${DEFAULT_HEIGHT}px);
  max-width: calc(100vw - ${VIEWPORT_MARGIN}px);
  max-height: calc(100vh - ${VIEWPORT_MARGIN}px);
  border-radius: 12px;
  overflow: hidden;
  /* Opaque, always. A translucent panel is what lets page content appear to
     bleed through, and this sits above everything so it must be solid. */
  background: #131417;
  border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow:
    0 16px 44px rgba(0, 0, 0, 0.62),
    0 3px 10px rgba(0, 0, 0, 0.45);
  transform-origin: bottom right;
  opacity: 0;
  transition:
    transform ${OPEN_ANIM_MS}ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity ${OPEN_ANIM_MS}ms cubic-bezier(0.16, 1, 0.3, 1);
  /* translateZ forces GPU rasterisation, which makes Chrome clip the iframe's
     square corners to this radius reliably. */
  transform: translateZ(0) scale(0.96) translateY(8px);
  isolation: isolate;
  color-scheme: dark;
}
.wrap.is-open { transform: translateZ(0); opacity: 1; }
.wrap.is-closing {
  transition-duration: ${CLOSE_ANIM_MS}ms;
  transition-timing-function: ease-in;
  transform: translateZ(0) scale(0.98) translateY(4px);
  opacity: 0;
}

iframe {
  /* display:block matters — an inline-level iframe inherits the line box and
     leaves a ~4px phantom seam along the bottom edge. */
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  /* Opaque rather than transparent: if the document inside ever paints late,
     the gap shows our surface colour instead of the page behind. */
  background: #131417;
  color-scheme: dark;
}

.grip {
  position: absolute;
  left: 0;
  top: 0;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
  z-index: 2;
  touch-action: none;
  background: transparent;
}
.grip::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 5px;
  width: 7px;
  height: 7px;
  border-left: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 2px 0 0 0;
  opacity: 0;
  transition: opacity 120ms ease-out;
}
.wrap:hover .grip::before { opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  .wrap { transition: opacity 100ms linear; transform: translateZ(0); }
  .wrap.is-open { transform: translateZ(0); }
  .wrap.is-closing { transform: translateZ(0); }
}
`;

function install(): void {
  let hostEl: HTMLElement | null = null;
  let wrap: HTMLElement | null = null;
  let previouslyFocused: HTMLElement | null = null;
  let reattachObserver: MutationObserver | null = null;
  let closeTimer: number | null = null;
  let size: Size = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  let cachedTabId: number | null = null;

  const onDiscord = isDiscord();
  const isOpen = (): boolean => hostEl !== null;

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  function applyGeometry(): void {
    if (!wrap) return;
    const small = window.innerWidth < SMALL_VIEWPORT;
    const inset = small ? SMALL_VIEWPORT_INSET : EDGE_OFFSET;
    const width = small ? Math.max(MIN_WIDTH, window.innerWidth - inset * 2) : size.width;
    const height = small ? Math.max(MIN_HEIGHT, window.innerHeight - inset * 2) : size.height;
    wrap.style.setProperty('--tgp-inset', `${inset}px`);
    wrap.style.setProperty('--tgp-w', `${width}px`);
    wrap.style.setProperty('--tgp-h', `${height}px`);
  }

  function clampSize(next: Size): Size {
    return {
      width: Math.min(
        Math.max(next.width, MIN_WIDTH),
        Math.min(MAX_WIDTH, window.innerWidth - VIEWPORT_MARGIN),
      ),
      height: Math.min(
        Math.max(next.height, MIN_HEIGHT),
        Math.min(MAX_HEIGHT, window.innerHeight - VIEWPORT_MARGIN),
      ),
    };
  }

  async function loadSize(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.size);
      const value = stored[STORAGE_KEYS.size] as Partial<Size> | undefined;
      if (value && typeof value.width === 'number' && typeof value.height === 'number') {
        size = clampSize({ width: value.width, height: value.height });
      }
    } catch {
      /* fall back to defaults */
    }
  }

  function persistSize(): void {
    void chrome.storage.local.set({ [STORAGE_KEYS.size]: size }).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Resize handle (top-left corner; the panel is anchored bottom-right)
  // -------------------------------------------------------------------------

  function attachResize(grip: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let resizing = false;

    grip.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0 || !wrap) return;
      resizing = true;
      startX = event.clientX;
      startY = event.clientY;
      const rect = wrap.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      grip.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    grip.addEventListener('pointermove', (event: PointerEvent) => {
      if (!resizing) return;
      size = clampSize({
        width: startW + (startX - event.clientX),
        height: startH + (startY - event.clientY),
      });
      applyGeometry();
    });

    const end = (event: PointerEvent): void => {
      if (!resizing) return;
      resizing = false;
      try {
        grip.releasePointerCapture(event.pointerId);
      } catch {
        /* pointer already released */
      }
      persistSize();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  // -------------------------------------------------------------------------
  // Document-level listeners
  // -------------------------------------------------------------------------

  const onPointerDown = (event: PointerEvent): void => {
    if (!hostEl) return;
    // composedPath() is required: without it the shadow root's contents read as
    // "outside" and the picker closes when you click its own chrome. Capture
    // phase, because a host page that stopPropagation()s pointer events must
    // not be able to trap us.
    if (event.composedPath().includes(hostEl)) return;
    close();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !isOpen()) return;
    event.stopPropagation();
    close();
  };

  const onViewportChange = (): void => {
    size = clampSize(size);
    applyGeometry();
  };

  function addDocumentListeners(): void {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onViewportChange, { passive: true });
  }

  function removeDocumentListeners(): void {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onViewportChange);
  }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------

  function buildDom(tabId: number | null): void {
    // Everything here uses createElement + property assignment. No innerHTML:
    // pages like mail.google.com ship `require-trusted-types-for 'script'`,
    // which is enforced per-document and applies to isolated worlds too.
    const host = document.createElement('div');
    host.id = HOST_ELEMENT_ID;

    // The popover attribute promotes this element into the browser's TOP LAYER,
    // which paints above every other element on the page regardless of z-index
    // or stacking context. That is the only way to be genuinely un-coverable;
    // z-index alone loses to any page element that also uses the maximum value
    // and appears later in the DOM.
    host.setAttribute('popover', 'manual');

    // `all: initial` first (kills any page rule that might reach this element,
    // including a `transform` that would break position:fixed for descendants),
    // then the specific overrides, which win because they come later.
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('top', '0', 'important');
    host.style.setProperty('left', '0', 'important');
    // The UA stylesheet gives an open popover `inset: 0`, which would otherwise
    // fight the zero-size box we want here.
    host.style.setProperty('right', 'auto', 'important');
    host.style.setProperty('bottom', 'auto', 'important');
    host.style.setProperty('width', '0', 'important');
    host.style.setProperty('height', '0', 'important');
    host.style.setProperty('max-width', 'none', 'important');
    host.style.setProperty('max-height', 'none', 'important');
    host.style.setProperty('margin', '0', 'important');
    host.style.setProperty('padding', '0', 'important');
    host.style.setProperty('border', '0', 'important');
    host.style.setProperty('background', 'transparent', 'important');
    host.style.setProperty('overflow', 'visible', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('color-scheme', 'dark', 'important');
    host.style.setProperty('pointer-events', 'none', 'important');

    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    root.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'wrap';
    // The 0x0 host ignores pointer events so it cannot swallow clicks meant for
    // the page; the panel itself takes them back.
    panel.style.setProperty('pointer-events', 'auto');

    const iframe = document.createElement('iframe');
    // NEVER loading="lazy". Lazy loading short-circuits before the frame's load
    // request is attributed to our isolated world, which forfeits the CSP bypass
    // and breaks the picker on strict-CSP sites only — a miserable bug to find.
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('title', 'Tenor GIF picker');
    const query = tabId === null ? '' : `?tabId=${String(tabId)}`;
    iframe.src = `${chrome.runtime.getURL('picker.html')}${query}`;

    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.setAttribute('aria-hidden', 'true');
    attachResize(grip);

    panel.appendChild(iframe);
    panel.appendChild(grip);
    root.appendChild(panel);

    hostEl = host;
    wrap = panel;
  }

  function promoteToTopLayer(host: HTMLElement): void {
    try {
      const candidate = host as HTMLElement & { showPopover?: () => void };
      if (typeof candidate.showPopover === 'function') candidate.showPopover();
    } catch {
      // Older Chromium without the popover API: the max z-index above is the
      // fallback, which is what we had before and is usually enough.
    }
  }

  async function open(tabId: number | null): Promise<void> {
    if (isOpen()) return;
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }

    previouslyFocused = document.activeElement as HTMLElement | null;

    await loadSize();
    buildDom(tabId ?? (await getTabId()));
    if (!hostEl || !wrap) return;

    // documentElement, not body: SPA frameworks replace body wholesale, and an
    // ancestor with transform/filter/contain would capture position:fixed.
    document.documentElement.appendChild(hostEl);
    promoteToTopLayer(hostEl);
    applyGeometry();

    // Force a style flush so the entry transition actually runs.
    void wrap.getBoundingClientRect();
    wrap.classList.add('is-open');

    addDocumentListeners();

    reattachObserver = new MutationObserver(() => {
      if (hostEl && !hostEl.isConnected) {
        document.documentElement.appendChild(hostEl);
        promoteToTopLayer(hostEl);
      }
    });
    reattachObserver.observe(document.documentElement, { childList: true });
  }

  function close(options: { restoreFocus?: boolean } = {}): void {
    if (!hostEl || !wrap) return;
    const host = hostEl;
    const panel = wrap;

    removeDocumentListeners();
    reattachObserver?.disconnect();
    reattachObserver = null;

    panel.classList.remove('is-open');
    panel.classList.add('is-closing');

    hostEl = null;
    wrap = null;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    closeTimer = window.setTimeout(
      () => {
        try {
          const candidate = host as HTMLElement & { hidePopover?: () => void };
          if (typeof candidate.hidePopover === 'function') candidate.hidePopover();
        } catch {
          /* not in the top layer; removal is enough */
        }
        host.remove();
        closeTimer = null;
      },
      reduced ? 100 : CLOSE_ANIM_MS,
    );

    // The core loop is copy -> close -> paste. If closing does not put focus
    // back where it was, the paste target is gone and two steps become four.
    // Skipped after a Discord send, where the composer should keep focus.
    const target = previouslyFocused;
    previouslyFocused = null;
    if (options.restoreFocus === false) return;
    if (target && typeof target.focus === 'function' && target.isConnected) {
      try {
        target.focus({ preventScroll: true });
      } catch {
        /* element detached in the meantime */
      }
    }
  }

  async function toggle(tabId: number | null): Promise<void> {
    if (isOpen()) close();
    else await open(tabId);
  }

  // -------------------------------------------------------------------------
  // Tab identity
  // -------------------------------------------------------------------------

  async function getTabId(): Promise<number | null> {
    if (cachedTabId !== null) return cachedTabId;
    try {
      // Typed as `unknown` first: chrome.runtime.sendMessage is `any`, so a
      // direct assertion would assert nothing and hide a real shape mismatch.
      const reply: unknown = await chrome.runtime.sendMessage({ type: 'host:whoami' });
      const reported = (reply as Partial<WhoAmIReply> | null | undefined)?.tabId;
      if (typeof reported === 'number' && Number.isInteger(reported)) {
        cachedTabId = reported;
      }
    } catch {
      /* the picker can still resolve its tab from the port sender */
    }
    return cachedTabId;
  }

  // -------------------------------------------------------------------------
  // Hotkeys
  // -------------------------------------------------------------------------

  const onHotkey = (event: KeyboardEvent): void => {
    if (event.repeat) return;

    // Cmd/Ctrl + Alt + /
    //
    // `event.code` rather than `event.key`: on macOS, Option+/ produces the
    // character '÷', so `key` is not '/' at all. `code` is layout-stable.
    const slash = event.code === 'Slash' || event.key === '/' || event.key === '÷';
    if (slash && event.altKey && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void toggle(null);
      return;
    }

    // Cmd/Ctrl + G, on Discord only.
    //
    // Capture phase on `window` fires before any listener Discord registers on
    // document or on the composer, and preventDefault suppresses their handler
    // as well as the browser's find-next.
    if (
      onDiscord &&
      event.code === 'KeyG' &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void toggle(null);
    }
  };

  window.addEventListener('keydown', onHotkey, true);

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  async function deliver(url: string): Promise<void> {
    if (!onDiscord) return; // elsewhere the clipboard is the delivery mechanism
    const result = await deliverToDiscord(url);
    if (result.sent) {
      // Match Discord's own picker: sending closes it, and focus stays in the
      // composer so the user can keep typing.
      close({ restoreFocus: false });
    }
  }

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isSwToHostMessage(message)) return undefined;
    if (message.type === 'sw:toggle') void toggle(message.tabId);
    else if (message.type === 'sw:close') close();
    else if (message.type === 'sw:deliver') void deliver(message.url);
    return undefined;
  });
}

(() => {
  // Only the top frame. Without this, every ad iframe and embed on the host
  // page would spawn its own picker.
  if (window.top !== window.self) return;

  const globals = window as unknown as Record<string, unknown>;
  if (globals[HOST_INSTALLED_FLAG] === true) return;
  globals[HOST_INSTALLED_FLAG] = true;

  install();
})();
