import { describe, it, expect } from 'vitest';
import {
  videoModelMemoryGb, computeFflfSafeFrames, isModelAllowedForMode,
  VIDEO_EDGE_BOUNDS, videoEdgeBoundsForModel, FRAME_OPTIONS, FPS_OPTIONS,
  WAN_FRAME_OPTIONS, frameOptionsForModel, fpsOptionsForModel,
  normalizeFramesForModel, normalizeFpsForModel,
  supportsVideoAudioControls, supportsVideoAudioPromptControls,
  IC_LORA_MODES, IC_LORA_MODE_VALUES, isIcLoraMode, icLoraSpecForMode,
  icResolutionIssue,
} from './videoGenParams.js';

describe('videoModelMemoryGb', () => {
  it('prefers an explicit positive memoryGb field', () => {
    expect(videoModelMemoryGb({ memoryGb: 24, name: '~48 GB' })).toBe(24);
  });
  it('falls back to a "~NN GB" hint in the name', () => {
    expect(videoModelMemoryGb({ name: 'LTX 2.3 (~12.5 GB)' })).toBe(12.5);
    expect(videoModelMemoryGb({ name: 'Wan 2.2 (~17 GiB)' })).toBe(17);
  });
  it('returns +Infinity when neither is present so it never spuriously fits a budget', () => {
    expect(videoModelMemoryGb({ name: 'mystery model' })).toBe(Number.POSITIVE_INFINITY);
    expect(videoModelMemoryGb(null)).toBe(Number.POSITIVE_INFINITY);
  });
  it('ignores a non-positive memoryGb and falls through', () => {
    expect(videoModelMemoryGb({ memoryGb: 0, name: '~8 GB' })).toBe(8);
  });
});

describe('computeFflfSafeFrames', () => {
  it('returns numFrames unchanged when it already fits the budget', () => {
    expect(computeFflfSafeFrames(768, 512, 121, 768 * 512 * 200)).toBe(121);
  });
  it('is fail-open (returns numFrames) when the budget is unknown', () => {
    expect(computeFflfSafeFrames(768, 512, 121, undefined)).toBe(121);
    expect(computeFflfSafeFrames(768, 512, 121, 0)).toBe(121);
  });
  it('clamps down to the LTX 8k+1 latent boundary when over budget', () => {
    // budget fits ~50 pixel-frames → safeLatent = floor((50-1)/8)=6 → 6*8+1=49
    const budget = 768 * 512 * 50;
    const out = computeFflfSafeFrames(768, 512, 121, budget);
    expect(out).toBe(49);
    expect((out - 1) % 8).toBe(0);
    expect(out).toBeLessThan(121);
  });
  it('returns numFrames for degenerate (0) dimensions', () => {
    expect(computeFflfSafeFrames(0, 512, 121, 1000)).toBe(121);
  });
});

