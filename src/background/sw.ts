/**
 * Service worker — the single arbiter.
 *
 * Owns: the DNR rule lifecycle, the picker session registry, all cross-frame
 * message routing, and the offscreen clipboard fallback. Everything funnels
 * through here rather than frames talking to each other directly, because this
 * is the one place where sender identity is browser-asserted (see messages.ts).
 */

import { PICKER_PORT } from '../shared/constants.js';
import {
  assertNever,
  isFrameMessage,
  isPickerMessage,
  type FrameMessage,
  type PickerMessage,
  type SwToPickerMessage,
} from '../shared/messages.js';
import { canonicalViewUrl, isInjectableUrl, isTenorHost, safeUrl } from '../shared/urls.js';

const DEFAULT_TITLE = 'Open Tenor GIF picker (Alt+Shift+G)';

/** Session rule ids are allocated from here upward. */
const RULE_ID_BASE = 9000;

interface Session {
  tabId: number;
  port: chrome.runtime.Port;
  tenorFrameId: number | null;
}

/**
 * In-memory only, and deliberately so: the service worker can be torn down at
 * any time. Nothing here is the source of truth for teardown — the DNR session
 * rules are, and they are reconciled against live tabs on every worker start.
 */
const sessions = new Map<number, Session>();

// ---------------------------------------------------------------------------
// declarativeNetRequest — stripping X-Frame-Options
// ---------------------------------------------------------------------------

/**
 * Arm the XFO strip for one tab.
 *
 * Scope is the product of three limiters: the header (only `x-frame-options`,
 * only on `sub_frame` responses from tenor.com), the tab (`tabIds`, which is
 * supported on session rules ONLY — this is why these cannot be static or
 * dynamic rules), and time (armed on picker open, removed on port disconnect).
 *
 * NOTE: do not be tempted to add `initiatorDomains` here. Every search result
 * for this problem suggests it, and it matches ZERO requests — the sub_frame's
 * initiator is the embedding page, never the extension.
 *
 * Idempotent: safe (and expected) to call before every navigation.
 */
async function armFraming(tabId: number): Promise<boolean> {
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const mine = existing.find(
      (rule) => rule.condition.tabIds?.length === 1 && rule.condition.tabIds[0] === tabId,
    );

    let ruleId = mine?.id;
    if (ruleId === undefined) {
      const used = new Set(existing.map((rule) => rule.id));
      ruleId = RULE_ID_BASE;
      while (used.has(ruleId)) ruleId += 1;
    }

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: mine ? [mine.id] : [],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            responseHeaders: [
              {
                header: 'x-frame-options',
                operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation,
              },
            ],
          },
          condition: {
            requestDomains: ['tenor.com'],
            resourceTypes: ['sub_frame' as chrome.declarativeNetRequest.ResourceType],
            tabIds: [tabId],
          },
        },
      ],
    });
    return true;
  } catch (error) {
    console.error('[tenor-gif-picker] failed to arm framing rule', error);
    return false;
  }
}

async function disarmFraming(tabId: number): Promise<void> {
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const ids = existing
      .filter((rule) => rule.condition.tabIds?.includes(tabId))
      .map((rule) => rule.id);
    if (ids.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    }
  } catch (error) {
    console.error('[tenor-gif-picker] failed to disarm framing rule', error);
  }
}

/**
 * Belt-and-braces teardown. Session rules outlive the service worker, so a
 * crash while a picker was open could otherwise leave a rule armed for a tab
 * that no longer exists.
 */
async function reconcileRules(): Promise<void> {
  try {
    const [rules, tabs] = await Promise.all([
      chrome.declarativeNetRequest.getSessionRules(),
      chrome.tabs.query({}),
    ]);
    const live = new Set(tabs.map((tab) => tab.id).filter((id): id is number => id !== undefined));
    const orphans = rules
      .filter((rule) => {
        const scoped = rule.condition.tabIds;
        return Array.isArray(scoped) && scoped.length > 0 && scoped.every((id) => !live.has(id));
      })
      .map((rule) => rule.id);
    if (orphans.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: orphans });
    }
  } catch (error) {
    console.error('[tenor-gif-picker] rule reconciliation failed', error);
  }
}

// ---------------------------------------------------------------------------
// Opening / closing
// ---------------------------------------------------------------------------

async function flashUnsupported(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: '✕' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#c0392b' });
    await chrome.action.setTitle({
      tabId,
      title: 'The GIF picker cannot run on this page (browser-internal or restricted).',
    });
  } catch {
    /* the tab may be gone */
  }
  setTimeout(() => {
    void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
    void chrome.action.setTitle({ tabId, title: DEFAULT_TITLE }).catch(() => undefined);
  }, 2600);
}

async function togglePicker(tab: chrome.tabs.Tab | undefined): Promise<void> {
  const tabId = tab?.id;
  if (tabId === undefined) return;

  // `tab.url` is only populated once activeTab has been granted; if it is
  // missing we optimistically try and let the injection failure speak.
  if (tab?.url !== undefined && !isInjectableUrl(tab.url)) {
    await flashUnsupported(tabId);
    return;
  }

  try {
    // Injecting an already-injected page is harmless — host-overlay.ts guards
    // itself with a flag on its isolated world and re-registers nothing.
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ['host-overlay.js'],
    });
    await chrome.tabs.sendMessage(tabId, { type: 'sw:toggle', tabId }, { frameId: 0 });
  } catch (error) {
    console.error('[tenor-gif-picker] could not open the picker', error);
    await flashUnsupported(tabId);
  }
}

