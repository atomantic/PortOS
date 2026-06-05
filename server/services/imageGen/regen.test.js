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

  it('assembles a local img2img job from the source prompt + dims + regenOf', () => {
    const params = buildRegenParams({
      ...base,
      sourceMeta: { prompt: 'a neon city', negativePrompt: 'blurry', width: 1024, height: 768, modelId: 'flux2-klein-9b' },
    });
    expect(params).toMatchObject({
      mode: 'local',
      modelId: 'flux2-klein-9b',
      prompt: 'a neon city',
      negativePrompt: 'blurry',
      initImagePath: '/data/images/source.png',
      initImageStrength: 0.4,
      regenOf: 'source.png',
      width: 1024,
      height: 768,
    });
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
    expect(params.width).toBe(1280);
    expect(params.height).toBe(720);
  });

  it('falls back to a generic prompt when the source has none', () => {
    const params = buildRegenParams({ ...base, sourceMeta: {} });
    expect(params.prompt).toMatch(/high quality/i);
    expect(params.negativePrompt).toBe('');
  });

  it('omits width/height when neither dims source is available', () => {
    const params = buildRegenParams({ ...base, sourceMeta: { prompt: 'x' } });
    expect(params.width).toBeUndefined();
    expect(params.height).toBeUndefined();
  });

  it('includes steps only when provided', () => {
    expect(buildRegenParams({ ...base, sourceMeta: { prompt: 'x' } }).steps).toBeUndefined();
    expect(buildRegenParams({ ...base, sourceMeta: { prompt: 'x' }, steps: 6 }).steps).toBe(6);
  });
});
