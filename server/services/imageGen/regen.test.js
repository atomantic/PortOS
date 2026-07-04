import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies resolveRegenBackend composes so the tests stay pure
// (no filesystem, no settings store, no Python probe).
vi.mock('../../lib/mediaModels.js', () => ({
  getImageModels: vi.fn(() => []),
  isFlux2: (m) => m?.runner === 'flux2',
}));
vi.mock('../../lib/runners.js', () => ({
  usesDiffusersRunner: (m) => m?.runner === 'z-image',
}));
vi.mock('../settings.js', () => ({
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../../lib/pythonSetup.js', () => ({
  isFlux2VenvHealthy: vi.fn(async () => false),
}));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false) }));
vi.mock('sharp', () => ({ default: () => ({ metadata: async () => ({}) }) }));

import { getImageModels } from '../../lib/mediaModels.js';
import { getSettings } from '../settings.js';
import { isFlux2VenvHealthy } from '../../lib/pythonSetup.js';
import { existsSync } from 'node:fs';
import {
  orderRegenCandidates, modelSupportsRegen, modelUsesFluxVenv,
  resolveRegenBackend, buildRegenParams, DEFAULT_REGEN_STRENGTH,
  REGEN_LIGHT_STRENGTH_DEFAULT, REGEN_SQUEEZE_FACTOR,
  clampRegenDimensions, resolveRegenStrengthDefault, computePixelDelta,
} from './regen.js';

const FLUX2 = { id: 'flux2-klein-9b', runner: 'flux2', cfgDisabled: true };
const ZIMAGE = { id: 'z-image-turbo', runner: 'z-image', cfgDisabled: true };
const MFLUX_DEV = { id: 'dev', runner: 'mflux', steps: 20 };

beforeEach(() => {
  vi.mocked(getImageModels).mockReturnValue([]);
  vi.mocked(getSettings).mockResolvedValue({});
  vi.mocked(isFlux2VenvHealthy).mockResolvedValue(false);
  vi.mocked(existsSync).mockReturnValue(false);
});

describe('orderRegenCandidates', () => {
  it('puts the source model first, then prefers fast (cfgDisabled) models', () => {
    const models = [MFLUX_DEV, FLUX2, ZIMAGE];
    const ordered = orderRegenCandidates(models, 'dev');
    expect(ordered[0].id).toBe('dev'); // source wins regardless of speed
    // remaining ordered fast-first
    expect(ordered.slice(1).map((m) => m.id)).toEqual(['flux2-klein-9b', 'z-image-turbo']);
  });

  it('with no source match, fast models lead', () => {
    const ordered = orderRegenCandidates([MFLUX_DEV, FLUX2], 'nonexistent');
    expect(ordered[0].id).toBe('flux2-klein-9b');
  });

  it('tolerates non-array / empty input', () => {
    expect(orderRegenCandidates(null, 'x')).toEqual([]);
    expect(orderRegenCandidates(undefined, 'x')).toEqual([]);
  });
});

describe('modelSupportsRegen / modelUsesFluxVenv', () => {
  it('flux2 + diffusers models both use the flux venv (availability detection)', () => {
    expect(modelUsesFluxVenv(FLUX2)).toBe(true);
    expect(modelUsesFluxVenv(ZIMAGE)).toBe(true);
  });

  it('only FLUX.2 (not the broader diffusers family) is regen-capable', () => {
    // FLUX.2 reliably honors --image-path; Z-Image/ERNIE/HiDream/Qwen can
    // silently fall back to txt2img (z_image_turbo.py), so excluded to keep
    // the regenerated lineage honest.
    expect(modelSupportsRegen(FLUX2)).toBe(true);
    expect(modelSupportsRegen(ZIMAGE)).toBe(false);
  });

  it('legacy mflux is not a flux-venv model', () => {
    expect(modelUsesFluxVenv(MFLUX_DEV)).toBe(false);
  });

  it('null model never supports regen', () => {
    expect(modelSupportsRegen(null)).toBe(false);
  });
});

