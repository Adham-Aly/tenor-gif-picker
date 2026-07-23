import { describe, expect, it } from 'vitest';

import {
  isFrameMessage,
  isOffscreenMessage,
  isPickerMessage,
  isSwToHostMessage,
  isSwToPickerMessage,
  nextRequestId,
} from '../src/shared/messages.js';

describe('message validators', () => {
  it('accepts well-formed messages of each kind', () => {
    expect(isFrameMessage({ type: 'frame:dismiss' })).toBe(true);
    expect(isFrameMessage({ type: 'frame:copied', url: 'x', tier: 'writeText' })).toBe(true);
    expect(isSwToHostMessage({ type: 'sw:toggle', tabId: 1 })).toBe(true);
    expect(isPickerMessage({ type: 'picker:arm', requestId: 'a' })).toBe(true);
    expect(isSwToPickerMessage({ type: 'sw:armed', requestId: 'a', ok: true })).toBe(true);
  });

  it('rejects messages from the wrong channel', () => {
    // A frame message must not be accepted where a picker message is expected;
    // the service worker routes on these, so a leak would cross a trust boundary.
    expect(isPickerMessage({ type: 'frame:dismiss' })).toBe(false);
    expect(isFrameMessage({ type: 'picker:close' })).toBe(false);
    expect(isSwToHostMessage({ type: 'sw:armed', requestId: 'a', ok: true })).toBe(false);
  });

  it('rejects junk without throwing', () => {
    for (const junk of [null, undefined, 0, '', 'frame:dismiss', [], {}, { type: 42 }]) {
      expect(isFrameMessage(junk)).toBe(false);
      expect(isPickerMessage(junk)).toBe(false);
      expect(isSwToHostMessage(junk)).toBe(false);
      expect(isSwToPickerMessage(junk)).toBe(false);
      expect(isOffscreenMessage(junk)).toBe(false);
    }
  });
});

describe('isOffscreenMessage', () => {
  it('requires all three fields, because this document sees every broadcast', () => {
    expect(isOffscreenMessage({ type: 'offscreen:copy', target: 'offscreen', text: 'x' })).toBe(
      true,
    );
    expect(isOffscreenMessage({ type: 'offscreen:copy', target: 'offscreen' })).toBe(false);
    expect(isOffscreenMessage({ type: 'offscreen:copy', text: 'x' })).toBe(false);
    expect(isOffscreenMessage({ type: 'offscreen:copy', target: 'other', text: 'x' })).toBe(false);
    expect(isOffscreenMessage({ type: 'frame:dismiss', target: 'offscreen', text: 'x' })).toBe(
      false,
    );
  });

  it('requires text to be a string', () => {
    expect(isOffscreenMessage({ type: 'offscreen:copy', target: 'offscreen', text: 42 })).toBe(
      false,
    );
  });
});

describe('nextRequestId', () => {
  it('never repeats', () => {
    const ids = new Set(Array.from({ length: 500 }, () => nextRequestId('t')));
    expect(ids.size).toBe(500);
  });

  it('honours the prefix', () => {
    expect(nextRequestId('arm').startsWith('arm')).toBe(true);
  });
});
