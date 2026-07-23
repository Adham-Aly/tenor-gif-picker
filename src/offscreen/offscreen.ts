/**
 * Offscreen clipboard helper — tier 3.
 *
 * Reached only when both in-frame paths failed. This is the one tier with no
 * dependency on the host page, the tenor page, focus, or a user gesture: the
 * document has no parent, so it inherits no Permissions Policy, and the
 * `clipboardWrite` permission satisfies `AllowWriteToClipboard()`, which is the
 * final branch of Chromium's `CanWriteClipboard`.
 */

import { execCommandCopy } from '../shared/clipboard.js';
import { isOffscreenMessage, type OffscreenReply } from '../shared/messages.js';

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (reply: OffscreenReply) => void) => {
    // This document receives every runtime broadcast, including the tenor
    // frame's own messages, so the guard is doing real filtering work.
    if (!isOffscreenMessage(message)) return false;

    const result = execCommandCopy(message.text);
    sendResponse({ ok: result.ok });
    return false; // responded synchronously
  },
);
