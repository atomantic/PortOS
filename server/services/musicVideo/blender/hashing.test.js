import { describe, expect, it } from 'vitest';
import { MUSIC_VIDEO_BLENDER_DEFAULT_SETTINGS as DEFAULTS } from '../../../lib/musicVideoBlender.js';
import { blenderSettingsHash, blenderShotHash } from './hashing.js';

const files = (entries) => new Map(Object.entries(entries));
const tree = { 'film.py': 'a1', 'kit/stage.py': 'b1', 'kit/look.py': 'c1', 'shots/s010.py': 'd1', 'shots/s020.py': 'e1', 'kitchen.py': 'f1' };
const shot = { id: 's010', start: 0, end: 2, deps: ['film.py', 'kit', 'shots/s010.py'] };
const hash = (overrides = {}, source = tree) => blenderShotHash({ ...shot, ...overrides }, files(source));

describe('blenderShotHash', () => {
  // A render is stale exactly when something the shot is built from changed.
  it.each([
    ['a listed file changes', { ...tree, 'shots/s010.py': 'd2' }, true],
    ['a file inside a listed folder changes', { ...tree, 'kit/look.py': 'c2' }, true],
    ['a file is added to a listed folder', { ...tree, 'kit/rig.py': 'g1' }, true],
    ['a file is removed from a listed folder', Object.fromEntries(Object.entries(tree).filter(([path]) => path !== 'kit/look.py')), true],
    ['another shot\'s file changes', { ...tree, 'shots/s020.py': 'e2' }, false],
    ['a file whose name only starts like a listed folder changes', { ...tree, 'kitchen.py': 'f2' }, false],
  ])('when %s, stale is %s', (_name, source, stale) => {
    expect(hash({}, source) !== hash()).toBe(stale);
  });

  it('changes when the shot is retimed, and not when its deps are listed in another order', () => {
    expect(hash({ end: 2.5 })).not.toBe(hash());
    expect(hash({ start: 0.5 })).not.toBe(hash());
    expect(hash({ deps: ['shots/s010.py', 'kit', 'film.py', 'kit'] })).toBe(hash());
  });

  it('depends on every source file when the shot lists no deps', () => {
    expect(hash({ deps: undefined }, { ...tree, 'shots/s020.py': 'e2' })).not.toBe(hash({ deps: undefined }));
    expect(hash({ deps: [] }, { ...tree, 'kitchen.py': 'f2' })).not.toBe(hash({ deps: [] }));
  });

  it('counts a listed dependency that does not exist yet, so creating it stales the render', () => {
    const waiting = hash({ deps: ['film.py', 'shots/s099.py'] });
    expect(hash({ deps: ['film.py', 'shots/s099.py'] }, { ...tree, 'shots/s099.py': 'h1' })).not.toBe(waiting);
    expect(hash({ deps: ['film.py'] })).not.toBe(waiting);
  });
});

describe('blenderSettingsHash', () => {
  it('follows what a quality actually renders with, and nothing else', () => {
    const base = blenderSettingsHash(DEFAULTS, 'preview');
    // Preview reads the preview scale and samples; final reads neither.
    expect(blenderSettingsHash({ ...DEFAULTS, previewSamples: 32 }, 'preview')).not.toBe(base);
    expect(blenderSettingsHash({ ...DEFAULTS, previewScale: 0.25 }, 'preview')).not.toBe(base);
    expect(blenderSettingsHash({ ...DEFAULTS, previewSamples: 32, previewScale: 0.25 }, 'final')).toBe(blenderSettingsHash(DEFAULTS, 'final'));
    expect(blenderSettingsHash({ ...DEFAULTS, finalSamples: 128 }, 'preview')).toBe(base);
    for (const change of [{ engine: 'CYCLES' }, { width: 1280 }, { height: 720 }, { fps: 30 }]) {
      expect(blenderSettingsHash({ ...DEFAULTS, ...change }, 'final'), JSON.stringify(change)).not.toBe(blenderSettingsHash(DEFAULTS, 'final'));
    }
    // How many Blenders run at once, or whether a .blend is kept, does not change a pixel.
    expect(blenderSettingsHash({ ...DEFAULTS, concurrency: 4, saveBlend: true }, 'final')).toBe(blenderSettingsHash(DEFAULTS, 'final'));
  });
});
