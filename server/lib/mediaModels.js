/**
 * Persistent image, video, and text encoder registry with a synchronous cache and live-restore fencing.
 *
 * Storage: `file-primary` (`data/media-models.json`) — install configuration. The
 * optional per-entry `enabled` flag (absent = true) is additive: no seed change or
 * backfill, older servers ignore it. Synchronous mutations publish by rename
 * before replacing the process cache.
 *
 * Single source of truth for image/video model metadata. `setMediaModelEnabled(id, enabled)` persists
 * availability; `withLiveMediaModelsRestore(transfer)` fences registry mutations and reloads the cache
 * across a live snapshot restore (#9924); getters omit disabled entries unless `includeDisabled` is
 * set. Entry fields are documented in the module docblock — note `repoFiles[]`, which narrows a
 * model's own repo to an explicit file list for an aggregate repo that holds far more than the runner
 * loads (MiniMax H3 CUDA).
 *
 * On first load, seeds `data/media-models.json` with the project's default
 * catalog. Edit that JSON to add models, tune steps/guidance, switch the
 * text encoder, etc. Server restart picks up changes (the registry is
 * cached at boot — there's no hot-reload).
 *
 * Schema (see mediaModels/catalogDefaults.js for the shipped entries):
 *   - video.mlx[], video.cuda[]: { id, name, repo?, steps, guidance, broken?, disclosure?, hardwareRequirements? }
 *       The two buckets split on RUNTIME FAMILY, not operating system: `mlx`
 *       holds the Apple-MLX runtimes, `cuda` the plain torch+CUDA ones (which
 *       run on Windows AND Linux). They were keyed `macos` / `windows` before
 *       issue #4142; both spellings still load — see lib/mediaModelBuckets.js.
 *       Models may also declare `defaultWidth` / `defaultHeight`,
 *       `resolutionStep`, and `resolutionOptions[]` when their native canvas
 *       differs from the shared Video Gen presets.
 *       `repoFiles[]` (optional) narrows the model's OWN `repo` to an explicit
 *       list of repo-relative POSIX filenames, the way `requiredWeights[].files`
 *       already does for a secondary repo. Absent means "snapshot the whole
 *       repo", which is right for a repo that holds exactly one model. Declare
 *       it when the repo is an AGGREGATE holding more than the runner loads —
 *       `MiniMaxAI/MiniMax-H3` ships three layouts totalling ~498 GB where the
 *       CUDA runner needs ~144 GB of them — since the download, cache-status,
 *       integrity-verify and repair paths all fan out from the same
 *       `modelDownloadTargets()` in services/videoGen/modelCache.js and would
 *       otherwise pull and checksum the lot.
 *       `offloadProfile` (optional, `minimax_h3_cuda` only) pins the weight
 *       offload recipe to one of `auto` / `bf16` / `int8-stream` / `int8-lean`
 *       instead of letting the runner size one from the card's own VRAM. Left
 *       absent on the shipped entry deliberately: the registry syncs between
 *       peers and cannot know what GPU is on the other end. Validated in
 *       services/videoGen/local.js against MINIMAX_H3_CUDA_OFFLOAD_PROFILES.
 *       `memoryProfiles` (issue #5420) is the declared, capability-checked
 *       weight-placement table for the two MiniMax H3 entries — each profile's
 *       honest host-RAM and device-VRAM floor, best-first. Declared in
 *       lib/minimaxH3Memory.js and backfilled at load like `disclosure` and
 *       `speedProfiles`; the render path fails closed when no profile fits the
 *       measured machine, and the runners re-select on the same table.
 *       `disclosure` is optional provenance/licensing metadata (issue #3674):
 *       { modelCardUrl?, weightsLicense?: { name, url }, runtimeLicense?: { name, url },
 *         estimatedDownloadGb?, reviewedAt? }. Every key is optional and an
 *       absent key means "not established" — the UI renders it as Unknown
 *       rather than guessing. Canonical fields (repo/revision/runtime/memoryGb/
 *       supportedModes/requiredWeights/repoFiles) are NOT duplicated inside it. Shipped
 *       values live in lib/videoDisclosure.js and are backfilled at load.
 *       `finishModelId` (optional, issue #3696) names the delivery model a
 *       fast draft entry finishes into — declared in lib/videoFinishProfiles.js,
 *       backfilled at load, and validated (invalid edges are dropped, loudly).
 *       `supportedModes` (issue #3737) is resolved for EVERY entry by
 *       getVideoModels() from lib/videoModeProfiles.js's per-runtime table when
 *       the entry doesn't declare its own, so no consumer has to treat "absent"
 *       as "supports everything". A declared list always wins.
 *   - video.defaultMlx / video.defaultCuda: id of the default model
 *     (legacy `defaultMacos` / `defaultWindows` still read)
 *   - image[]: { id, name, steps, guidance, broken?, hardwareRequirements? }
 *   - textEncoders[]: { id, label, repo, localPath? }
 *   - selectedTextEncoder: id of the active text encoder
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { randomUUID } from 'node:crypto';
import { PATHS, expandHome } from './paths.js';
import { isPlainObject } from './objects.js';
import { isWorktreeRoot } from './dataRoot.js';
import {
  LEGACY_VIDEO_KEYS,
  VIDEO_BUCKETS,
  activeVideoBucket,
  matchesVideoBucket,
  readVideoBucket,
  readVideoDefault,
  resolveVideoBucketKey,
} from './mediaModelBuckets.js';
import { ServerError } from './errorHandler.js';
import { applyVideoSupportedModes } from './videoModeProfiles.js';
import {
  captureSystemCapabilities,
  hardwareRequirementsForMediaModel,
  isHardwareCompatible,
  withHardwareCompatibility,
} from './systemCapabilities.js';
import { isNonBlankStr } from './textUtils.js';
import { DEFAULT_REGISTRY } from './mediaModels/catalogDefaults.js';
import { normalizeRegistry } from './mediaModels/upgrades.js';

export { isFlux2, isZImage, isErnie, isHiDream, isQwen } from './runners.js';
export {
  FASTH3_OUTPUT_PROFILE,
  FASTH3_SOURCE_REPO,
  FASTH3_SOURCE_REVISION,
  FASTMETAL_DOWNLOAD_SIZE_PROFILES,
  MINIMAX_H3_CANVAS,
  MINIMAX_H3_OUTPUT_PROFILE,
  getShippedMediaRegistry,
} from './mediaModels/catalogDefaults.js';
export {
  RETIRED_VIDEO_MODELS,
  VIDEO_REGISTRY_UPGRADE_NAMES,
  upgradeFastH3V2RuntimeModes,
  upgradeFastMetalDownloadSizes,
  upgradeLtx25AudioControls,
  upgradeLtx25CudaMemoryFloor,
  upgradeMiniMaxH3DenoisingCount,
  upgradeMiniMaxH3OutputControls,
} from './mediaModels/upgrades.js';
export {
  imageModelDownloadTargets,
  isEditOnly,
  isHfRepoId,
  repoForModel,
  requiredModelCacheGroups,
  requiredRepoSpecsForModel,
  requiredReposForModel,
} from './mediaModels/metadata.js';

// Allow tests + non-standard deployments to point at a different file
// without monkey-patching PATHS. Defaults to data/media-models.json.
const REGISTRY_FILE = process.env.PORTOS_MEDIA_MODELS_FILE || join(PATHS.data, 'media-models.json');

let cached = null;
// Whether the most recent fresh load parsed the file (false = fell back to the
// in-memory defaults). Read only by withLiveMediaModelsRestore's reconciliation.
let lastLoadReadOk = true;
// Live-restore ownership: `restoreFences` counts restores that have been
// requested and not yet reconciled; `restoreTail` serializes them;
// `reconcileFailure` pins the registry read-only after a reload that could not
// establish what the restored bytes say.
let restoreFences = 0;
let restoreTail = Promise.resolve();
let reconcileFailure = null;

const ensureDir = (file) => {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

// Write-then-rename so a crash mid-write can't truncate the registry — it holds
// every user-added model and the shipped-defaults ledger the upgrade merge reads.
const writeRegistryAtomic = (reg) => {
  const temporary = `${REGISTRY_FILE}.${randomUUID()}.tmp`;
  // Exclusive creation establishes ownership before cleanup is allowed.
  const fd = openSync(temporary, 'wx');
  try {
    try {
      writeFileSync(fd, JSON.stringify(reg, null, 2) + '\n');
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, REGISTRY_FILE);
  } finally {
    rmSync(temporary, { force: true });
  }
};

// A process executing from a CoS claim worktree (an agent's ad-hoc `node -e`, a
// script that transitively imports this module) resolves PATHS.data to the
// checkout's own data/, so the lazy seed would strand an ignored 80 KB registry
// that blocks retirement of the merged checkout (#14112). Such a process runs on
// the in-memory shipped defaults instead; an explicit PORTOS_MEDIA_MODELS_FILE
// (the test fixture, a disposable boot) still seeds the path it names.
export const isSeedSuppressed = (registryFile = REGISTRY_FILE, explicit = process.env.PORTOS_MEDIA_MODELS_FILE) =>
  !explicit && isWorktreeRoot(registryFile);

const seedIfMissing = () => {
  if (existsSync(REGISTRY_FILE) || isSeedSuppressed()) return;
  ensureDir(REGISTRY_FILE);
  writeRegistryAtomic(DEFAULT_REGISTRY);
  console.log(`📝 Seeded media model registry: ${REGISTRY_FILE}`);
};

// Detect drift between `_shippedDefaults` and the user's live list. We
// previously hit a real install (2026-05-09) where `_shippedDefaults.image.list`
// claimed all default ids had been shipped but the user's `image[]` array was
// missing several of them — most likely from a partial editor save or a
// concurrent-write race. The deletion-survives-upgrade contract then
// permanently skipped re-adding those built-ins on every restart. We DON'T
// auto-recover (that would defeat real deletions), but we make the drift
// loud at boot so a user / sysadmin can act on it.
//
// IMPORTANT: this state is structurally indistinguishable from an INTENTIONAL
// deletion — `appendNewlyShippedEntries` skips re-adding ids that are in
// shippedIds but not userList for exactly that reason. There is no "silence
// without re-adding" path today: removing an id from `_shippedDefaults`
// flips it back to "genuinely new built-in" and normalizeRegistry will
// re-append it on next boot. So if the absence is intentional, this log
// fires every restart — users can either live with it, or accept the
// re-add and delete the entry again from the UI. We surface it anyway
// because the silent-skipping behaviour was the original bug.
//
// `where` and `shippedKey` are the two on-disk paths the warning quotes, and
// both are resolved by the CALLER rather than assembled here: image keeps its
// ids at `_shippedDefaults.image.list` while video keeps them at
// `_shippedDefaults.video.{mlx,cuda}`, and either half of a pre-#4142 registry
// may still be spelled `macos` / `windows` (migration 242 can write a canonical
// snapshot onto a legacy-keyed `video`). A copy-paste out of this warning has to
// land on a key that actually exists in the user's file.
const warnDrift = ({ where, shippedKey }, shippedIds, defaultIds, presentIds) => {
  const shippedSet = new Set(shippedIds || []);
  const defaultSet = new Set(defaultIds || []);
  const presentSet = new Set(presentIds || []);
  for (const id of shippedSet) {
    if (!defaultSet.has(id)) continue;     // not a current built-in; ignore
    if (presentSet.has(id)) continue;      // present — no drift
    console.log(`⚠️ media-models drift: built-in "${id}" was shipped but is missing from ${where}[] — if the deletion is intentional this warning will repeat each boot (no silence-without-restore path exists); to restore, either re-add the entry manually or delete ${shippedKey} entirely to re-bootstrap`);
  }
};

export const loadMediaModels = () => {
  if (cached) return cached;
  seedIfMissing();
  // Catch read AND parse failures — both can happen at module import-time
  // (videoGen/imageGen import this synchronously), so an unhandled throw
  // here aborts server startup. Permissions, broken symlink, transient I/O
  // all surface from readFileSync; malformed JSON from JSON.parse.
  let parsed = DEFAULT_REGISTRY;
  let readOk = false;
  try {
    if (!existsSync(REGISTRY_FILE) && isSeedSuppressed()) throw new Error('worktree checkout: registry not seeded');
    const raw = readFileSync(REGISTRY_FILE, 'utf-8');
    parsed = JSON.parse(raw);
    readOk = true;
  } catch (err) {
    console.log(`⚠️ Failed to load ${REGISTRY_FILE} (${err.message}) — using built-in defaults`);
  }
  // Drift check runs on the RAW parsed file (pre-normalize), because
  // normalizeRegistry uses _shippedDefaults to decide which built-ins to
  // re-add and which to skip. We want to surface the mismatch as it exists
  // on disk, not the post-merge view. Skip when no parsed file at all (the
  // catch above already logged) or when _shippedDefaults isn't populated yet
  // (bootstrap path — no drift is possible).
  if (readOk && isPlainObject(parsed?._shippedDefaults)) {
    const sd = parsed._shippedDefaults;
    if (isPlainObject(sd.image) && Array.isArray(parsed.image)) {
      warnDrift(
        { where: 'image', shippedKey: '_shippedDefaults.image.list' },
        Array.isArray(sd.image.list) ? sd.image.list : [],
        DEFAULT_REGISTRY.image.map((m) => m.id),
        parsed.image.map((m) => m?.id).filter((id) => typeof id === 'string'),
      );
    }
    // Only the CURRENT machine's video bucket is worth warning about. The
    // pickers, downloads, and every edit path read one bucket's array
    // (`getVideoModels`), so drift in the other one is invisible and
    // unactionable here — and because the warning has no silence-without-
    // restore path, a CUDA box would print the MLX rows on every single
    // boot forever with nothing the user can usefully do about them. The
    // machine that actually runs that bucket still gets the warning.
    const driftBucket = activeVideoBucket();
    const shippedDrift = readVideoBucket(sd.video, driftBucket);
    const presentDrift = readVideoBucket(parsed.video, driftBucket);
    if (
      isPlainObject(sd.video) &&
      isPlainObject(parsed.video) &&
      Array.isArray(shippedDrift) &&
      Array.isArray(presentDrift)
    ) {
      warnDrift(
        {
          where: `video.${resolveVideoBucketKey(parsed.video, driftBucket)}`,
          shippedKey: `_shippedDefaults.video.${resolveVideoBucketKey(sd.video, driftBucket)}`,
        },
        shippedDrift,
        DEFAULT_REGISTRY.video[driftBucket].map((m) => m.id),
        presentDrift.map((m) => m?.id).filter((id) => typeof id === 'string'),
      );
    }
  }
  lastLoadReadOk = readOk;
  cached = normalizeRegistry(parsed);
  // Persist _shippedDefaults back to disk whenever it was absent or gained new
  // ids (bootstrap run or a new built-in model shipped in this release). This
  // ensures user deletions survive the next server restart.
  if (readOk) {
    const parsedShippedVideo = isPlainObject(parsed._shippedDefaults?.video)
      ? parsed._shippedDefaults.video
      : null;
    const parsedShippedImage = isPlainObject(parsed._shippedDefaults?.image)
      ? parsed._shippedDefaults.image
      : null;
    const normalizedVideo = cached._shippedDefaults.video;
    const normalizedImage = cached._shippedDefaults.image;
    // A pre-#4142 bucket spelling still on disk counts as a change: the
    // normalized object is canonical-only, so the file has to be rewritten once
    // or the two spellings diverge the next time anything edits the registry.
    // (Migration 270 performs the same rename; this is its load-time twin, for
    // the same reason applyVideoDisclosures mirrors migration 237.)
    const carriesLegacyKeys = (obj) => isPlainObject(obj)
      && LEGACY_VIDEO_KEYS.some((key) => Object.hasOwn(obj, key));
    const videoChanged =
      parsedShippedVideo === null ||
      carriesLegacyKeys(parsed.video) ||
      carriesLegacyKeys(parsedShippedVideo) ||
      VIDEO_BUCKETS.some((bucket) => (
        normalizedVideo[bucket].length !== (readVideoBucket(parsedShippedVideo, bucket)?.length ?? 0)
      ));
    const imageChanged =
      parsedShippedImage === null ||
      normalizedImage.list.length !== (parsedShippedImage.list?.length ?? 0);
    if (videoChanged || imageChanged) {
      writeRegistryAtomic(cached);
      console.log(`📝 Updated media model registry _shippedDefaults: ${REGISTRY_FILE}`);
    }
  }
  return cached;
};

// Bust the boot-only cache so the next loadMediaModels() re-reads the file.
// The registry is cached at module scope (videoGen/imageGen import it
// synchronously at boot), so a runtime add/edit/remove must invalidate the
// cache or the change 400s ("Unknown model") until a server restart — the
// exact gotcha called out in issue #2124. Returns the freshly-loaded registry.
export const reloadMediaModels = () => {
  cached = null;
  return loadMediaModels();
};

// A migration can update a registry after this module was loaded at boot.
// Do not invalidate the running install when a migration targets another root.
export const invalidateMediaModelsForPath = (path) => {
  if (resolve(path) === resolve(REGISTRY_FILE)) cached = null;
};

// Registry mutators are synchronous, so checking this at their top refuses a
// write before any disk or cache change while a live restore owns the file (or
// after a restore whose reload failed — persisting the stale/default cache then
// would overwrite the restored bytes).
const assertRegistryWritable = () => {
  if (restoreFences > 0) {
    throw new ServerError('The media model registry is being restored from a snapshot — retry once the restore finishes.', { status: 409, code: 'MEDIA_MODELS_RESTORE_BUSY' });
  }
  if (reconcileFailure) {
    throw new ServerError(`The media model registry could not be reloaded after a snapshot restore (${reconcileFailure.message}). Restart PortOS before editing it.`, { status: 503, code: 'MEDIA_MODELS_UNAVAILABLE' });
  }
};

/**
 * Own data/media-models.json across an out-of-band live restore. Registry
 * mutations are refused from the moment the restore is requested until the
 * cache has been reloaded from the resulting file — including after a partial
 * transfer, which may already have overwritten it. Competing restores are
 * serialized. A reload that cannot parse the file leaves the registry
 * read-only until a later restore reconciles it (or the process restarts).
 * The callback must not call a registry mutator.
 */
