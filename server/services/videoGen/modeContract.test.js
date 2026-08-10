import { describe, it, expect } from 'vitest';
import {
  videoModeContractError,
  videoChainUnsupportedError,
  VIDEO_MODE_GATED_RUNTIMES,
  MINIMAX_H3_MODES,
} from './modeContract.js';

// Fake registry entries — never a real install's media-models.json.
const wan = (supportedModes) => ({ runtime: 'wan22', name: 'Example Wan Profile', supportedModes });
const h3 = (supportedModes) => ({ runtime: 'minimax_h3', name: 'Example H3', supportedModes });

describe('videoModeContractError — shared gate', () => {
  it('gates exactly the runtimes that declare a contract row', () => {
    expect([...VIDEO_MODE_GATED_RUNTIMES].sort()).toEqual(['minimax_h3', 'wan22']);
  });

  it.each(['ltx2', 'mlx_video', 'hunyuan', undefined])('leaves the %s runtime ungated', (runtime) => {
    expect(videoModeContractError({
      model: { runtime, name: 'Example Model' }, mode: 'extend', hasFirstImage: true,
    })).toBeNull();
  });

  it('returns null for a missing model rather than throwing', () => {
    expect(videoModeContractError({ model: null, mode: 'image' })).toBeNull();
  });

  it('resolves an unset mode from the presence of a first image', () => {
    // t2v-only profile + an image ⇒ the request really asked for i2v.
    expect(videoModeContractError({ model: wan(['text']), hasFirstImage: true }))
      .toMatchObject({ status: 400, code: 'WAN22_MODE_UNSUPPORTED' });
    expect(videoModeContractError({ model: wan(['text']), hasFirstImage: false })).toBeNull();
  });
});

describe('videoModeContractError — wan22 codes and messages', () => {
  it('rejects a mode the profile does not declare', () => {
    const err = videoModeContractError({ model: wan(['text']), mode: 'image', hasFirstImage: true });
    expect(err).toMatchObject({ status: 400, code: 'WAN22_MODE_UNSUPPORTED' });
    expect(err.message).toContain('Example Wan Profile does not support image-to-video');
  });

  // #3737: an entry that declares nothing resolves its runtime's modes rather
  // than declaring nothing — otherwise the server rejects in every mode while
  // the picker (which resolves the same table) offers the model in two.
  it('resolves an entry with no declared supportedModes from its runtime', () => {
    expect(videoModeContractError({ model: wan(undefined), mode: 'text' })).toBeNull();
    expect(videoModeContractError({ model: wan(undefined), mode: 'fflf' }))
      .toMatchObject({ code: 'WAN22_MODE_UNSUPPORTED' });
  });

  it('rejects text mode carrying a source image', () => {
    expect(videoModeContractError({ model: wan(['text', 'image']), mode: 'text', hasFirstImage: true }))
      .toMatchObject({ code: 'WAN22_TEXT_MODE_SOURCE_CONFLICT' });
  });

  it('phrases the missing-source message for the boundary that asked', () => {
    const staged = videoModeContractError({ model: wan(['image']), mode: 'image' });
    expect(staged).toMatchObject({ code: 'WAN22_I2V_REQUIRES_IMAGE' });
    expect(staged.message).toContain('upload one before running this model');
    // Past resolution the caller may already have supplied a gallery pick that
    // didn't resolve, so "upload one" alone would be misleading advice.
    const resolved = videoModeContractError({ model: wan(['image']), mode: 'image', sourceResolved: true });
    expect(resolved).toMatchObject({ code: 'WAN22_I2V_REQUIRES_IMAGE' });
    expect(resolved.message).toContain('choose an existing gallery image or upload one');
  });

  it('keeps a profile that never declares fflf indifferent to a stray last frame', () => {
    expect(videoModeContractError({
      model: wan(['text', 'image']), mode: 'image', hasFirstImage: true, hasLastImage: true,
    })).toBeNull();
  });

  it('ignores conditioning channels the wan lane rejects by runtime elsewhere', () => {
    expect(videoModeContractError({
      model: wan(['image']), mode: 'image', hasFirstImage: true,
      keyframes: [{ path: '/mock/a.png', index: 0 }], audioFile: '/mock/a.wav',
    })).toBeNull();
  });
});

