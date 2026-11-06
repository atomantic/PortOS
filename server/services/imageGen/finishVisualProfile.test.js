import { beforeEach, expect, it, vi } from 'vitest';
import { naturalUniverseVisualProfile } from '../../lib/universeVisualProfile.js';
import { finishVisualProfileImage } from './finishVisualProfile.js';

const effects = vi.hoisted(() => ({ save: vi.fn(), bake: vi.fn() }));
vi.mock('./local.js', () => ({
  assertGalleryFilename: vi.fn(),
  fillImageSidecarFields: effects.save,
  readImageSidecar: async () => ({ metadata: {} }),
}));
vi.mock('./sidecarStore.js', () => ({ editImageSidecar: async (_filename, mutate) => mutate({ prompt: 'Example' }) }));
vi.mock('./filmLookBake.js', () => ({ applyFilmLookBake: effects.bake }));
beforeEach(() => {
  vi.clearAllMocks();
  effects.bake.mockResolvedValue({ filename: 'graded.png' });
});

it.each([true, false])('saves generation provenance and applies film finishing only when allowed: %s', async applyFilmFinish => {
  const profile = naturalUniverseVisualProfile();
  profile.finishing.mode = 'save';
  const result = await finishVisualProfileImage({ result: { filename: 'source.png' }, profile,
    applyFilmFinish, signal: new AbortController().signal });
  expect(result.filename).toBe('source.png');
  expect(result.visualProfile.generation).toEqual(profile.generation);
  expect(result.visualProfile.finishing.mode).toBe(applyFilmFinish ? 'save' : 'off');
  expect(profile.finishing.mode).toBe('save');
  expect(effects.save).toHaveBeenCalledTimes(applyFilmFinish ? 1 : 0);
  expect(effects.bake).toHaveBeenCalledTimes(applyFilmFinish ? 1 : 0);
  expect(result.finishedVariant).toEqual(applyFilmFinish ? { filename: 'graded.png' } : undefined);
});