export const withLiveMediaModelsRestore = (transfer) => {
  restoreFences += 1;
  const run = restoreTail.then(async () => {
    try {
      const [result] = await Promise.allSettled([Promise.resolve().then(transfer)]);
      let reloadError = null;
      try {
        reloadMediaModels();
        if (!lastLoadReadOk) throw new Error('media-models.json is unreadable or not valid JSON');
        reconcileFailure = null;
      } catch (err) {
        reloadError = err;
        reconcileFailure = err;
      }
      if (result.status === 'rejected') {
        if (!reloadError) throw result.reason;
        const error = new Error(`${result.reason.message}. Media model registry reload failed: ${reloadError.message}. Restart PortOS before editing media models.`, { cause: result.reason });
        if (result.reason?.code) error.code = result.reason.code;
        throw error;
      }
      if (reloadError) {
        throw new Error(`Media model registry reload failed: ${reloadError.message}. Restart PortOS before editing media models.`, { cause: reloadError });
      }
      return result.value;
    } finally {
      restoreFences -= 1;
    }
  });
  restoreTail = run.catch(() => {});
  return run;
};

// Persist a registry object to disk and swap it in as the cache. The cache is
// only replaced AFTER a successful write, so a persist failure leaves the live
// cache untouched (the mutators build an immutable `next` rather than editing
// the shared cache in place). Single-user trust model → no file lock needed.
const persistRegistry = (reg) => {
  ensureDir(REGISTRY_FILE);
  writeRegistryAtomic(reg);
  cached = reg;
  return reg;
};

