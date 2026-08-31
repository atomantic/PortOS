import { describe, it, expect } from 'vitest';
import {
  VIDEO_BASE_MODES,
  VIDEO_RUNTIME_MODES,
  resolveVideoSupportedModes,
  applyVideoSupportedModes,
} from './videoModeProfiles.js';

describe('VIDEO_RUNTIME_MODES', () => {
  it('only enumerates known semantic modes', () => {
    const knownModes = [...VIDEO_BASE_MODES, 'a2v'];
    for (const [runtime, modes] of Object.entries(VIDEO_RUNTIME_MODES)) {
      expect(modes.length, runtime).toBeGreaterThan(0);
      for (const mode of modes) expect(knownModes, `${runtime}/${mode}`).toContain(mode);
    }
  });

  it('keeps preserved Hunyuan records text-only even though the runtime is retired', () => {
    expect(VIDEO_RUNTIME_MODES.hunyuan).toEqual(['text']);
  });

  it('declares fflf on every runtime that can be handed a last frame', () => {
    // mlx_video's FFLF is degraded (one --image), NOT absent — the caveat rides
    // on lastFrameAnchored: false, so the mode still has to be offerable.
    expect(VIDEO_RUNTIME_MODES.mlx_video).toContain('fflf');
    expect(VIDEO_RUNTIME_MODES.ltx2).toContain('fflf');
    expect(VIDEO_RUNTIME_MODES.ltx25).toEqual(VIDEO_RUNTIME_MODES.ltx2);
    expect(VIDEO_RUNTIME_MODES.minimax_h3).toContain('fflf');
    expect(VIDEO_RUNTIME_MODES.wan22).not.toContain('fflf');
  });

  it('declares audio-only semantics for MiniMax H3 Ref2VA', () => {
    expect(VIDEO_RUNTIME_MODES.minimax_h3_ref2va).toEqual(['a2v']);
  });

  it('declares A2V on both pinned LTX runtime generations', () => {
    expect(VIDEO_RUNTIME_MODES.ltx2).toContain('a2v');
    expect(VIDEO_RUNTIME_MODES.ltx25).toContain('a2v');
  });
});

describe('resolveVideoSupportedModes', () => {
  it('prefers a declared non-empty list over the runtime table', () => {
    expect(resolveVideoSupportedModes({ runtime: 'mlx_video', supportedModes: ['text'] })).toEqual(['text']);
  });

  it('treats an absent, non-array or empty list as "not declared"', () => {
    for (const supportedModes of [undefined, null, [], 'text']) {
      expect(resolveVideoSupportedModes({ runtime: 'wan22', supportedModes })).toEqual(['text', 'image']);
    }
  });

  it('falls back to the full base set for an unknown runtime', () => {
    expect(resolveVideoSupportedModes({ runtime: 'some-future-runtime' })).toEqual(VIDEO_BASE_MODES);
    expect(resolveVideoSupportedModes({})).toEqual(VIDEO_BASE_MODES);
  });
});

describe('applyVideoSupportedModes', () => {
  it('resolves a list for every entry without mutating the inputs', () => {
    const entries = [
      { id: 'a', runtime: 'some-future-runtime' },
      { id: 'b', runtime: 'wan22', supportedModes: ['image'] },
      { id: 'c', runtime: 'ltx2' },
    ];
    const out = applyVideoSupportedModes(entries);
    expect(out.map((e) => e.supportedModes)).toEqual([
      ['text', 'image', 'fflf', 'extend'],
      ['image'],
      ['text', 'image', 'fflf', 'extend', 'a2v'],
    ]);
    expect(entries[0].supportedModes).toBeUndefined();
  });

  it('hands back a copy, never the frozen shared table', () => {
    const [entry] = applyVideoSupportedModes([{ id: 'a', runtime: 'wan22' }]);
    expect(entry.supportedModes).not.toBe(VIDEO_RUNTIME_MODES.wan22);
  });

  it('passes through non-entries and a non-array list', () => {
    expect(applyVideoSupportedModes(null)).toBeNull();
    expect(applyVideoSupportedModes([null, 'nope'])).toEqual([null, 'nope']);
  });
});
