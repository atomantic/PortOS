import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { RUNNER_FAMILIES, VIDEO_LORA_FAMILIES, videoLoraFamily, isMflux, isFlux2, isZImage, isErnie, isHiDream, isQwen, flux2VariantFromModel, loraCompatKey, composeCompatKey } from './runners.js';

const __dirname_self = dirname(fileURLToPath(import.meta.url));
const CLIENT_MIRROR_PATH = join(__dirname_self, '..', '..', 'client', 'src', 'lib', 'runnerFamilies.js');

describe('RUNNER_FAMILIES', () => {
  it('exports the canonical runner ids', () => {
    expect(RUNNER_FAMILIES.MFLUX).toBe('mflux');
    expect(RUNNER_FAMILIES.FLUX2).toBe('flux2');
    expect(RUNNER_FAMILIES.Z_IMAGE).toBe('z-image');
    expect(RUNNER_FAMILIES.ERNIE).toBe('ernie');
    expect(RUNNER_FAMILIES.HIDREAM).toBe('hidream');
    expect(RUNNER_FAMILIES.QWEN).toBe('qwen');
  });

  it('is frozen so callers can\'t mutate the canonical strings at runtime', () => {
    expect(Object.isFrozen(RUNNER_FAMILIES)).toBe(true);
  });

  it('client mirror at client/src/lib/runnerFamilies.js carries the same ids', () => {
    // The mirror is plain JS (not importable from a Vitest server suite —
    // Vite's fs.allow doesn't cross), so we string-grep the file. Any
    // change to a canonical id has to be reflected in both places, or this
    // test fails.
    const text = readFileSync(CLIENT_MIRROR_PATH, 'utf-8');
    expect(text).toMatch(/MFLUX:\s*'mflux'/);
    expect(text).toMatch(/FLUX2:\s*'flux2'/);
    expect(text).toMatch(/Z_IMAGE:\s*'z-image'/);
    expect(text).toMatch(/ERNIE:\s*'ernie'/);
    expect(text).toMatch(/HIDREAM:\s*'hidream'/);
    expect(text).toMatch(/QWEN:\s*'qwen'/);
  });

  it('predicate helpers match on the canonical runner ids', () => {
    expect(isMflux({ runner: 'mflux' })).toBe(true);
    expect(isFlux2({ runner: 'flux2' })).toBe(true);
    expect(isZImage({ runner: 'z-image' })).toBe(true);
    expect(isErnie({ runner: 'ernie' })).toBe(true);
    expect(isHiDream({ runner: 'hidream' })).toBe(true);
    expect(isQwen({ runner: 'qwen' })).toBe(true);
    expect(isFlux2({ runner: 'mflux' })).toBe(false);
    expect(isFlux2(null)).toBe(false);
    expect(isFlux2(undefined)).toBe(false);
  });
});

describe('VIDEO_LORA_FAMILIES / videoLoraFamily', () => {
  it('exports the canonical ltx-video family id, frozen', () => {
    expect(VIDEO_LORA_FAMILIES.LTX_VIDEO).toBe('ltx-video');
    expect(Object.isFrozen(VIDEO_LORA_FAMILIES)).toBe(true);
  });

  it('maps only the ltx2 runtime to a LoRA family', () => {
    expect(videoLoraFamily({ runtime: 'ltx2' })).toBe('ltx-video');
    expect(videoLoraFamily({ runtime: 'mlx_video' })).toBe(null);
    expect(videoLoraFamily({ runtime: 'wan22' })).toBe(null);
    expect(videoLoraFamily({ runtime: 'hunyuan' })).toBe(null);
    expect(videoLoraFamily({})).toBe(null);
    expect(videoLoraFamily(null)).toBe(null);
  });

  it('composeCompatKey leaves the ltx-video family bare (no variant)', () => {
    expect(composeCompatKey('ltx-video', null)).toBe('ltx-video');
    expect(composeCompatKey('ltx-video', '9b')).toBe('ltx-video');
  });

  it('client mirror carries the video family + helper', () => {
    const text = readFileSync(CLIENT_MIRROR_PATH, 'utf-8');
    expect(text).toMatch(/LTX_VIDEO:\s*'ltx-video'/);
    expect(text).toMatch(/export const videoLoraFamily/);
  });
});