// A user-added entry (from the "add from HuggingFace" flow) carries
// `source: 'user'`. Shipped built-ins have no `source` (or a non-'user' one
// like 'trained' won't appear here). Only user entries are editable/removable
// through the API — built-ins are read-only (the registry is their source of
// truth + they round-trip through the shipped-defaults upgrade machinery).
export const isUserModelEntry = (entry) => entry?.source === 'user';

// Locate a model entry by id, returning `{ entry, list, listKey, idx }` or null.
// Scans the CURRENT machine's video bucket + the image list — NOT the other
// bucket's video list. The other bucket's rows aren't visible to
// getVideoModels()/the render path on this install, and scanning both would
// make patch/remove ambiguous when a shared media-models.json (an MLX box and a
// CUDA box syncing as peers) legitimately holds the same custom id in both
// buckets — a remove(id) meant for the CUDA row would hit the MLX row first.
// `listKey` ('mlx' | 'cuda' | 'image') lets the mutators rebuild just that list.
// The registry passed in is always post-normalizeRegistry, so its bucket keys
// are canonical.
const findModelLocation = (reg, id) => {
  const videoKey = activeVideoBucket();
  const lists = [
    [videoKey, reg.video?.[videoKey]],
    ['image', reg.image],
  ];
  for (const [listKey, list] of lists) {
    if (!Array.isArray(list)) continue;
    const idx = list.findIndex((m) => m?.id === id);
    if (idx >= 0) return { entry: list[idx], list, listKey, idx };
  }
  return null;
};