describe('resolveRegenBackend', () => {
  it('reports unavailable when no local models are configured', async () => {
    vi.mocked(getImageModels).mockReturnValue([]);
    const r = await resolveRegenBackend();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/no local image models/i);
  });

  it('selects a flux2 model when the FLUX.2 venv is healthy', async () => {
    vi.mocked(getImageModels).mockReturnValue([FLUX2]);
    vi.mocked(isFlux2VenvHealthy).mockResolvedValue(true);
    const r = await resolveRegenBackend();
    expect(r.available).toBe(true);
    expect(r.model.id).toBe('flux2-klein-9b');
  });

  it('reports unavailable with an install hint when no runner is installed', async () => {
    vi.mocked(getImageModels).mockReturnValue([FLUX2]);
    vi.mocked(isFlux2VenvHealthy).mockResolvedValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
    const r = await resolveRegenBackend();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/no local flux runner is installed/i);
  });

  it('prefers the source model when it is regen-capable and runnable', async () => {
    const FLUX2_DEV = { id: 'flux2-dev', runner: 'flux2', cfgDisabled: false };
    vi.mocked(getImageModels).mockReturnValue([FLUX2, FLUX2_DEV]);
    vi.mocked(isFlux2VenvHealthy).mockResolvedValue(true);
    const r = await resolveRegenBackend({ sourceModelId: 'flux2-dev' });
    expect(r.available).toBe(true);
    expect(r.model.id).toBe('flux2-dev');
  });

  it('skips a regen-incapable source model (diffusers) and falls to FLUX.2', async () => {
    vi.mocked(getImageModels).mockReturnValue([ZIMAGE, FLUX2]);
    vi.mocked(isFlux2VenvHealthy).mockResolvedValue(true);
    const r = await resolveRegenBackend({ sourceModelId: 'z-image-turbo' });
    expect(r.available).toBe(true);
    expect(r.model.id).toBe('flux2-klein-9b');
  });

  it('reports unavailable when only regen-incapable diffusers models exist', async () => {
    vi.mocked(getImageModels).mockReturnValue([ZIMAGE]);
    vi.mocked(isFlux2VenvHealthy).mockResolvedValue(true);
    const r = await resolveRegenBackend();
    expect(r.available).toBe(false);
  });
});

