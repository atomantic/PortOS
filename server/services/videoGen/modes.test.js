import { describe, it, expect } from 'vitest';
import {
  VIDEO_GEN_MODE, VIDEO_GEN_MODES, CLOUD_VIDEO_GEN_MODES,
  isVideoModeUsable, resolveVideoMode,
} from './modes.js';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';

describe('VIDEO_GEN_MODE', () => {
  it('derives its values from the queue discriminator the image lane already uses', () => {
    // The queue routes video on `params.mode === IMAGE_GEN_MODE.GROK`; deriving
    // rather than re-typing is what keeps a schema from drifting from dispatch.
    expect(VIDEO_GEN_MODE.LOCAL).toBe(IMAGE_GEN_MODE.LOCAL);
    expect(VIDEO_GEN_MODE.GROK).toBe(IMAGE_GEN_MODE.GROK);
    expect(VIDEO_GEN_MODES).toEqual(['local', 'grok']);
    expect(CLOUD_VIDEO_GEN_MODES).toEqual(['grok']);
    expect(Object.isFrozen(VIDEO_GEN_MODE)).toBe(true);
  });
});

describe('isVideoModeUsable', () => {
  it('gates grok on the shared imageGen.grok.enabled toggle', () => {
    expect(isVideoModeUsable({ imageGen: { grok: { enabled: true } } }, 'grok')).toBe(true);
    expect(isVideoModeUsable({ imageGen: { grok: { enabled: false } } }, 'grok')).toBe(false);
    // Strict boolean — a truthy non-true value is not an opt-in.
    expect(isVideoModeUsable({ imageGen: { grok: { enabled: 'yes' } } }, 'grok')).toBe(false);
    expect(isVideoModeUsable({}, 'grok')).toBe(false);
    expect(isVideoModeUsable(null, 'grok')).toBe(false);
  });

  it('always accepts local and rejects anything else', () => {
    expect(isVideoModeUsable(null, 'local')).toBe(true);
    expect(isVideoModeUsable({}, 'codex')).toBe(false);
    expect(isVideoModeUsable({}, 'external')).toBe(false);
    expect(isVideoModeUsable({}, undefined)).toBe(false);
  });
});

describe('resolveVideoMode', () => {
  const grokOn = { imageGen: { grok: { enabled: true } } };

  it('honors a usable request', () => {
    expect(resolveVideoMode('grok', grokOn)).toBe('grok');
    expect(resolveVideoMode('local', grokOn)).toBe('local');
  });

  it('falls back to local for an absent, unknown, or unusable request', () => {
    expect(resolveVideoMode(null, grokOn)).toBe('local');
    expect(resolveVideoMode('hologram', grokOn)).toBe('local');
    expect(resolveVideoMode('grok', { imageGen: { grok: { enabled: false } } })).toBe('local');
  });

  it('does NOT upgrade an unpinned render to grok just because grok is enabled', () => {
    // Deliberate divergence from the image ladder (which prefers an enabled cloud
    // backend): grok video spends remote quota and only delivers 6s/10s clips, so
    // enabling it for IMAGES must not silently redirect every video render to it.
    expect(resolveVideoMode(undefined, grokOn)).toBe('local');
  });
});