// Rebuild the registry with one list replaced — shallow everywhere except the
// swapped array, so we neither deep-clone the whole registry nor mutate the
// live cache before the write succeeds.
const withList = (reg, listKey, nextList) =>
  listKey === 'image'
    ? { ...reg, image: nextList }
    : { ...reg, video: { ...reg.video, [listKey]: nextList } };

// Add a user model entry to the registry. `kind` selects the target list:
// 'video' → the current machine's video bucket; 'image' → the image list.
// Throws on a duplicate id (a repo already added). Persists + hot-reloads.
export const addUserModelEntry = (entry, { kind }) => {
  if (!entry || typeof entry.id !== 'string') {
    throw new ServerError('Model entry must carry a string id', { status: 400, code: 'BAD_MODEL_ENTRY' });
  }
  if (kind !== 'video' && kind !== 'image') {
    throw new ServerError(`Unknown model kind "${kind}" — expected "image" or "video".`, { status: 400, code: 'BAD_MODEL_KIND' });
  }
  assertRegistryWritable();
  const reg = loadMediaModels();
  const listKey = kind === 'video' ? activeVideoBucket() : 'image';
  // Conflict-check against the ACTIVE-on-this-install lists — the current
  // machine's video bucket + the image list — via findModelLocation (which
  // scopes to exactly those). This rejects a collision between the current
  // video list and the image list (both mutable through the same :id-only
  // PATCH/DELETE, so a dup would make one row unaddressable), while still
  // allowing the same custom video id to be added on the OTHER bucket's list
  // of a shared media-models.json (that list isn't scanned, so no false 409).
  if (findModelLocation(reg, entry.id)) {
    throw new ServerError(
      `A model with id "${entry.id}" is already in this install's registry (repo already added?). Remove it first to re-add.`,
      { status: 409, code: 'MODEL_ALREADY_EXISTS' },
    );
  }
  const current = (listKey === 'image' ? reg.image : reg.video?.[listKey]) || [];
  // Also reject a duplicate REPO in the target list — the same weights under a
  // different id (e.g. the UI placeholder `notapalindrome/ltx23-mlx-av-q4`,
  // already shipped as the built-in `ltx23_distilled_q4`) would otherwise add a
  // second pickable row for identical weights. Only meaningful when the entry
  // carries a repo.
  if (typeof entry.repo === 'string' && entry.repo.trim()
    && current.some((m) => typeof m?.repo === 'string' && m.repo === entry.repo)) {
    throw new ServerError(
      `The HuggingFace repo "${entry.repo}" is already in this install's ${kind} registry (possibly as a built-in). It's already available in the model picker.`,
      { status: 409, code: 'MODEL_REPO_ALREADY_EXISTS' },
    );
  }
  persistRegistry(withList(reg, listKey, [...current, entry]));
  console.log(`📝 Added user media model: ${entry.id} (${kind}) → ${entry.repo || '?'}`);
  return entry;
};