describe('buildRegenParams', () => {
  const base = {
    filename: 'source.png',
    sourceAbsPath: '/data/images/source.png',
    model: FLUX2,
    pythonPath: null,
    strength: DEFAULT_REGEN_STRENGTH,
  };

  it('assembles a minimal-mutation (empty-prompt) local img2img job by default', () => {
    const params = buildRegenParams({
      ...base,
      sourceMeta: { prompt: 'a neon city', negativePrompt: 'blurry', width: 1024, height: 768, modelId: 'flux2-klein-9b' },
    });
    expect(params).toMatchObject({
      mode: 'local',
      modelId: 'flux2-klein-9b',
      // Empty prompt by default — the init image conditions the render, not text.
      prompt: '',
      negativePrompt: '',
      initImagePath: '/data/images/source.png',
      initImageStrength: DEFAULT_REGEN_STRENGTH,
      regenOf: 'source.png',
    });
    // Universal resize-squeeze: even an under-budget /16 image renders smaller
    // and is upscaled back to the source dims (the SynthID carrier-disruption pass).
    expect(params.width).toBeLessThan(1024);
    expect(params.height).toBeLessThan(768);
    expect(params.upscaleTo).toEqual({ width: 1024, height: 768 });
  });

  it('honors an explicit promptOverride (creative re-roll) and carries the source negative', () => {
    const params = buildRegenParams({
      ...base,
      promptOverride: 'a neon city',
      sourceMeta: { prompt: 'ignored', negativePrompt: 'blurry', width: 1024, height: 768 },
    });
    expect(params.prompt).toBe('a neon city');
    expect(params.negativePrompt).toBe('blurry');
  });

  it('anchors regenOf at the root original when regenerating a cleaned variant', () => {
    // Regen of `a_clean-aggressive.png` (cleanedFrom: a.png) must group under
    // a.png, not orphan under the clicked variant. Pixels still come from the
    // clicked image (initImagePath stays sourceAbsPath).
    const params = buildRegenParams({
      filename: 'a_clean-aggressive.png',
      sourceAbsPath: '/data/images/a_clean-aggressive.png',
      sourceMeta: { prompt: 'x', cleanedFrom: 'a.png' },
      model: FLUX2,
      pythonPath: null,
      strength: 0.4,
    });
    expect(params.regenOf).toBe('a.png');
    expect(params.initImagePath).toBe('/data/images/a_clean-aggressive.png');
  });

  it('uses the clicked filename as regenOf when regenerating an original', () => {
    const params = buildRegenParams({ ...base, sourceMeta: { prompt: 'x' } });
    expect(params.regenOf).toBe('source.png');
  });

  it('prefers measured sourceDims over the sidecar dimensions', () => {
    const params = buildRegenParams({
      ...base,
      sourceMeta: { prompt: 'x', width: 100, height: 100 },
      sourceDims: { width: 1280, height: 720 },
    });
    // The render is squeezed, but it's delivered back at the MEASURED 1280x720
    // (not the bogus 100x100 sidecar) — proving measured dims won.
    expect(params.upscaleTo).toEqual({ width: 1280, height: 720 });
    expect(params.width).toBeLessThan(1280);
    expect(params.width).toBeGreaterThan(1280 * 0.8);
  });

  it('keeps the prompt empty even when the source has one (minimal mutation)', () => {
    const params = buildRegenParams({ ...base, sourceMeta: { prompt: 'a detailed castle' } });
    expect(params.prompt).toBe('');
    expect(params.negativePrompt).toBe('');
  });

  it('omits width/height when neither dims source is available', () => {
    const params = buildRegenParams({ ...base, sourceMeta: {} });
    expect(params.width).toBeUndefined();
    expect(params.height).toBeUndefined();
    expect(params.upscaleTo).toBeUndefined();
  });

  it('includes steps only when provided', () => {
    expect(buildRegenParams({ ...base, sourceMeta: { prompt: 'x' } }).steps).toBeUndefined();
    expect(buildRegenParams({ ...base, sourceMeta: { prompt: 'x' }, steps: 6 }).steps).toBe(6);
  });

  it('clamps a large source to the MP budget and sets upscaleTo to the exact source dims', () => {
    // 4096x3072 = 12.6MP — far over the ~2MP FLUX budget.
    const params = buildRegenParams({ ...base, sourceDims: { width: 4096, height: 3072 } });
    expect(params.width * params.height).toBeLessThanOrEqual(2_000_000);
    expect(params.width % 16).toBe(0);
    expect(params.height % 16).toBe(0);
    // aspect ratio preserved (4:3) within rounding tolerance
    expect(Math.abs(params.width / params.height - 4096 / 3072)).toBeLessThan(0.05);
    // delivered back at the original resolution
    expect(params.upscaleTo).toEqual({ width: 4096, height: 3072 });
  });

  it('upscales back when an under-budget source is not a multiple of 16', () => {
    // 1024x1000 = 1.02MP (under budget) but 1000 isn't /16 → render rounds to
    // /16, so deliver back at the exact 1024x1000.
    const params = buildRegenParams({ ...base, sourceDims: { width: 1024, height: 1000 } });
    expect(params.width % 16).toBe(0);
    expect(params.height % 16).toBe(0);
    expect(params.upscaleTo).toEqual({ width: 1024, height: 1000 });
  });

  it('annotation re-render seeds initImagePath from the sketch PNG while keeping source lineage', () => {
    // Issue #2036 phase 2: the img2img base is the flattened source+strokes PNG,
    // but dimensions/lineage still come from the original source (regenOf).
    const params = buildRegenParams({
      ...base,
      sourceMeta: { prompt: 'x', width: 1024, height: 768 },
      initImageAbsPath: '/data/media-sketches/abc.png',
      annotated: true,
    });
    expect(params.initImagePath).toBe('/data/media-sketches/abc.png');
    expect(params.regenOf).toBe('source.png');
    expect(params.annotatedRegen).toBe(true);
  });

  it('leaves initImagePath at the source and omits annotatedRegen for a normal regen', () => {
    const params = buildRegenParams({ ...base, sourceMeta: { prompt: 'x' } });
    expect(params.initImagePath).toBe('/data/images/source.png');
    expect(params.annotatedRegen).toBeUndefined();
  });
});

