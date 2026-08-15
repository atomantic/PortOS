import { describe, it, expect, afterEach } from 'vitest';
import {
  LEGACY_VIDEO_KEYS,
  VIDEO_BUCKET_CUDA,
  VIDEO_BUCKET_MLX,
  activeVideoBucket,
  canonicalizeVideoBuckets,
  matchesVideoBucket,
  otherVideoBucket,
  readVideoBucket,
  readVideoDefault,
  resolveVideoBucketKey,
  resolveVideoDefaultKey,
} from './mediaModelBuckets.js';
import { pinPlatform } from './testHelper.js';

let restorePlatform = () => {};
const asPlatform = (value) => { restorePlatform = pinPlatform(value); };

describe('activeVideoBucket', () => {
  afterEach(() => restorePlatform());

  it('gives darwin the MLX bucket', () => {
    asPlatform('darwin');
    expect(activeVideoBucket()).toBe(VIDEO_BUCKET_MLX);
  });

  // The #4142 bug: selecting on `IS_WIN` sent linux down the macOS branch, so a
  // Linux install was served a list of MLX runtimes it cannot execute.
  it.each(['win32', 'linux', 'freebsd'])('gives %s the CUDA bucket', (platform) => {
    asPlatform(platform);
    expect(activeVideoBucket()).toBe(VIDEO_BUCKET_CUDA);
  });

  it('reads the platform per call rather than pinning it at import', () => {
    asPlatform('darwin');
    expect(activeVideoBucket()).toBe(VIDEO_BUCKET_MLX);
    asPlatform('linux');
    expect(activeVideoBucket()).toBe(VIDEO_BUCKET_CUDA);
  });

  it('otherVideoBucket is the opposite of whatever it is handed', () => {
    expect(otherVideoBucket(VIDEO_BUCKET_MLX)).toBe(VIDEO_BUCKET_CUDA);
    expect(otherVideoBucket(VIDEO_BUCKET_CUDA)).toBe(VIDEO_BUCKET_MLX);
  });
});

describe('bucket key resolution', () => {
  it('prefers the canonical key', () => {
    const video = { mlx: ['new'], macos: ['old'] };
    expect(resolveVideoBucketKey(video, VIDEO_BUCKET_MLX)).toBe('mlx');
    expect(readVideoBucket(video, VIDEO_BUCKET_MLX)).toEqual(['new']);
  });

  it('falls back to the pre-#4142 alias', () => {
    const video = { macos: ['old'], windows: ['oldwin'] };
    expect(resolveVideoBucketKey(video, VIDEO_BUCKET_MLX)).toBe('macos');
    expect(resolveVideoBucketKey(video, VIDEO_BUCKET_CUDA)).toBe('windows');
    expect(readVideoBucket(video, VIDEO_BUCKET_CUDA)).toEqual(['oldwin']);
  });

  // Sentinel discipline: a canonical key that is PRESENT but holds junk must not
  // silently resolve to a stale legacy array — the caller's own shape coercion
  // has to see the junk and fall back to the defaults, exactly as it did before
  // the alias existed.
  it('does not fall through when the canonical key is present but unusable', () => {
    const video = { mlx: 'ltx', macos: ['old'] };
    expect(resolveVideoBucketKey(video, VIDEO_BUCKET_MLX)).toBe('mlx');
    expect(readVideoBucket(video, VIDEO_BUCKET_MLX)).toBe('ltx');
  });

  it('distinguishes an explicitly empty bucket from an absent one', () => {
    expect(readVideoBucket({ mlx: [] }, VIDEO_BUCKET_MLX)).toEqual([]);
    expect(readVideoBucket({}, VIDEO_BUCKET_MLX)).toBeUndefined();
    expect(resolveVideoBucketKey({}, VIDEO_BUCKET_MLX)).toBeNull();
  });

  it('tolerates a missing or non-object video section', () => {
    for (const video of [undefined, null, 'nope', ['a']]) {
      expect(resolveVideoBucketKey(video, VIDEO_BUCKET_MLX)).toBeNull();
      expect(readVideoBucket(video, VIDEO_BUCKET_MLX)).toBeUndefined();
    }
  });

  it('resolves the default-model key canonical-first', () => {
    expect(resolveVideoDefaultKey({ defaultMlx: 'a', defaultMacos: 'b' }, VIDEO_BUCKET_MLX)).toBe('defaultMlx');
    expect(readVideoDefault({ defaultMacos: 'b' }, VIDEO_BUCKET_MLX)).toBe('b');
    expect(readVideoDefault({ defaultWindows: 'c' }, VIDEO_BUCKET_CUDA)).toBe('c');
    expect(readVideoDefault({}, VIDEO_BUCKET_CUDA)).toBeUndefined();
  });
});

describe('matchesVideoBucket', () => {
  it('accepts both spellings of the bucket a `broken` flag names', () => {
    expect(matchesVideoBucket('mlx', VIDEO_BUCKET_MLX)).toBe(true);
    expect(matchesVideoBucket('macos', VIDEO_BUCKET_MLX)).toBe(true);
    expect(matchesVideoBucket('cuda', VIDEO_BUCKET_CUDA)).toBe(true);
    expect(matchesVideoBucket('windows', VIDEO_BUCKET_CUDA)).toBe(true);
  });

  it('rejects the other bucket and non-strings', () => {
    expect(matchesVideoBucket('windows', VIDEO_BUCKET_MLX)).toBe(false);
    expect(matchesVideoBucket('macos', VIDEO_BUCKET_CUDA)).toBe(false);
    expect(matchesVideoBucket(true, VIDEO_BUCKET_MLX)).toBe(false);
    expect(matchesVideoBucket(undefined, VIDEO_BUCKET_MLX)).toBe(false);
  });
});

describe('canonicalizeVideoBuckets', () => {
  it('renames every legacy key and leaves nothing behind', () => {
    const { video, changed } = canonicalizeVideoBuckets({
      macos: ['a'], windows: ['b'], defaultMacos: 'a', defaultWindows: 'b', selectedFoo: 1,
    });
    expect(changed).toBe(true);
    expect(video).toEqual({ mlx: ['a'], cuda: ['b'], defaultMlx: 'a', defaultCuda: 'b', selectedFoo: 1 });
    expect(LEGACY_VIDEO_KEYS.some((key) => key in video)).toBe(false);
  });

  it('keeps the canonical value and drops the legacy twin when both exist', () => {
    const { video } = canonicalizeVideoBuckets({ mlx: ['new'], macos: ['old'] });
    expect(video).toEqual({ mlx: ['new'] });
  });

  it('reports no change for an already-canonical object', () => {
    const input = { mlx: ['a'], cuda: ['b'], defaultMlx: 'a', defaultCuda: 'b' };
    expect(canonicalizeVideoBuckets(input)).toEqual({ video: input, changed: false });
  });

  it('skips the default-model keys when told to', () => {
    const { video } = canonicalizeVideoBuckets(
      { macos: ['a'], windows: ['b'], defaultMacos: 'a' },
      { defaultKeys: false },
    );
    expect(video).toEqual({ mlx: ['a'], cuda: ['b'], defaultMacos: 'a' });
  });

  it('passes non-objects through untouched', () => {
    for (const input of [undefined, null, 'x', ['a']]) {
      expect(canonicalizeVideoBuckets(input)).toEqual({ video: input, changed: false });
    }
  });
});