// Guard shared by patch/remove: locate a USER entry by id or throw (404 for
// unknown, 403 for a built-in). Returns the `findModelLocation` result.
const requireUserEntry = (reg, id, verb) => {
  const loc = findModelLocation(reg, id);
  if (!loc) throw new ServerError(`Unknown model id: ${id}`, { status: 404, code: 'NOT_FOUND' });
  if (!isUserModelEntry(loc.entry)) {
    throw new ServerError(
      `Model "${id}" is a built-in — built-in models can't be ${verb} through this surface.`,
      { status: 403, code: 'MODEL_READONLY' },
    );
  }
  return loc;
};

// Patch a USER model entry's editable fields (name, steps, guidance). Refuses
// built-ins and unknown ids. Persists + hot-reloads. Returns the updated entry.
const USER_EDITABLE_FIELDS = new Set(['name', 'steps', 'guidance']);
export const patchUserModelEntry = (id, patch) => {
  assertRegistryWritable();
  const reg = loadMediaModels();
  const loc = requireUserEntry(reg, id, 'edited');
  const cleanPatch = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (USER_EDITABLE_FIELDS.has(k) && v !== undefined) cleanPatch[k] = v;
  }
  const updated = { ...loc.entry, ...cleanPatch, id, source: 'user' };
  const nextList = loc.list.map((m, i) => (i === loc.idx ? updated : m));
  persistRegistry(withList(reg, loc.listKey, nextList));
  console.log(`📝 Patched user media model: ${id}`);
  return updated;
};