describe('clampRegenDimensions', () => {
  it('applies the universal resize-squeeze to an under-budget /16 image', () => {
    // Even though 1024x1536 is ≤2MP and /16, the deliberate squeeze shifts the
    // resolution (disrupting SynthID's resolution-dependent carriers) and flags
    // scaled so the caller upscales back to the exact source dims.
    const r = clampRegenDimensions(1024, 1536);
    expect(r.scaled).toBe(true);
    expect(r.width).toBeLessThan(1024);
    expect(r.height).toBeLessThan(1536);
    expect(r.width % 16).toBe(0);
    expect(r.height % 16).toBe(0);
    // Stays close to the source (≈ REGEN_SQUEEZE_FACTOR), not a drastic downscale.
    expect(r.width).toBeGreaterThan(1024 * REGEN_SQUEEZE_FACTOR - 16);
  });

  it('downscales a 12.6MP image under the 2MP budget, /16, aspect-preserved', () => {
    const r = clampRegenDimensions(4096, 3072, 2.0);
    expect(r.scaled).toBe(true);
    expect(r.width * r.height).toBeLessThanOrEqual(2_000_000);
    expect(r.width % 16).toBe(0);
    expect(r.height % 16).toBe(0);
    expect(Math.abs(r.width / r.height - 4096 / 3072)).toBeLessThan(0.05);
  });

  it('rounds a non-/16 source to /16 and flags scaled', () => {
    const r = clampRegenDimensions(1000, 1000, 9.0); // under budget but not /16
    expect(r.width % 16).toBe(0);
    expect(r.height % 16).toBe(0);
    expect(r.scaled).toBe(true);
  });

  it('respects a custom (larger) megapixel budget', () => {
    // 4MP budget keeps a 4096x... source closer to native.
    const small = clampRegenDimensions(4096, 3072, 2.0);
    const big = clampRegenDimensions(4096, 3072, 8.0);
    expect(big.width).toBeGreaterThan(small.width);
  });

  it('falls back to 1024x1024 for garbage dims', () => {
    expect(clampRegenDimensions(0, 500)).toEqual({ width: 1024, height: 1024, scaled: false });
    expect(clampRegenDimensions(NaN, NaN)).toEqual({ width: 1024, height: 1024, scaled: false });
  });
});

describe('resolveRegenStrengthDefault', () => {
  it('keeps the known-good 0.25 for SynthID-bearing codex sources', () => {
    expect(resolveRegenStrengthDefault({ mode: 'codex', model: 'gpt-image-2' })).toBe(DEFAULT_REGEN_STRENGTH);
  });

  it('keeps 0.25 for gemini / imagen / nano-banana sources by model id', () => {
    expect(resolveRegenStrengthDefault({ modelId: 'gemini-2.5-flash-image' })).toBe(DEFAULT_REGEN_STRENGTH);
    expect(resolveRegenStrengthDefault({ modelId: 'imagen-3' })).toBe(DEFAULT_REGEN_STRENGTH);
    expect(resolveRegenStrengthDefault({ modelId: 'nano-banana-pro' })).toBe(DEFAULT_REGEN_STRENGTH);
  });

  it('uses the lighter default for local FLUX sources (no Google watermark)', () => {
    expect(resolveRegenStrengthDefault({ modelId: 'flux2-klein-9b' })).toBe(REGEN_LIGHT_STRENGTH_DEFAULT);
    expect(resolveRegenStrengthDefault({ mode: 'local', modelId: 'dev' })).toBe(REGEN_LIGHT_STRENGTH_DEFAULT);
  });

  it('falls back to the conservative 0.25 for unidentified sources', () => {
    expect(resolveRegenStrengthDefault({})).toBe(DEFAULT_REGEN_STRENGTH);
    expect(resolveRegenStrengthDefault({ mode: 'external' })).toBe(DEFAULT_REGEN_STRENGTH);
    expect(resolveRegenStrengthDefault(null)).toBe(DEFAULT_REGEN_STRENGTH);
  });
});
