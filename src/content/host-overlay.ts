/**
 * Host-page overlay.
 *
 * Injected on demand via `activeTab` (never a static <all_urls> content script,
 * which is what keeps the install prompt to "your data on tenor.com" instead of
 * "all your data on all websites").
 *
 * Its whole job is to own a closed shadow root containing one iframe pointing
 * at our own extension page. It deliberately holds no product logic — all of
 * that lives inside picker.html, in a document we control, where the host
 * page's CSS, its Trusted Types policy and its JS cannot reach it.
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
import { isSwToHostMessage } from '../shared/messages.js';

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
  background: #ffffff;
  /* The hairline is not decoration. tenor's page is #fff; a white panel on a
     white host page with only a shadow reads as a smudge rather than a surface. */
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.24), 0 2px 8px rgba(0, 0, 0, 0.12);
  transform-origin: bottom right;
  transform: scale(0.96) translateY(8px);
  opacity: 0;
  transition:
    transform ${OPEN_ANIM_MS}ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity ${OPEN_ANIM_MS}ms cubic-bezier(0.16, 1, 0.3, 1);
  contain: layout paint style;
  isolation: isolate;
  color-scheme: light;
}
.wrap.is-open { transform: none; opacity: 1; }
.wrap.is-closing {
  transition-duration: ${CLOSE_ANIM_MS}ms;
  transition-timing-function: ease-in;
  transform: scale(0.98) translateY(4px);
  opacity: 0;
}
/* Forcing GPU rasterisation makes Chrome clip the iframe's square corners to
   the wrapper's radius reliably; without it you get faint corner artefacts. */
.wrap { transform: translateZ(0) scale(0.96) translateY(8px); }
.wrap.is-open { transform: translateZ(0); }
.wrap.is-closing { transform: translateZ(0) scale(0.98) translateY(4px); }

iframe {
  /* display:block matters — an inline-level iframe inherits the line box and
     leaves a ~4px phantom seam along the bottom edge. */
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  color-scheme: light dark;
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
  border-left: 2px solid rgba(0, 0, 0, 0.22);
  border-top: 2px solid rgba(0, 0, 0, 0.22);
  border-radius: 2px 0 0 0;
  opacity: 0;
  transition: opacity 120ms ease-out;
}
.wrap:hover .grip::before { opacity: 1; }

@media (prefers-color-scheme: dark) {
  .wrap {
    background: #1e1f22;
    border-color: rgba(255, 255, 255, 0.09);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.35);
    color-scheme: dark;
  }
  .grip::before { border-color: rgba(255, 255, 255, 0.28); }
}

@media (prefers-reduced-motion: reduce) {
  .wrap {
    transition: opacity 100ms linear;
    transform: translateZ(0);
  }
  .wrap.is-open { transform: translateZ(0); }
  .wrap.is-closing { transform: translateZ(0); }
}
`;

function install(): void {
  let hostEl: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let wrap: HTMLElement | null = null;
  let frame: HTMLIFrameElement | null = null;
  let previouslyFocused: HTMLElement | null = null;
  let reattachObserver: MutationObserver | null = null;
  let closeTimer: number | null = null;
  let size: Size = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

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
    // "outside" and the picker closes when you click its own chrome.
    // Capture phase, because a host page that stopPropagation()s pointer events
    // must not be able to trap us.
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

  function buildDom(tabId: number): void {
    // Everything here uses createElement + property assignment. No innerHTML:
    // pages like mail.google.com ship `require-trusted-types-for 'script'`,
    // which is enforced per-document and applies to isolated worlds too.
    const host = document.createElement('div');
    host.id = HOST_ELEMENT_ID;
    // Inline !important beats any page stylesheet trying to reach our host.
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('top', '0', 'important');
    host.style.setProperty('left', '0', 'important');
    host.style.setProperty('width', '0', 'important');
    host.style.setProperty('height', '0', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');

    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    root.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'wrap';

    const iframe = document.createElement('iframe');
    // NEVER loading="lazy". Lazy loading short-circuits before the frame's
    // load request is attributed to our isolated world, which forfeits the
    // CSP bypass and breaks the picker on strict-CSP sites only — a miserable
    // bug to reproduce.
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('title', 'Tenor GIF picker');
    iframe.src = `${chrome.runtime.getURL('picker.html')}?tabId=${String(tabId)}`;

    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.setAttribute('aria-hidden', 'true');
    attachResize(grip);

    panel.appendChild(iframe);
    panel.appendChild(grip);
    root.appendChild(panel);

    hostEl = host;
    shadow = root;
    wrap = panel;
    frame = iframe;
  }

  function open(tabId: number): void {
    if (isOpen()) return;
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }

    previouslyFocused = document.activeElement as HTMLElement | null;

    void loadSize().then(() => {
      buildDom(tabId);
      if (!hostEl || !wrap) return;

      // documentElement, not body: SPA frameworks replace body wholesale, and
      // an ancestor with transform/filter/contain would capture position:fixed.
      document.documentElement.appendChild(hostEl);
      applyGeometry();

      // Force a style flush so the entry transition actually runs.
      void wrap.getBoundingClientRect();
      wrap.classList.add('is-open');

      addDocumentListeners();

      reattachObserver = new MutationObserver(() => {
        if (hostEl && !hostEl.isConnected) document.documentElement.appendChild(hostEl);
      });
      reattachObserver.observe(document.documentElement, { childList: true });
    });
  }

  function close(): void {
    if (!hostEl || !wrap) return;
    const host = hostEl;
    const panel = wrap;

    removeDocumentListeners();
    reattachObserver?.disconnect();
    reattachObserver = null;

    panel.classList.remove('is-open');
    panel.classList.add('is-closing');

    hostEl = null;
    shadow = null;
    wrap = null;
    frame = null;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    closeTimer = window.setTimeout(
      () => {
        host.remove();
        closeTimer = null;
      },
      reduced ? 100 : CLOSE_ANIM_MS,
    );

    // The core loop is copy -> close -> paste. If closing does not put focus
    // back where it was, the paste target is gone and two steps become four.
    const target = previouslyFocused;
    previouslyFocused = null;
    if (target && typeof target.focus === 'function' && target.isConnected) {
      try {
        target.focus({ preventScroll: true });
      } catch {
        /* element detached in the meantime */
      }
    }
  }

  function toggle(tabId: number): void {
    if (isOpen()) close();
    else open(tabId);
  }

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isSwToHostMessage(message)) return undefined;
    if (message.type === 'sw:toggle') toggle(message.tabId);
    else if (message.type === 'sw:close') close();
    return undefined;
  });

  // Keep the reference alive for debugging without leaking it to the page.
  void frame;
  void shadow;
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