// Availability is install configuration, including for shipped entries. Keep
// disabled rows in the registry so they can be re-enabled without reinstalling.
export const setMediaModelEnabled = (id, enabled) => {
  assertRegistryWritable();
  const reg = loadMediaModels();
  const loc = findModelLocation(reg, id);
  if (!loc) throw new ServerError(`Unknown model id: ${id}`, { status: 404, code: 'NOT_FOUND' });
  if (typeof enabled !== 'boolean') throw new ServerError('enabled must be a boolean', { status: 400, code: 'VALIDATION_ERROR' });
  const updated = { ...loc.entry, enabled };
  persistRegistry(withList(reg, loc.listKey, loc.list.map((m, i) => i === loc.idx ? updated : m)));
  return updated;
};

// Remove a USER model entry. Refuses built-ins and unknown ids. Persists +
// hot-reloads. Returns `{ ok, id }`.
export const removeUserModelEntry = (id) => {
  assertRegistryWritable();
  const reg = loadMediaModels();
  const loc = requireUserEntry(reg, id, 'removed');
  const nextList = loc.list.filter((_, i) => i !== loc.idx);
  persistRegistry(withList(reg, loc.listKey, nextList));
  console.log(`🗑️ Removed user media model: ${id}`);
  return { ok: true, id };
};

