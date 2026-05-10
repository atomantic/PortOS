/**
 * Media model registry — single source of truth for image/video model
 * definitions and the text encoder used by the LTX video pipeline.
 *
 * On first load, seeds `data/media-models.json` with the project's default
 * catalog. Edit that JSON to add models, tune steps/guidance, switch the
 * text encoder, etc. Server restart picks up changes (the registry is
 * cached at boot — there's no hot-reload).
 *
 * Schema (see seed defaults below for the full picture):
 *   - video.macos[], video.windows[]: { id, name, repo?, steps, guidance, broken? }
 *   - video.defaultMacos / video.defaultWindows: id of the default model
 *   - image[]: { id, name, steps, guidance, broken? }
 *   - textEncoders[]: { id, label, repo, localPath? }
 *   - selectedTextEncoder: id of the active text encoder
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { PATHS } from './fileUtils.js';
// fileUtils.ensureDir is async/Promise-returning; this module needs a
// synchronous version because `loadMediaModels()` is called at import-time
// from videoGen/imageGen modules, which can't await before exporting.

// Allow tests + non-standard deployments to point at a different file
// without monkey-patching PATHS. Defaults to data/media-models.json.
const REGISTRY_FILE = process.env.PORTOS_MEDIA_MODELS_FILE || join(PATHS.data, 'media-models.json');
const IS_WIN = process.platform === 'win32';

const DEFAULT_REGISTRY = {
  _doc: 'PortOS media model registry. Edit to add models, tune defaults, or switch the text encoder. Restart the server to apply changes.',
  video: {
    macos: [
      // notapalindrome's mlx-video-with-audio runtime — single PyPI package,
      // T2V/I2V only, FFLF degrades to last-frame conditioning (one --image arg).
      { id: 'ltx2_unified',       name: 'LTX-2 Unified (~42 GB)',          repo: 'notapalindrome/ltx2-mlx-av',     runtime: 'mlx_video', steps: 30, guidance: 3.0 },
      { id: 'ltx23_unified',      name: 'LTX-2.3 Unified Beta (~48 GB)',   repo: 'notapalindrome/ltx23-mlx-av',    runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4 (~22 GB)',   repo: 'notapalindrome/ltx23-mlx-av-q4', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      // dgrauet's ltx-2-mlx runtime — true KeyframeInterpolationPipeline,
      // native video Extend, audio→video. Requires a separate venv synced
      // via `INSTALL_LTX2=1 bash scripts/setup-image-video.sh`.
      { id: 'ltx23_dgrauet_q4',   name: 'LTX-2.3 dgrauet Q4 (~16 GB, true keyframes)', repo: 'dgrauet/ltx-2.3-mlx-q4', runtime: 'ltx2', steps: 8, guidance: 3.0 },
      { id: 'ltx23_dgrauet_q8',   name: 'LTX-2.3 dgrauet Q8 (~25 GB, true keyframes)', repo: 'dgrauet/ltx-2.3-mlx-q8', runtime: 'ltx2', steps: 8, guidance: 3.0 },
    ],
    windows: [
      { id: 'ltx_video', name: 'LTX-Video 0.9.5 — T2V + I2V (~9.5 GB, auto-downloads)', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
    ],
    defaultMacos: 'ltx23_distilled_q4',
    defaultWindows: 'ltx_video',
  },
  image: [
    // mflux runner — MLX-only, Flux 1 (dev/schnell). `runner` defaults to 'mflux'.
    { id: 'dev',              name: 'Flux 1 Dev',      steps: 20, guidance: 3.5 },
    { id: 'schnell',          name: 'Flux 1 Schnell',  steps: 4,  guidance: 0,   cfgDisabled: true },
    // flux2 runner — PyTorch + diffusers + MPS (Apple Silicon) or CUDA (Win/Linux).
    // Models are quantized to fit on consumer hardware; tokenizer comes from the
    // gated base repo, so users must accept the license at huggingface.co and
    // set HF_TOKEN before first use.
    {
      id: 'flux2-klein-4b',
      name: 'Flux 2 Klein 4B (SDNQ 4-bit, ~8 GB @ 512px)',
      runner: 'flux2',
      quantization: 'sdnq',
      repo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic',
      tokenizerRepo: 'black-forest-labs/FLUX.2-klein-4B',
      steps: 8,
      guidance: 3.5,
      cfgDisabled: true,
    },
    {
      id: 'flux2-klein-9b',
      name: 'Flux 2 Klein 9B (SDNQ 4-bit, ~12 GB — needs 32+ GB RAM)',
      runner: 'flux2',
      quantization: 'sdnq',
      repo: 'Disty0/FLUX.2-klein-9B-SDNQ-4bit-dynamic-svd-r32',
      tokenizerRepo: 'black-forest-labs/FLUX.2-klein-9B',
      steps: 8,
      guidance: 3.5,
      cfgDisabled: true,
    },
    {
      id: 'flux2-klein-4b-int8',
      name: 'Flux 2 Klein 4B (Int8, ~16 GB)',
      runner: 'flux2',
      quantization: 'int8',
      repo: 'aydin99/FLUX.2-klein-4B-int8',
      basePipelineRepo: 'black-forest-labs/FLUX.2-klein-4B',
      steps: 8,
      guidance: 3.5,
      cfgDisabled: true,
    },
    // z-image runner — Apache 2.0, ungated, reuses the FLUX.2 venv. Turbo
    // distillation runs ~8 steps with CFG disabled (guidance 1.0).
    {
      id: 'z-image-turbo-bf16',
      name: 'Z-Image-Turbo (bf16, ~13 GB)',
      runner: 'z-image',
      repo: 'Tongyi-MAI/Z-Image-Turbo',
      steps: 8,
      guidance: 1.0,
      cfgDisabled: true,
    },
    // ernie runner — Baidu's ERNIE-Image (8B DiT). Apache 2.0, ungated,
    // reuses the FLUX.2 venv. Pipeline class isn't in AutoPipelineForText2Image's
    // registry yet so we pass `pipelineClass: 'ErnieImagePipeline'` for
    // explicit dispatch. `usePromptEnhancer` activates the built-in PE module.
    {
      id: 'ernie-image',
      name: 'ERNIE-Image (~16 GB @ bf16, 50 steps)',
      runner: 'ernie',
      repo: 'baidu/ERNIE-Image',
      pipelineClass: 'ErnieImagePipeline',
      usePromptEnhancer: true,
      steps: 50,
      guidance: 4.0,
    },
    {
      id: 'ernie-image-turbo',
      name: 'ERNIE-Image-Turbo (~16 GB @ bf16, 8 steps)',
      runner: 'ernie',
      repo: 'baidu/ERNIE-Image-Turbo',
      pipelineClass: 'ErnieImagePipeline',
      usePromptEnhancer: true,
      steps: 8,
      guidance: 1.0,
      cfgDisabled: true,
    },
    {
      id: 'z-image-turbo-quant',
      name: 'Z-Image-Turbo (community quantized)',
      runner: 'z-image',
      repo: '',
      steps: 8,
      guidance: 1.0,
      cfgDisabled: true,
      // Hidden from the UI until the user picks a community quant repo and
      // clears this flag. Keeping the entry here gives them a copy-paste
      // template instead of having to remember the schema.
      broken: true,
    },
  ],
  textEncoders: [
    { id: 'gemma-4bit',     label: 'Gemma 3 12B 4-bit (smallest, ~7 GB)',                repo: 'mlx-community/gemma-3-12b-it-4bit' },
    { id: 'gemma-qat-4bit', label: 'Gemma 3 12B QAT 4-bit (better, ~8 GB, LM Studio)',   repo: 'mlx-community/gemma-3-12b-it-qat-4bit', localPath: '~/.lmstudio/models/mlx-community/gemma-3-12b-it-qat-4bit' },
    { id: 'gemma-bf16',     label: 'Gemma 3 12B bf16 (default, best quality, ~24 GB)',   repo: 'mlx-community/gemma-3-12b-it-bf16' },
  ],
  selectedTextEncoder: 'gemma-bf16',
};

// `path.join(homedir(), '/.foo')` discards the homedir because of the
// leading slash, so we have to strip the `~/` prefix (or `~`) before joining.
const expandHome = (p) => {
  if (!p || !p.startsWith('~')) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
};

let cached = null;

const ensureDir = (file) => {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

const seedIfMissing = () => {
  if (existsSync(REGISTRY_FILE)) return;
  ensureDir(REGISTRY_FILE);
  writeFileSync(REGISTRY_FILE, JSON.stringify(DEFAULT_REGISTRY, null, 2) + '\n');
  console.log(`📝 Seeded media model registry: ${REGISTRY_FILE}`);
};

// Merge user-edited registry over DEFAULT_REGISTRY so missing top-level keys
// (e.g. someone deletes `video` or saves `{}`) don't blow up consumers that
// assume `reg.video.macos`. We also coerce array-shaped fields back to the
// defaults when the user's JSON is parseable but wrong-shape (e.g.
// `image: {}` or `video.macos: "ltx"`) — otherwise getImageModels /
// getVideoModels / buildAppModels would throw at module import-time and
// take down server startup. If a user supplies a real array, that's their
// list, full stop — we don't deep-merge entries.
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arrayOrDefault = (v, fallback) => (Array.isArray(v) ? v : fallback);

// Pre-flux2 stored entries had `broken: 'macos'` and no `runner` field. Merge
// missing flux2 fields from DEFAULT_REGISTRY when an entry id matches a known
// flux2 model but is missing the runner discriminator. User overrides for
// other fields (custom name, steps, repo) are preserved.
const FLUX2_DEFAULTS_BY_ID = Object.fromEntries(
  DEFAULT_REGISTRY.image.filter((m) => m.runner === 'flux2').map((m) => [m.id, m])
);

const upgradeImageEntries = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    const seed = FLUX2_DEFAULTS_BY_ID[entry.id];
    // Only upgrade entries that DIDN'T set `runner` at all — a user who
    // explicitly chose a different runner for a known flux2 id (e.g. to
    // wire it up to a custom runner) keeps that override.
    if (!seed || entry.runner !== undefined) return entry;
    // Only strip `broken: 'macos'` (the legacy flag the upgrade is meant
    // to clear). Any other broken value the user added is intentional and
    // preserved.
    const { broken, ...rest } = entry;
    const merged = { ...seed, ...rest, runner: 'flux2' };
    if (broken !== undefined && broken !== 'macos') merged.broken = broken;
    return merged;
  });
};

// IDs whose underlying pipeline is step-wise distilled (Flux Schnell, FLUX.2
// Klein, Z-Image-Turbo). For these models, classifier-free guidance is fixed
// internally and any user-supplied guidance scale is silently ignored — the
// diffusers runner literally prints "Guidance scale X is ignored for step-
// wise distilled models." into the log on every render. Surface this as an
// explicit flag on each registry entry so the UI can hide the Guidance input
// and the runners can skip passing the flag.
const CFG_DISABLED_IDS = new Set([
  'schnell',
  'flux2-klein-4b',
  'flux2-klein-9b',
  'flux2-klein-4b-int8',
  'z-image-turbo-bf16',
  'z-image-turbo-quant',
  'ernie-image-turbo',
]);

const backfillCfgDisabled = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    if ('cfgDisabled' in entry) return entry; // user override (true OR false) wins
    if (!CFG_DISABLED_IDS.has(entry.id)) return entry;
    return { ...entry, cfgDisabled: true };
  });
};

export const isFlux2 = (model) => model?.runner === 'flux2';
export const isZImage = (model) => model?.runner === 'z-image';
export const isErnie = (model) => model?.runner === 'ernie';
export const isCfgDisabled = (model) => model?.cfgDisabled === true;

// Append models that are genuinely new in this release (not in
// _shippedDefaults) to the user's list, while respecting deletions the user
// already made. Returns both the merged entry list and the newly-added ids so
// the caller can record them in _shippedDefaults. Used for both video and
// image lists — the deletion-survives-upgrade contract is identical.
//
// Semantics:
//   - id already in userList             → keep as-is (user customisations intact)
//   - id in shippedIds but not userList  → user explicitly deleted it; skip
//   - id NOT in shippedIds               → genuinely new built-in; add + record
const appendNewlyShippedEntries = (userList, defaultList, shippedIds) => {
  const safeList = Array.isArray(userList) ? userList : [];
  const safeDefaults = Array.isArray(defaultList) ? defaultList : [];
  const userIds = new Set(safeList.map((e) => e?.id).filter((id) => typeof id === 'string'));
  const result = [...safeList];
  const newlyShipped = [];
  for (const def of safeDefaults) {
    if (typeof def?.id !== 'string') continue;
    if (userIds.has(def.id)) continue;       // already present — keep user copy
    if (shippedIds.has(def.id)) continue;    // user deleted it; don't re-add
    result.push(def);
    newlyShipped.push(def.id);
  }
  return { entries: result, newlyShipped };
};
// Existing installs predate the `runtime` field on video entries — fill it
// with 'mlx_video' (the legacy default) for known-legacy ids so the
// dispatch in videoGen/local.js routes them through `python -m
// mlx_video.generate_av` rather than treating undefined as ltx2.
const LEGACY_MLX_VIDEO_IDS = new Set(['ltx2_unified', 'ltx23_unified', 'ltx23_distilled_q4', 'ltx_video']);
const backfillRuntime = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    if (typeof entry.runtime === 'string' && entry.runtime.length > 0) return entry;
    if (LEGACY_MLX_VIDEO_IDS.has(entry.id)) return { ...entry, runtime: 'mlx_video' };
    return entry;
  });
};

// Build the initial shippedIds set for one platform on first encounter
// (no _shippedDefaults field yet).
//
// Pre-snapshot bootstrap: existing installs without _shippedDefaults can't
// distinguish "user explicitly removed this built-in" from "this built-in
// is new in this release". We choose to UNION the user's current ids with
// the current default ids, treating both as "already shipped". That preserves
// any deletions the user made before this feature existed, at the cost of new
// built-in models in this release also being marked as shipped — so they won't
// appear on this install until the user edits data/media-models.json directly.
//
// Trade-off favors data preservation over feature visibility: a user who curated
// their model list won't have it silently re-populated. Users who want the new
// built-ins can delete media-models.json and restart to re-seed from scratch,
// or add the entries manually.
//
// When the platform key is absent from their registry (e.g. the whole `video`
// section is missing), we return an empty set so the defaults are treated as
// genuinely new and get added as on a fresh install.
const bootstrapShippedIds = (userList, defaultList) => {
  if (!Array.isArray(userList)) return new Set(); // missing key → treat as fresh
  const safeDefaults = Array.isArray(defaultList) ? defaultList : [];
  const ids = new Set();
  for (const e of userList) if (typeof e?.id === 'string') ids.add(e.id);
  for (const e of safeDefaults) if (typeof e?.id === 'string') ids.add(e.id);
  return ids;
};

const normalizeRegistry = (parsed) => {
  const safe = isPlainObject(parsed) ? parsed : {};
  const safeVideo = isPlainObject(safe.video) ? safe.video : {};

  // _shippedDefaults tracks which built-in ids have ever been delivered
  // to this install, so we can distinguish "user deleted it" from "genuinely
  // new in this release". Tracked separately for video (per-platform) and
  // image (single list — image entries cover both platforms).
  const shippedVideo = isPlainObject(safe._shippedDefaults?.video) ? safe._shippedDefaults.video : null;
  const isVideoBootstrap = shippedVideo === null;

  const shippedMacosIds = isVideoBootstrap
    ? bootstrapShippedIds(safeVideo.macos, DEFAULT_REGISTRY.video.macos)
    : new Set(arrayOrDefault(shippedVideo.macos, []));
  const shippedWindowsIds = isVideoBootstrap
    ? bootstrapShippedIds(safeVideo.windows, DEFAULT_REGISTRY.video.windows)
    : new Set(arrayOrDefault(shippedVideo.windows, []));

  const macosResult = appendNewlyShippedEntries(
    safeVideo.macos,
    DEFAULT_REGISTRY.video.macos,
    shippedMacosIds,
  );
  const windowsResult = appendNewlyShippedEntries(
    safeVideo.windows,
    DEFAULT_REGISTRY.video.windows,
    shippedWindowsIds,
  );

  const updatedShippedVideo = {
    macos: [...shippedMacosIds, ...macosResult.newlyShipped],
    windows: [...shippedWindowsIds, ...windowsResult.newlyShipped],
  };

  // Image upgrade path. Same shape as video, single list. The flux2 upgrade
  // (upgradeImageEntries) runs first so legacy `broken: 'macos'` entries get
  // promoted to runner-aware ones before the new-entry append step looks at
  // their ids. Skips bootstrap union when the image key was missing entirely
  // (treat as fresh install — let the new entries land).
  const shippedImage = isPlainObject(safe._shippedDefaults?.image) ? safe._shippedDefaults.image : null;
  const isImageBootstrap = shippedImage === null;
  const upgradedImage = backfillCfgDisabled(
    upgradeImageEntries(arrayOrDefault(safe.image, DEFAULT_REGISTRY.image)),
  );
  // Image bootstrap deliberately uses userIds ONLY (not union with defaults).
  // Image is getting `_shippedDefaults` for the first time in this release, so
  // there's no prior history of deletions to preserve via the union trick the
  // video side uses. Pre-existing installs will pick up the new built-ins
  // (z-image-turbo-*, etc.) on next boot. Subsequent loads use the persisted
  // list so user deletions stick.
  const upgradedImageIds = (Array.isArray(upgradedImage) ? upgradedImage : [])
    .map((e) => e?.id)
    .filter((id) => typeof id === 'string');
  const shippedImageIds = isImageBootstrap
    ? new Set(upgradedImageIds)
    : new Set(arrayOrDefault(shippedImage.list, []));
  const imageResult = appendNewlyShippedEntries(
    upgradedImage,
    DEFAULT_REGISTRY.image,
    shippedImageIds,
  );
  const updatedShippedImage = {
    list: [...shippedImageIds, ...imageResult.newlyShipped],
  };

  return {
    ...DEFAULT_REGISTRY,
    ...safe,
    image: imageResult.entries,
    textEncoders: arrayOrDefault(safe.textEncoders, DEFAULT_REGISTRY.textEncoders),
    video: {
      ...DEFAULT_REGISTRY.video,
      ...safeVideo,
      macos: backfillRuntime(macosResult.entries),
      windows: backfillRuntime(windowsResult.entries),
    },
    _shippedDefaults: {
      ...(safe._shippedDefaults || {}),
      video: updatedShippedVideo,
      image: updatedShippedImage,
    },
  };
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
    const raw = readFileSync(REGISTRY_FILE, 'utf-8');
    parsed = JSON.parse(raw);
    readOk = true;
  } catch (err) {
    console.log(`⚠️ Failed to load ${REGISTRY_FILE} (${err.message}) — using built-in defaults`);
  }
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
    const videoChanged =
      parsedShippedVideo === null ||
      normalizedVideo.macos.length !== (parsedShippedVideo.macos?.length ?? 0) ||
      normalizedVideo.windows.length !== (parsedShippedVideo.windows?.length ?? 0);
    const imageChanged =
      parsedShippedImage === null ||
      normalizedImage.list.length !== (parsedShippedImage.list?.length ?? 0);
    if (videoChanged || imageChanged) {
      writeFileSync(REGISTRY_FILE, JSON.stringify(cached, null, 2) + '\n');
      console.log(`📝 Updated media model registry _shippedDefaults: ${REGISTRY_FILE}`);
    }
  }
  return cached;
};

const platformBroken = (broken) =>
  broken === true || (typeof broken === 'string' && broken === (IS_WIN ? 'windows' : 'macos'));

export const getVideoModels = () => {
  const reg = loadMediaModels();
  const list = IS_WIN ? (reg.video.windows || []) : (reg.video.macos || []);
  return list.filter((m) => !platformBroken(m.broken));
};

export const getDefaultVideoModelId = () => {
  const reg = loadMediaModels();
  const configuredId = IS_WIN ? reg.video.defaultWindows : reg.video.defaultMacos;
  // Validate against the platform's available (non-broken) list — a typo or
  // a model marked broken on this platform would otherwise surface as
  // "Unknown video model" the first time the UI tries to use the default.
  const available = getVideoModels();
  if (available.some((m) => m.id === configuredId)) return configuredId;
  const fallback = available[0]?.id;
  if (fallback) {
    console.log(`⚠️ Unknown default video model "${configuredId}" for ${IS_WIN ? 'windows' : 'macos'}; falling back to "${fallback}"`);
    return fallback;
  }
  console.log(`⚠️ Unknown default video model "${configuredId}" for ${IS_WIN ? 'windows' : 'macos'}; no available models to fall back to`);
  return configuredId;
};

export const getImageModels = () => {
  const reg = loadMediaModels();
  return (reg.image || []).filter((m) => !platformBroken(m.broken));
};

// Resolve the active text encoder to a path mlx_video can pass via
// --text-encoder-repo. Prefers `localPath` (e.g. an existing LM Studio
// install) when it exists; otherwise returns the HF repo id which mlx_video
// will resolve via the HF cache (downloading on first run).
const FALLBACK_TEXT_ENCODER_REPO = 'mlx-community/gemma-3-12b-it-4bit';
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

export const getTextEncoderRepo = () => {
  const reg = loadMediaModels();
  const id = reg.selectedTextEncoder;
  const entry = (reg.textEncoders || []).find((t) => t.id === id);
  if (!entry) {
    console.log(`⚠️ Unknown selectedTextEncoder "${id}"; falling back to first entry`);
    const firstRepo = reg.textEncoders?.[0]?.repo;
    return isNonEmptyString(firstRepo) ? firstRepo : FALLBACK_TEXT_ENCODER_REPO;
  }
  if (entry.localPath) {
    const expanded = expandHome(entry.localPath);
    if (existsSync(expanded)) return expanded;
  }
  // Spawn args must be non-empty strings — a malformed registry entry
  // (missing/empty `repo`) would otherwise reach mlx_video as undefined and
  // surface as a confusing TypeError or downstream CLI error.
  if (!isNonEmptyString(entry.repo)) {
    console.log(`⚠️ Text encoder "${id}" has no repo; falling back to "${FALLBACK_TEXT_ENCODER_REPO}"`);
    return FALLBACK_TEXT_ENCODER_REPO;
  }
  return entry.repo;
};

export const getTextEncoderEntries = () => {
  const reg = loadMediaModels();
  return (reg.textEncoders || []).map((t) => ({
    id: t.id,
    label: t.label,
    repo: t.repo,
    localPath: t.localPath ? expandHome(t.localPath) : null,
    localAvailable: t.localPath ? existsSync(expandHome(t.localPath)) : false,
    selected: t.id === reg.selectedTextEncoder,
  }));
};
