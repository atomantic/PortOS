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
    expect(VIDEO_GEN_MODES).toEqual(['local', 'grok', 'fal', 'reactor']);
    expect(CLOUD_VIDEO_GEN_MODES).toEqual(['grok', 'fal', 'reactor']);
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

  it('gates fal on a configured API key, settings or env', () => {
    expect(isVideoModeUsable({ videoGen: { fal: { apiKey: 'key' } } }, 'fal')).toBe(true);
    expect(isVideoModeUsable({ videoGen: { fal: { apiKey: '  ' } } }, 'fal')).toBe(false);
    expect(isVideoModeUsable({}, 'fal')).toBe(false);
    const prevEnv = process.env.FAL_KEY;
    process.env.FAL_KEY = 'env-key';
    expect(isVideoModeUsable({}, 'fal')).toBe(true);
    if (prevEnv === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = prevEnv;
  });

  it('gates reactor on a configured API key, settings or env', () => {
    expect(isVideoModeUsable({ videoGen: { reactor: { apiKey: 'key' } } }, 'reactor')).toBe(true);
    expect(isVideoModeUsable({ videoGen: { reactor: { apiKey: '  ' } } }, 'reactor')).toBe(false);
    expect(isVideoModeUsable({}, 'reactor')).toBe(false);
    const prevEnv = process.env.REACTOR_API_KEY;
    process.env.REACTOR_API_KEY = 'env-key';
    expect(isVideoModeUsable({}, 'reactor')).toBe(true);
    if (prevEnv === undefined) delete process.env.REACTOR_API_KEY; else process.env.REACTOR_API_KEY = prevEnv;
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

describe('resolveVideoMode — pin ladder (#3231 Phase 4)', () => {
  const grokOn = { imageGen: { grok: { enabled: true } } };
  const withPins = (extra) => ({ ...grokOn, ...extra });

  it('consults renderDefaults[target].videoMode when no request names a backend', () => {
    const settings = withPins({ renderDefaults: { 'music-video': { videoMode: 'grok' } } });
    expect(resolveVideoMode(null, settings, { target: 'music-video' })).toBe('grok');
    // A different target's pin does not leak.
    expect(resolveVideoMode(null, settings, { target: 'creative-agent' })).toBe('local');
    // No target → the target rung is skipped entirely.
    expect(resolveVideoMode(null, settings)).toBe('local');
  });

  it('consults settings.videoGen.mode after the target pin', () => {
    const settings = withPins({ videoGen: { mode: 'grok' } });
    expect(resolveVideoMode(null, settings)).toBe('grok');
    expect(resolveVideoMode(null, settings, { target: 'music-video' })).toBe('grok');
    // The target pin outranks the install pin.
    const both = withPins({
      renderDefaults: { 'music-video': { videoMode: 'local' } },
      videoGen: { mode: 'grok' },
    });
    expect(resolveVideoMode(null, both, { target: 'music-video' })).toBe('local');
  });

  it('an explicit request outranks every pin', () => {
    const settings = withPins({
      renderDefaults: { 'music-video': { videoMode: 'grok' } },
      videoGen: { mode: 'grok' },
    });
    expect(resolveVideoMode('local', settings, { target: 'music-video' })).toBe('local');
  });

  it("normalizes the 'auto' sentinel and blanks to no-pin on every rung", () => {
    expect(resolveVideoMode(null, withPins({ videoGen: { mode: 'auto' } }))).toBe('local');
    expect(resolveVideoMode(null, withPins({ videoGen: { mode: '  ' } }))).toBe('local');
    expect(resolveVideoMode(null, withPins({
      renderDefaults: { 'music-video': { videoMode: 'auto' } },
    }), { target: 'music-video' })).toBe('local');
  });

  it('usability-gates each pin rung — a disabled grok pin degrades to local', () => {
    const grokOff = { imageGen: { grok: { enabled: false } } };
    expect(resolveVideoMode(null, {
      ...grokOff,
      renderDefaults: { 'music-video': { videoMode: 'grok' } },
    }, { target: 'music-video' })).toBe('local');
    expect(resolveVideoMode(null, { ...grokOff, videoGen: { mode: 'grok' } })).toBe('local');
  });
});