// `broken` is either `true` (broken everywhere) or the name of the ONE bucket
// it's broken on. Pre-#4142 entries spell that name `macos` / `windows`, so
// matchesVideoBucket accepts both spellings for the active bucket.
const platformBroken = (broken) =>
  broken === true || matchesVideoBucket(broken, activeVideoBucket());

// `supportedModes` is resolved HERE rather than in normalizeRegistry (#3737):
// deriving on read covers the load path, the user-model mutators (which bypass
// normalizeRegistry) and peer-synced entries in one place, and keeps the derived
// list out of data/media-models.json — a persisted copy would read back as a
// *declared* list that no later correction to VIDEO_RUNTIME_MODES could reach.
export const getVideoModels = ({ includeDisabled = false } = {}) => {
  const reg = loadMediaModels();
  const bucket = activeVideoBucket();
  const capabilities = captureSystemCapabilities();
  const list = readVideoBucket(reg.video, bucket) || [];
  return applyVideoSupportedModes(list.filter((m) => !platformBroken(m.broken) && (includeDisabled || m.enabled !== false))).map((model) => (
    withHardwareCompatibility(
      model,
      capabilities,
      hardwareRequirementsForMediaModel(model, { kind: 'video', bucket }),
    )
  ));
};

export const getDefaultVideoModelId = (capabilities = captureSystemCapabilities(), preferredId = null) => {
  const reg = loadMediaModels();
  // Note: defaultMlx / defaultCuda may legitimately point at a model
  // flagged `deprecated: true` — the dgrauet (non-deprecated) runtime
  // requires an opt-in venv (`INSTALL_LTX2=1 bash scripts/setup-image-video.sh`),
  // so the shipped default must stay on a model that works out of the box.
  // The UI dropdowns surface dgrauet at the top via the `Legacy` optgroup
  // pattern; user-driven migration > auto-rolling forward.
  const bucket = activeVideoBucket();
  const configuredId = readVideoDefault(reg.video, bucket);
  const preferred = typeof preferredId === 'string' && preferredId.trim() ? preferredId.trim() : null;
  // Validate against the bucket's available (non-broken) list — a typo or
  // a model marked broken on this bucket would otherwise surface as
  // "Unknown video model" the first time the UI tries to use the default.
  const available = getVideoModels().map((model) => withHardwareCompatibility(
    model,
    capabilities,
    model.hardwareRequirements,
  ));
  const compatible = available.filter((model) => isHardwareCompatible(model.hardwareCompatibility));
  const candidates = [preferred, configuredId];
  // FastMetal 5B is the shipped Apple Silicon default. On a machine below its
  // 16 GB floor, use the smaller FastMetal profile when it is compatible
  // before considering older catalog entries.
  if (candidates.includes('fastmetal_5b_qad')) candidates.push('fastmetal_1_3b_qad');
  const selected = candidates.find((id) => compatible.some((model) => model.id === id));
  if (selected) return selected;
  const fallback = compatible[0]?.id;
  if (fallback) {
    console.log(`⚠️ Default video model "${preferred || configuredId}" is unavailable or unknown for ${bucket}; falling back to "${fallback}"`);
    return fallback;
  }
  console.log(`⚠️ Default video model "${preferred || configuredId}" is unavailable or unknown for ${bucket}; no available models to fall back to`);
  return preferred || configuredId;
};

