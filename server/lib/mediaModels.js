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

const REGISTRY_FILE = join(PATHS.data, 'media-models.json');
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
    { id: 'dev',              name: 'Flux 1 Dev',      steps: 20, guidance: 3.5 },
    { id: 'schnell',          name: 'Flux 1 Schnell',  steps: 4,  guidance: 0   },
    { id: 'flux2-klein-4b',   name: 'Flux 2 Klein 4B', steps: 8,  guidance: 3.5, broken: 'macos' },
    { id: 'flux2-klein-9b',   name: 'Flux 2 Klein 9B', steps: 8,  guidance: 3.5, broken: 'macos' },
  ],
  textEncoders: [
    { id: 'gemma-4bit',     label: 'Gemma 3 12B 4-bit (default, ~7 GB)',                 repo: 'mlx-community/gemma-3-12b-it-4bit' },
    { id: 'gemma-qat-4bit', label: 'Gemma 3 12B QAT 4-bit (better, ~8 GB, LM Studio)',   repo: 'mlx-community/gemma-3-12b-it-qat-4bit', localPath: '~/.lmstudio/models/mlx-community/gemma-3-12b-it-qat-4bit' },
    { id: 'gemma-bf16',     label: 'Gemma 3 12B bf16 (best, ~24 GB, large download)',    repo: 'mlx-community/gemma-3-12b-it-bf16' },
  ],
  selectedTextEncoder: 'gemma-4bit',
};

const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

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

export const loadMediaModels = () => {
  if (cached) return cached;
  seedIfMissing();
  const raw = readFileSync(REGISTRY_FILE, 'utf-8');
  cached = JSON.parse(raw);
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
  return IS_WIN ? reg.video.defaultWindows : reg.video.defaultMacos;
};

export const getImageModels = () => {
  const reg = loadMediaModels();
  return (reg.image || []).filter((m) => !platformBroken(m.broken));
};

// Resolve the active text encoder to a path mlx_video can pass via
// --text-encoder-repo. Prefers `localPath` (e.g. an existing LM Studio
// install) when it exists; otherwise returns the HF repo id which mlx_video
// will resolve via the HF cache (downloading on first run).
export const getTextEncoderRepo = () => {
  const reg = loadMediaModels();
  const id = reg.selectedTextEncoder;
  const entry = (reg.textEncoders || []).find((t) => t.id === id);
  if (!entry) {
    console.log(`⚠️ Unknown selectedTextEncoder "${id}"; falling back to first entry`);
    return reg.textEncoders?.[0]?.repo || 'mlx-community/gemma-3-12b-it-4bit';
  }
  if (entry.localPath) {
    const expanded = expandHome(entry.localPath);
    if (existsSync(expanded)) return expanded;
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