describe('isModelAllowedForMode', () => {
  it('rejects a null model', () => {
    expect(isModelAllowedForMode(null, 'text')).toBe(false);
  });
  it('allows general runtimes for the modes their entry resolves', () => {
    // The server resolves supportedModes onto EVERY entry at load
    // (server/lib/videoModeProfiles.js) — these are the mlx_video / ltx2 rows.
    const mlx = { runtime: 'mlx_video', supportedModes: ['text', 'image', 'fflf', 'extend'] };
    const ltx2 = { runtime: 'ltx2', supportedModes: ['text', 'image', 'fflf', 'extend'] };
    expect(isModelAllowedForMode(mlx, 'text')).toBe(true);
    expect(isModelAllowedForMode(ltx2, 'image')).toBe(true);
  });
  it('rejects every mode for a model that resolved no supportedModes (#3737)', () => {
    // "Declares nothing" used to mean "supports everything", which offered FFLF
    // on runtimes that silently drop the second keyframe. Post-backfill an
    // absent list can only mean a payload that never came from the registry.
    expect(isModelAllowedForMode({ runtime: 'mlx_video' }, 'text')).toBe(false);
    expect(isModelAllowedForMode({ runtime: 'mlx_video', supportedModes: [] }, 'text')).toBe(false);
  });
  it('filters Wan models by their declared text/image capabilities', () => {
    const ti2v = { runtime: 'wan22', supportedModes: ['text', 'image'] };
    const i2v = { runtime: 'wan22', supportedModes: ['image'] };
    expect(isModelAllowedForMode(ti2v, 'text')).toBe(true);
    expect(isModelAllowedForMode(ti2v, 'image')).toBe(true);
    expect(isModelAllowedForMode(i2v, 'text')).toBe(false);
    expect(isModelAllowedForMode(i2v, 'image')).toBe(true);
    expect(isModelAllowedForMode(ti2v, 'fflf')).toBe(false);
  });
  it('filters any model with an explicit supportedModes contract', () => {
    const h3 = { runtime: 'minimax_h3', supportedModes: ['text'] };
    expect(isModelAllowedForMode(h3, 'text')).toBe(true);
    expect(isModelAllowedForMode(h3, 'image')).toBe(false);
    expect(isModelAllowedForMode(h3, 'fflf')).toBe(false);
  });
  it('requires the ltx2 runtime for a2v', () => {
    expect(isModelAllowedForMode({ runtime: 'ltx2' }, 'a2v')).toBe(true);
    expect(isModelAllowedForMode({ runtime: 'mlx_video' }, 'a2v')).toBe(false);
  });
});

describe('constants', () => {
  it('VIDEO_EDGE_BOUNDS mirrors the server 64..2048 grid', () => {
    expect(VIDEO_EDGE_BOUNDS).toEqual({ min: 64, max: 2048, step: 64 });
    expect(videoEdgeBoundsForModel({ resolutionStep: 32 })).toEqual({ min: 64, max: 2048, step: 32 });
    expect(videoEdgeBoundsForModel({ resolutionStep: 0 })).toEqual(VIDEO_EDGE_BOUNDS);
  });
  it('frame/fps option lists are on the expected boundaries', () => {
    expect(FRAME_OPTIONS[0]).toBe(25);
    expect(FRAME_OPTIONS.every((f) => (f - 1) % 8 === 0)).toBe(true);
    expect(FPS_OPTIONS).toEqual([16, 24, 30]);
    expect(WAN_FRAME_OPTIONS.every((f) => (f - 1) % 4 === 0)).toBe(true);
  });
  it('selects and normalizes model-aware Wan frame/fps values', () => {
    const wan = { frameStride: 4, fpsOptions: [16, 20, 24] };
    expect(frameOptionsForModel(wan)).toBe(WAN_FRAME_OPTIONS);
    expect(fpsOptionsForModel(wan)).toEqual([16, 20, 24]);
    expect(normalizeFramesForModel(97, wan)).toBe(97);
    expect(normalizeFramesForModel(109, wan)).toBe(109);
    expect(frameOptionsForModel(wan, 109)).toContain(109);
    expect(normalizeFramesForModel(98, wan)).toBe(97);
    expect(normalizeFpsForModel(30, wan)).toBe(24);
  });
  it('uses an explicit model frame list and fixed fps for MiniMax H3', () => {
    const h3 = { frameOptions: [124, 141, 158], fpsOptions: [24] };
    expect(frameOptionsForModel(h3)).toEqual([124, 141, 158]);
    expect(frameOptionsForModel(h3, 175)).toEqual([124, 141, 158]);
    expect(normalizeFramesForModel(140, h3)).toBe(141);
    expect(normalizeFpsForModel(30, h3)).toBe(24);
  });
  it('keeps muting separate from prompt-audio steering', () => {
    expect(supportsVideoAudioControls({ runtime: 'mlx_video' })).toBe(true);
    expect(supportsVideoAudioControls({ supportsDisableAudio: false })).toBe(false);
    expect(supportsVideoAudioPromptControls({ supportsDisableAudio: false })).toBe(true);
    expect(supportsVideoAudioPromptControls({ supportsAudioPrompting: false })).toBe(false);
  });
});