export const getImageModels = ({ includeDisabled = false } = {}) => {
  const reg = loadMediaModels();
  const capabilities = captureSystemCapabilities();
  return (reg.image || [])
    .filter((m) => !platformBroken(m.broken) && (includeDisabled || m.enabled !== false))
    .map((model) => withHardwareCompatibility(
      model,
      capabilities,
      hardwareRequirementsForMediaModel(model, { kind: 'image' }),
    ));
};

// Resolve the active text encoder to a path mlx_video can pass via
// --text-encoder-repo. Prefers `localPath` (e.g. an existing LM Studio
// install) when it exists; otherwise returns the HF repo id which mlx_video
// will resolve via the HF cache (downloading on first run).
const FALLBACK_TEXT_ENCODER_REPO = 'mlx-community/gemma-3-12b-it-4bit';

export const getTextEncoderRepo = () => {
  const reg = loadMediaModels();
  const id = reg.selectedTextEncoder;
  const entry = (reg.textEncoders || []).find((t) => t.id === id);
  if (!entry) {
    console.log(`⚠️ Unknown selectedTextEncoder "${id}"; falling back to first entry`);
    const firstRepo = reg.textEncoders?.[0]?.repo;
    return isNonBlankStr(firstRepo) ? firstRepo : FALLBACK_TEXT_ENCODER_REPO;
  }
  if (entry.localPath) {
    const expanded = expandHome(entry.localPath);
    if (existsSync(expanded)) return expanded;
  }
  // Spawn args must be non-empty strings — a malformed registry entry
  // (missing/empty `repo`) would otherwise reach mlx_video as undefined and
  // surface as a confusing TypeError or downstream CLI error.
  if (!isNonBlankStr(entry.repo)) {
    console.log(`⚠️ Text encoder "${id}" has no repo; falling back to "${FALLBACK_TEXT_ENCODER_REPO}"`);
    return FALLBACK_TEXT_ENCODER_REPO;
  }
  return entry.repo;
};