describe('flux2VariantFromModel', () => {
  it('reads the size from the model id across all four flux2 ids', () => {
    expect(flux2VariantFromModel({ id: 'flux2-klein-4b' })).toBe('4b');
    expect(flux2VariantFromModel({ id: 'flux2-klein-9b' })).toBe('9b');
    expect(flux2VariantFromModel({ id: 'flux2-klein-4b-int8' })).toBe('4b');
    expect(flux2VariantFromModel({ id: 'flux2-klein-9b-bf16' })).toBe('9b');
  });

  it('falls back to the repo string when the id is opaque', () => {
    expect(flux2VariantFromModel({ id: 'my-custom-model', repo: 'Disty0/FLUX.2-klein-9B-SDNQ-4bit' })).toBe('9b');
    expect(flux2VariantFromModel({ id: 'x', repo: 'aydin99/FLUX.2-klein-4B-int8' })).toBe('4b');
  });

  it('returns null when neither id nor repo encodes a size', () => {
    expect(flux2VariantFromModel({ id: 'flux2-klein', repo: 'foo/bar' })).toBe(null);
    expect(flux2VariantFromModel({})).toBe(null);
    expect(flux2VariantFromModel(null)).toBe(null);
  });

  it('does not mistake unrelated "4b"/"9b" substrings for the size token', () => {
    // No delimiter boundary around the digits → not a size token.
    expect(flux2VariantFromModel({ id: 'model94bit', repo: '' })).toBe(null);
  });
});

describe('loraCompatKey', () => {
  it('refines flux2 into size-specific keys', () => {
    expect(loraCompatKey({ runner: 'flux2', id: 'flux2-klein-4b' })).toBe('flux2-4b');
    expect(loraCompatKey({ runner: 'flux2', id: 'flux2-klein-9b-bf16' })).toBe('flux2-9b');
  });

  it('falls back to bare flux2 when the size is unknown', () => {
    expect(loraCompatKey({ runner: 'flux2', id: 'flux2-klein', repo: 'foo/bar' })).toBe('flux2');
  });

  it('passes other families through as their runner id', () => {
    expect(loraCompatKey({ runner: 'z-image', id: 'z-image-turbo-bf16' })).toBe('z-image');
    expect(loraCompatKey({ runner: 'mflux', id: 'dev' })).toBe('mflux');
  });

  it('defaults a runner-less model to mflux (matches the picker default)', () => {
    expect(loraCompatKey({ id: 'dev' })).toBe('mflux');
  });

  it('client mirror carries the same helpers', () => {
    const text = readFileSync(CLIENT_MIRROR_PATH, 'utf-8');
    expect(text).toMatch(/export const flux2VariantFromModel/);
    expect(text).toMatch(/export const loraCompatKey/);
    expect(text).toMatch(/export const composeCompatKey/);
  });
});

describe('composeCompatKey', () => {
  it('encodes a flux2 size variant, leaves other cases as the bare family', () => {
    expect(composeCompatKey('flux2', '4b')).toBe('flux2-4b');
    expect(composeCompatKey('flux2', '9b')).toBe('flux2-9b');
    expect(composeCompatKey('flux2', null)).toBe('flux2');   // size unknown
    expect(composeCompatKey('mflux', '4b')).toBe('mflux');   // non-flux2 never carries a variant
    expect(composeCompatKey('z-image', null)).toBe('z-image');
    expect(composeCompatKey(null, null)).toBe(null);         // legacy LoRA, family unknown
  });

  it('is the single encoder behind both model-side and LoRA-side keys', () => {
    // loraCompatKey(model) must agree with composeCompatKey on the same pair.
    expect(loraCompatKey({ runner: 'flux2', id: 'flux2-klein-9b' }))
      .toBe(composeCompatKey('flux2', '9b'));
  });
});
