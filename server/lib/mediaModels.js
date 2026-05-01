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
      { id: 'ltx2_unified',       name: 'LTX-2 Unified (~42 GB)',          repo: 'notapalindrome/ltx2-mlx-av',     steps: 30, guidance: 3.0 },
      { id: 'ltx23_unified',      name: 'LTX-2.3 Unified Beta (~48 GB)',   repo: 'notapalindrome/ltx23-mlx-av',    steps: 25, guidance: 3.0 },
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4 (~22 GB)',   repo: 'notapalindrome/ltx23-mlx-av-q4', steps: 25, guidance: 3.0 },
    ],
    windows: [
      { id: 'ltx_video', name: 'LTX-Video 0.9.5 — T2V + I2V (~9.5 GB, auto-downloads)', steps: 25, guidance: 3.0 },
    ],
    defaultMacos: 'ltx23_distilled_q4',
    defaultWindows: 'ltx_video',
  },
  image: [
    // mflux runner — MLX-only, Flux 1 (dev/schnell). `runner` defaults to 'mflux'.
    { id: 'dev',              name: 'Flux 1 Dev',      steps: 20, guidance: 3.5 },
    { id: 'schnell',          name: 'Flux 1 Schnell',  steps: 4,  guidance: 0   },
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

export const isFlux2 = (model) => model?.runner === 'flux2';

const normalizeRegistry = (parsed) => {
  const safe = isPlainObject(parsed) ? parsed : {};
  const safeVideo = isPlainObject(safe.video) ? safe.video : {};
  return {
    ...DEFAULT_REGISTRY,
    ...safe,
    image: upgradeImageEntries(arrayOrDefault(safe.image, DEFAULT_REGISTRY.image)),
    textEncoders: arrayOrDefault(safe.textEncoders, DEFAULT_REGISTRY.textEncoders),
    video: {
      ...DEFAULT_REGISTRY.video,
      ...safeVideo,
      macos: arrayOrDefault(safeVideo.macos, DEFAULT_REGISTRY.video.macos),
      windows: arrayOrDefault(safeVideo.windows, DEFAULT_REGISTRY.video.windows),
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
  try {
    const raw = readFileSync(REGISTRY_FILE, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (err) {
    console.log(`⚠️ Failed to load ${REGISTRY_FILE} (${err.message}) — using built-in defaults`);
  }
  cached = normalizeRegistry(parsed);
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