async function closePicker(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'sw:close' }, { frameId: 0 });
  } catch {
    /* overlay already gone */
  }
}

// ---------------------------------------------------------------------------
// Offscreen clipboard fallback (tier 3)
// ---------------------------------------------------------------------------

const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;

  // createDocument rejects if one already exists, and two fast clicks race, so
  // the in-flight promise is shared rather than re-entered.
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['CLIPBOARD' as chrome.offscreen.Reason],
      justification:
        'Write the selected GIF link to the clipboard when in-frame paths are blocked.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function copyViaOffscreen(text: string): Promise<boolean> {
  try {
    await ensureOffscreen();
    const reply: unknown = await chrome.runtime.sendMessage({
      type: 'offscreen:copy',
      target: 'offscreen',
      text,
    });
    return typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true;
  } catch (error) {
    console.error('[tenor-gif-picker] offscreen copy failed', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function post(session: Session, message: SwToPickerMessage): void {
  try {
    session.port.postMessage(message);
  } catch {
    /* port closed underneath us */
  }
}

function handleFrameMessage(message: FrameMessage, sender: chrome.runtime.MessageSender): void {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  // Browser-asserted origin. A page script cannot reach chrome.runtime at all,
  // but this keeps the trust boundary explicit.
  const origin = safeUrl(sender.origin ?? '');
  if (!origin || !isTenorHost(origin.hostname)) return;

  const session = sessions.get(tabId);
  if (!session) return;

  if (sender.frameId !== undefined) session.tenorFrameId = sender.frameId;

  switch (message.type) {
    case 'frame:open-external': {
      const target = safeUrl(message.url);
      if (!target || (target.protocol !== 'https:' && target.protocol !== 'http:')) return;
      void chrome.tabs.create({ url: target.href }).catch(() => undefined);
      return;
    }
    case 'frame:copied':
    case 'frame:copy-failed':
    case 'frame:copy-pending': {
      // Re-validate in the component that acts on it, not just where it came
      // from. Defence in depth against a compromised frame.
      const canonical = canonicalViewUrl(message.url);
      if (!canonical) return;
      post(session, { type: 'sw:frame-event', event: { ...message, url: canonical } });
      return;
    }
    case 'frame:ready':
    case 'frame:health':
    case 'frame:search-chip':
    case 'frame:dismiss':
    case 'frame:focus-back':
      post(session, { type: 'sw:frame-event', event: message });
      return;
    default:
      assertNever(message, 'frame message');
  }
}

async function handlePickerMessage(message: PickerMessage, session: Session): Promise<void> {
  switch (message.type) {
    case 'picker:hello':
      return;
    case 'picker:arm': {
      const ok = await armFraming(session.tabId);
      post(session, { type: 'sw:armed', requestId: message.requestId, ok });
      return;
    }
    case 'picker:close':
      await closePicker(session.tabId);
      return;
    case 'picker:copy-offscreen': {
      const canonical = canonicalViewUrl(message.url);
      const ok = canonical ? await copyViaOffscreen(canonical) : false;
      post(session, { type: 'sw:copy-offscreen-result', requestId: message.requestId, ok });
      return;
    }
    case 'picker:open-external': {
      const target = safeUrl(message.url);
      if (!target || (target.protocol !== 'https:' && target.protocol !== 'http:')) return;
      await chrome.tabs.create({ url: target.href });
      return;
    }
    default:
      assertNever(message, 'picker message');
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  void togglePicker(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-picker') return;
  void togglePicker(tab);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PICKER_PORT) return;

  // Prefer the browser-asserted tab id; fall back to the one the picker frame
  // reports from its query string (extension sub-frames do not always populate
  // `sender.tab`).
  let pending: number | null = port.sender?.tab?.id ?? null;
  let session: Session | null = null;

  const ensureSession = (tabId: number): Session => {
    const existing = sessions.get(tabId);
    if (existing && existing.port === port) return existing;
    // Replace any stale session for this tab.
    const created: Session = { tabId, port, tenorFrameId: null };
    sessions.set(tabId, created);
    return created;
  };

  port.onMessage.addListener((raw: unknown) => {
    if (!isPickerMessage(raw)) return;

    if (raw.type === 'picker:hello') {
      const tabId = pending ?? raw.tabId;
      if (typeof tabId !== 'number') return;
      pending = tabId;
      session = ensureSession(tabId);
      void armFraming(tabId);
      return;
    }

    if (!session) {
      if (pending === null) return;
      session = ensureSession(pending);
    }
    void handlePickerMessage(raw, session);
  });

  port.onDisconnect.addListener(() => {
    const tabId = session?.tabId ?? pending;
    if (tabId === null || tabId === undefined) return;
    if (sessions.get(tabId)?.port === port) sessions.delete(tabId);
    void disarmFraming(tabId);
  });
});

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id !== chrome.runtime.id) return undefined;
  if (isFrameMessage(message)) handleFrameMessage(message, sender);
  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  void disarmFraming(tabId);
});

chrome.runtime.onStartup.addListener(() => {
  void reconcileRules();
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setTitle({ title: DEFAULT_TITLE });
  void reconcileRules();
});

// Also runs on every worker wake-up, which is exactly when stale state matters.
void reconcileRules();