describe('videoModeContractError — minimax_h3 codes and messages', () => {
  it('caps a hand-widened supportedModes at the helper ceiling', () => {
    const err = videoModeContractError({ model: h3([...MINIMAX_H3_MODES, 'extend']), mode: 'extend' });
    expect(err).toMatchObject({ code: 'MINIMAX_H3_MODE_UNSUPPORTED' });
    expect(err.message).toContain('supports text, image, fflf modes only');
  });

  it('falls back to the ceiling when the entry declares no supportedModes', () => {
    expect(videoModeContractError({ model: h3(undefined), mode: 'fflf', hasFirstImage: true })).toBeNull();
  });

  it('honors a narrowed supportedModes', () => {
    const err = videoModeContractError({ model: h3(['text']), mode: 'fflf', hasFirstImage: true });
    expect(err).toMatchObject({ code: 'MINIMAX_H3_MODE_UNSUPPORTED' });
    expect(err.message).toContain('supports text modes only');
  });

  it.each([
    ['keyframes', { keyframes: [{ path: '/mock/a.png', index: 0 }] }],
    ['extend video', { extendFromVideo: '/mock/prior.mp4' }],
    ['audio file', { audioFile: '/mock/audio.wav' }],
    ['audio offset', { audioStartSec: 0 }],
    ['IC references', { icReferences: ['/mock/reference.mp4'] }],
  ])('folds %s conditioning into the mode gate', (_label, extra) => {
    expect(videoModeContractError({ model: h3(MINIMAX_H3_MODES), mode: 'text', ...extra }))
      .toMatchObject({ code: 'MINIMAX_H3_MODE_UNSUPPORTED' });
  });

  it.each([
    ['empty keyframes', { keyframes: [] }],
    ['empty IC references', { icReferences: [] }],
    ['unset audio offset', { audioStartSec: null }],
  ])('reads %s as absent, not present', (_label, extra) => {
    expect(videoModeContractError({ model: h3(MINIMAX_H3_MODES), mode: 'text', ...extra })).toBeNull();
  });

  it.each([
    [{ mode: 'text', hasFirstImage: true }, 'MINIMAX_H3_TEXT_MODE_SOURCE_CONFLICT'],
    [{ mode: 'text', hasLastImage: true }, 'MINIMAX_H3_TEXT_MODE_SOURCE_CONFLICT'],
    [{ mode: 'image' }, 'MINIMAX_H3_I2V_REQUIRES_IMAGE'],
    [{ mode: 'image', hasFirstImage: true, hasLastImage: true }, 'MINIMAX_H3_I2V_LAST_IMAGE_CONFLICT'],
    [{ mode: 'fflf' }, 'MINIMAX_H3_FFLF_REQUIRES_IMAGE'],
  ])('rejects %o with the H3-prefixed code', (fields, code) => {
    expect(videoModeContractError({ model: h3(MINIMAX_H3_MODES), ...fields }))
      .toMatchObject({ status: 400, code });
  });

  it.each([
    ['text with no images', { mode: 'text' }],
    ['image with a first frame', { mode: 'image', hasFirstImage: true }],
    ['fflf with a first frame only', { mode: 'fflf', hasFirstImage: true }],
    ['fflf with a last frame only', { mode: 'fflf', hasLastImage: true }],
    ['fflf with both frames', { mode: 'fflf', hasFirstImage: true, hasLastImage: true }],
  ])('accepts %s', (_label, fields) => {
    expect(videoModeContractError({ model: h3(MINIMAX_H3_MODES), ...fields })).toBeNull();
  });
});

describe('videoChainUnsupportedError', () => {
  it('allows a model that declares image mode, or declares nothing at all', () => {
    expect(videoChainUnsupportedError(wan(['text', 'image']))).toBeNull();
    expect(videoChainUnsupportedError({ runtime: 'ltx2', name: 'Example LTX' })).toBeNull();
  });

  it('keeps the wan-prefixed chain code and the generic one apart', () => {
    expect(videoChainUnsupportedError(wan(['text'])))
      .toMatchObject({ status: 400, code: 'WAN22_CHAIN_REQUIRES_IMAGE_MODE' });
    expect(videoChainUnsupportedError(h3(['text'])))
      .toMatchObject({ status: 400, code: 'VIDEO_CHAIN_REQUIRES_IMAGE_MODE' });
    expect(videoChainUnsupportedError({ runtime: 'mlx_video', name: 'Example Model', supportedModes: ['text'] }))
      .toMatchObject({ code: 'VIDEO_CHAIN_REQUIRES_IMAGE_MODE' });
  });
});
