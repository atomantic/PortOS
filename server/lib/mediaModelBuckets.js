/**
 * Video-registry bucket naming and platform selection (issue #4142).
 *
 * The video registry has always held exactly two lists of models, and they were
 * originally keyed `macos` and `windows`. That naming was never the real axis:
 * what separates the two lists is the RUNTIME FAMILY each entry needs — Apple's
 * MLX stack (`mlx_video`, `ltx2`, `ltx25`, `wan22`, `hunyuan`, `minimax_h3`) on
 * one side, plain torch + CUDA (`ltx_video` via scripts/generate_win.py,
 * `minimax_h3_cuda` via diffusers) on the other. Reading the OS off the key
 * meant a Linux install was served the MLX list, every entry of which is
 * unrunnable there, while the two CUDA entries that would run perfectly sat in
 * an unreachable `windows` list.
 *
 * So the canonical keys are `mlx` / `cuda` (and `defaultMlx` / `defaultCuda`),
 * and the selector is "is this a Mac?" rather than "is this Windows?".
 *
 * The legacy keys stay readable forever. PortOS is distributed software: other
 * installs upgrade on their own schedule, and `data/media-models.json` is a
 * hand-editable user file. `resolveVideoBucketKey` prefers the canonical key and
 * falls back to the legacy alias, so a registry written by any older version
 * keeps resolving with no rewrite required. Migration 270 renames the keys in
 * place for installs that already persisted one, purely so hand-editors see a
 * single spelling.
 *
 * Kept in its own module (rather than inside `mediaModels.js`) because the
 * migration family under `scripts/migrations/` needs the same alias resolution
 * and must not import the registry loader, which seeds `data/` as a side effect.
 */

export const VIDEO_BUCKET_MLX = 'mlx';
export const VIDEO_BUCKET_CUDA = 'cuda';
export const VIDEO_BUCKETS = Object.freeze([VIDEO_BUCKET_MLX, VIDEO_BUCKET_CUDA]);

/** Pre-#4142 on-disk key for each bucket's entry array. Read-only aliases. */
export const LEGACY_VIDEO_BUCKET_KEYS = Object.freeze({
  [VIDEO_BUCKET_MLX]: 'macos',
  [VIDEO_BUCKET_CUDA]: 'windows',
});

/** Canonical key naming each bucket's default model id. */
export const VIDEO_DEFAULT_KEYS = Object.freeze({
  [VIDEO_BUCKET_MLX]: 'defaultMlx',
  [VIDEO_BUCKET_CUDA]: 'defaultCuda',
});

/** Pre-#4142 on-disk key for each bucket's default model id. */
export const LEGACY_VIDEO_DEFAULT_KEYS = Object.freeze({
  [VIDEO_BUCKET_MLX]: 'defaultMacos',
  [VIDEO_BUCKET_CUDA]: 'defaultWindows',
});

/** Every legacy key a normalized `video` object must not carry forward. */
export const LEGACY_VIDEO_KEYS = Object.freeze([
  ...Object.values(LEGACY_VIDEO_BUCKET_KEYS),
  ...Object.values(LEGACY_VIDEO_DEFAULT_KEYS),
]);

/**
 * Which bucket this machine can actually run. macOS gets MLX; every other
 * platform (Windows AND Linux) gets the torch+CUDA list — the entries there are
 * plain PyTorch pipelines whose venvs provision identically on both.
 *
 * Read at call time, not at module load, so a test can redefine
 * `process.platform` and so a single import is not pinned to the first platform
 * it saw.
 */
export const activeVideoBucket = () => (
  process.platform === 'darwin' ? VIDEO_BUCKET_MLX : VIDEO_BUCKET_CUDA
);

/** The bucket this machine cannot run. */
export const otherVideoBucket = (bucket) => (
  bucket === VIDEO_BUCKET_MLX ? VIDEO_BUCKET_CUDA : VIDEO_BUCKET_MLX
);

const hasKey = (obj, key) => (
  obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key)
);

/**
 * The key `video` (or `_shippedDefaults.video`) actually stores `bucket` under:
 * the canonical name when present, else the legacy alias, else `null`.
 *
 * Keyed on key PRESENCE, not on the value being usable — a canonical key
 * holding junk (`{ mlx: "ltx" }`) must NOT silently fall through to a stale
 * legacy array. Callers apply their own shape coercion to the value.
 */
export const resolveVideoBucketKey = (video, bucket) => {
  if (hasKey(video, bucket)) return bucket;
  const legacy = LEGACY_VIDEO_BUCKET_KEYS[bucket];
  if (legacy && hasKey(video, legacy)) return legacy;
  return null;
};

/** The raw value stored for `bucket`, canonical key preferred. */
export const readVideoBucket = (video, bucket) => {
  const key = resolveVideoBucketKey(video, bucket);
  return key === null ? undefined : video[key];
};

/** As `resolveVideoBucketKey`, for the bucket's default-model-id key. */
export const resolveVideoDefaultKey = (video, bucket) => {
  const canonical = VIDEO_DEFAULT_KEYS[bucket];
  if (canonical && hasKey(video, canonical)) return canonical;
  const legacy = LEGACY_VIDEO_DEFAULT_KEYS[bucket];
  if (legacy && hasKey(video, legacy)) return legacy;
  return null;
};

/** The raw default model id stored for `bucket`, canonical key preferred. */
export const readVideoDefault = (video, bucket) => {
  const key = resolveVideoDefaultKey(video, bucket);
  return key === null ? undefined : video[key];
};

/**
 * Does a per-entry `broken` string name this bucket? Entries persisted before
 * the rename spell it `"macos"` / `"windows"`, so both spellings count.
 */
export const matchesVideoBucket = (value, bucket) => (
  typeof value === 'string' && (value === bucket || value === LEGACY_VIDEO_BUCKET_KEYS[bucket])
);

/**
 * Rewrite a `video`-shaped object's legacy keys to their canonical names,
 * returning `{ video, changed }`. A canonical key that is already present wins
 * and its legacy twin is dropped, so the result never carries two spellings of
 * the same list. Values are moved untouched — this renames, it never rebuilds.
 *
 * `defaultKeys: false` handles `_shippedDefaults.video`, which holds only the
 * two id arrays and no default-model keys.
 */
export const canonicalizeVideoBuckets = (video, { defaultKeys = true } = {}) => {
  if (video === null || typeof video !== 'object' || Array.isArray(video)) {
    return { video, changed: false };
  }
  const pairs = [
    ...VIDEO_BUCKETS.map((bucket) => [bucket, LEGACY_VIDEO_BUCKET_KEYS[bucket]]),
    ...(defaultKeys
      ? VIDEO_BUCKETS.map((bucket) => [VIDEO_DEFAULT_KEYS[bucket], LEGACY_VIDEO_DEFAULT_KEYS[bucket]])
      : []),
  ];
  let changed = false;
  const next = { ...video };
  for (const [canonical, legacy] of pairs) {
    if (!Object.hasOwn(next, legacy)) continue;
    if (!Object.hasOwn(next, canonical)) next[canonical] = next[legacy];
    delete next[legacy];
    changed = true;
  }
  return { video: next, changed };
};