describe('IC-LoRA remix modes (#3100)', () => {
  it('mirrors the server registry shape', () => {
    expect(IC_LORA_MODE_VALUES).toEqual(['ic-control', 'ic-colorize', 'ic-ingredients']);
    for (const spec of IC_LORA_MODES) {
      // The `ic-` prefix drives the download-id router in useModelDownloadStatus.
      expect(spec.mode.startsWith('ic-')).toBe(true);
      expect(spec.maxReferences).toBeGreaterThanOrEqual(spec.minReferences);
      expect(spec.referenceDownscaleFactor).toBeGreaterThanOrEqual(1);
      // The panel renders these two directly — an empty one ships blank copy.
      expect(spec.uploadLabel).toBeTruthy();
      expect(spec.description).toBeTruthy();
      // Drives which input surface the panel renders (single clip vs the 2-8
      // gallery row list), so an unrecognized value would render nothing.
      expect(['video', 'image']).toContain(spec.referenceKind);
    }
  });

  it('mirrors the Ingredients bounds + image kind (#3112)', () => {
    // The 2-8 count is the weight's contract, mirrored here so the form blocks
    // before a POST the route would reject; the parity test in
    // server/lib/icLoraWeights.parity.test.js is what keeps the two in step.
    const ing = icLoraSpecForMode('ic-ingredients');
    expect(ing.minReferences).toBe(2);
    expect(ing.maxReferences).toBe(8);
    expect(ing.referenceKind).toBe('image');
    // Factor 1 → no divisibility rule at all, so an odd resolution is legal.
    expect(icResolutionIssue(ing, 705, 449)).toBeNull();
  });
  it('identifies IC modes', () => {
    expect(isIcLoraMode('ic-control')).toBe(true);
    expect(isIcLoraMode('ic-colorize')).toBe(true);
    expect(isIcLoraMode('text')).toBe(false);
    expect(isIcLoraMode(undefined)).toBe(false);
  });
  it('resolves a spec by mode, null otherwise', () => {
    expect(icLoraSpecForMode('ic-control')?.label).toBe('Control');
    expect(icLoraSpecForMode('ic-colorize')?.label).toBe('Colorize');
    expect(icLoraSpecForMode('extend')).toBeNull();
  });
  it('requires the ltx2 runtime for IC modes', () => {
    for (const mode of IC_LORA_MODE_VALUES) {
      expect(isModelAllowedForMode({ runtime: 'ltx2' }, mode)).toBe(true);
      expect(isModelAllowedForMode({ runtime: 'mlx_video' }, mode)).toBe(false);
      expect(isModelAllowedForMode({ runtime: 'wan22' }, mode)).toBe(false);
    }
  });
  it('keeps each mode on its own resolution rule (Control 2, Colorize 1)', () => {
    // Mirrors server/lib/icLoraWeights.js, where each factor is READ from that
    // weight's safetensors metadata — a drift here would let the form accept a
    // resolution the server rejects with IC_LORA_RESOLUTION_NOT_DIVISIBLE, or
    // reject one the server would happily render.
    expect(icLoraSpecForMode('ic-control').referenceDownscaleFactor).toBe(2);
    expect(icLoraSpecForMode('ic-colorize').referenceDownscaleFactor).toBe(1);
  });
  it('gives each mode a distinct upload label so the panel reads correctly', () => {
    // The panel is fully spec-driven; a shared label would tell a Colorize user
    // to upload a depth/pose clip.
    const labels = IC_LORA_MODES.map((m) => m.uploadLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(icLoraSpecForMode('ic-colorize').uploadLabel).toMatch(/B&W/);
  });
});
// @vitest-environment node
