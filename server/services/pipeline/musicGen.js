/**
 * Local OSS music generation — generator-agnostic backend selector
 * (Pipeline Audio Phase 4c.2).
 *
 * The audio stage's `source: 'gen'` library entry renders text-conditioned
 * background music on-device: no network, no API key — the same "local OSS
 * first" posture as the Kokoro / Piper voice path in `audio.js`. Each backend
 * is a sibling Python sidecar behind one `generateMusic` contract:
 *
 *   - `musicgen`  — Meta's MusicGen via MLX (Apple Silicon). Bounded clips
 *     (≤30s; trained on 30s windows, degrades past that). First backend.
 *   - `audioldm2` — AudioLDM2 latent diffusion via HuggingFace `diffusers`.
 *     Long-form (well past 30s), torch on MPS/CUDA/CPU. Second backend.
 *   - `minimax-music3` — MiniMax Music 3 via CUDA Diffusers, up to five minutes.
 *   - `minimax-music3-mlx` — native MiniMax Music 3 on Apple Silicon via MLX,
 *     with selectable 8-bit and BF16 checkpoints.
 *
 * An ENGINES registry holds each backend's models, duration window, sidecar
 * script, venv resolver and install hint, so the route, UI and `generateMusic`
 * stay engine-agnostic — adding a third backend is one ENGINES entry plus its
 * Python sidecar, with the route contract unchanged.
 *
 * Runtime: each backend has an opt-in venv from
 * `INSTALL_<ENGINE>=1 bash scripts/setup-image-video.sh`. When it isn't set up,
 * `generateMusic` throws a 503 with that backend's install hint rather than a
 * bare spawn error — exactly like the FLUX.2 venv gate.
 *
 * Performance or memory profiles are not supported from metrics alone: the
 * full-length benchmark protocol in
 * `docs/features/music-renderer-benchmarks.md` requires an explicit listening
 * review after the technical checks pass.
 *
 * Output: a WAV written into the shared music library (PATHS.music) under a
 * `music-gen-<uuid>.wav` basename, so the picker treats a generated track
 * identically to an uploaded one.
 */

import { existsSync, statSync } from 'fs';
import { execFile } from '../../lib/childProcess.js';
import { platform as osPlatform, arch as osArch } from 'os';
import { promisify } from 'util';
import { unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { PATHS, ensureDir } from '../../lib/fileUtils.js';
import { hfChildEnv } from '../hfToken.js';
import { runSidecarProcess, parseSidecarResult } from '../../lib/sidecarProcess.js';
import {
  resolveMusicgenPython, MUSICGEN_RUNTIME_DIR, MUSICGEN_VENV_DEFAULT,
  resolveAudioldm2Python, AUDIOLDM2_RUNTIME_DIR, AUDIOLDM2_VENV_DEFAULT,
  resolveAcestepPython, ACESTEP_RUNTIME_DIR, ACESTEP_VENV_DEFAULT,
  resolveAcestep15Python, ACESTEP15_RUNTIME_DIR, ACESTEP15_VENV_DEFAULT,
  resolveMinimaxMusic3Python, MINIMAX_MUSIC3_RUNTIME_DIR, MINIMAX_MUSIC3_VENV_DEFAULT,
  resolveMinimaxMusic3MlxPython, MINIMAX_MUSIC3_MLX_RUNTIME_DIR, MINIMAX_MUSIC3_MLX_VENV_DEFAULT,
} from '../../lib/pythonSetup.js';
import { getCudaCapability } from '../../lib/cudaCapability.js';
import { inspectModelCache } from '../../lib/hfCache.js';
import { ServerError } from '../../lib/errorHandler.js';
import { stripMarkdownEmphasis } from '../../lib/markdownText.js';
import { recommendMinimaxDurationSec } from '../../lib/musicDuration.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
// The sidecar scripts live at the repo root — resolve module-relative so the
// paths are correct regardless of the server process's cwd.
const MUSICGEN_SCRIPT = join(__dirname, '../../../scripts/generate_musicgen.py');
const AUDIOLDM2_SCRIPT = join(__dirname, '../../../scripts/generate_audioldm2.py');
const ACESTEP_SCRIPT = join(__dirname, '../../../scripts/generate_acestep.py');
const ACESTEP15_SCRIPT = join(__dirname, '../../../scripts/generate_acestep15.py');
const MINIMAX_MUSIC3_SCRIPT = join(__dirname, '../../../scripts/generate_minimax_music3.py');
const MINIMAX_MUSIC3_MLX_SCRIPT = join(__dirname, '../../../scripts/generate_minimax_music3_mlx.py');
export const MUSIC_RENDERER_BENCHMARK_GUIDE = 'docs/features/music-renderer-benchmarks.md';
// Back-compat alias for the pre-multi-engine `buildMusicGenArgs` default.
const SIDECAR_SCRIPT = MUSICGEN_SCRIPT;

// MusicGen's practical clip-length window. It was trained on 30s windows and
// degrades past that; the floor keeps at least one decoder step. Exported as
// the module-level defaults for backward compatibility — `musicgen` is the
// default engine, so these mirror its ENGINES entry.
export const MIN_DURATION_SEC = 1;
export const MAX_DURATION_SEC = 30;
export const DEFAULT_DURATION_SEC = 12;

// MusicGen model tiers; medium is the default — a quality/speed balance that
// fits comfortably in unified memory. Kept as a small in-module constant rather
// than threaded through the image/video `media-models.json` registry, whose
// seed/merge/migration machinery doesn't apply to a one-shot audio generator.
export const MUSICGEN_MODELS = Object.freeze([
  { id: 'musicgen-small',  repo: 'facebook/musicgen-small',  name: 'MusicGen Small (~2 GB, fastest)' },
  { id: 'musicgen-medium', repo: 'facebook/musicgen-medium', name: 'MusicGen Medium (~6 GB, balanced)' },
  { id: 'musicgen-large',  repo: 'facebook/musicgen-large',  name: 'MusicGen Large (~13 GB, best quality)' },
]);
export const DEFAULT_MUSICGEN_MODEL_ID = 'musicgen-medium';

// AudioLDM2 model tiers; the base model is the default — long-form text-to-audio
// with the smallest weights. `audioldm2-large` and `-music` trade size for
// fidelity / music-specialization.
export const AUDIOLDM2_MODELS = Object.freeze([
  { id: 'audioldm2',       repo: 'cvssp/audioldm2',       name: 'AudioLDM2 Base (~3 GB, long-form)' },
  { id: 'audioldm2-large', repo: 'cvssp/audioldm2-large', name: 'AudioLDM2 Large (~7 GB, best quality)' },
  { id: 'audioldm2-music', repo: 'cvssp/audioldm2-music', name: 'AudioLDM2 Music (~3 GB, music-tuned)' },
]);
export const DEFAULT_AUDIOLDM2_MODEL_ID = 'audioldm2';

// ACE-Step weights. The 3.5B foundation model is the only public checkpoint;
// `repo` is informational (the sidecar lets ACE-Step resolve + auto-download its
// own checkpoints, unlike the from_pretrained backends above).
export const ACESTEP_MODELS = Object.freeze([
  { id: 'ace-step-v1-3.5b', repo: 'ACE-Step/ACE-Step-v1-3.5B', name: 'ACE-Step v1 3.5B (full song + vocals)' },
]);
export const DEFAULT_ACESTEP_MODEL_ID = 'ace-step-v1-3.5b';
// ACE-Step 1.5 stores its DiT, VAE, text encoder, and LM in one HF repository.
// It is deliberately a separate engine: persisted v1 render metadata must
// continue to select v1's pip-based runtime instead of silently changing.
export const ACESTEP15_MODELS = Object.freeze([
  { id: 'ace-step-v1.5', repo: 'ACE-Step/Ace-Step1.5', name: 'ACE-Step 1.5 (full song + vocals)' },
]);
export const DEFAULT_ACESTEP15_MODEL_ID = 'ace-step-v1.5';
// MiniMax Music 3 weights. The HF repo is ~57 GB, but `ModularPipeline`
// (what scripts/generate_minimax_music3.py loads) reads only the seven
// components named in the repo's modular_model_index.json: condition_encoder,
// language_model, rvq_depth_decoder, scheduler, tokenizer, transformer,
// vocoder — about 29 GB. The rest is the sglang-omni serving path: a bundled
// 20 GB Qwen-7B captioner under qwen_7B/ plus the original-format
// flowmatching_vae.pth / dav.pth checkpoints. `downloadIgnore` keeps those off
// the user's disk; it is fnmatch (not glob), so `*` spans `/` as well.
export const MINIMAX_MUSIC3_MODELS = Object.freeze([
  {
    id: 'minimax-music3',
    repo: 'MiniMaxAI/MiniMax-Music3',
    name: 'MiniMax-Music3 (CUDA, up to 5 minutes)',
    downloadIgnore: Object.freeze(['qwen_7B/*', 'flowmatching_vae.pth', 'dav.pth', 'figures/*']),
    downloadSizeGb: 29,
  },
]);

// VRAM requirements belong to the execution profile, not the model name.
export const MUSIC_VRAM_READINESS = Object.freeze({
  SUFFICIENT: 'sufficient',
  INSUFFICIENT: 'insufficient',
  UNKNOWN_SIZE: 'unknown-size',
});
// Measured on an RTX 3090 (24 GB): a fixed-seed, production-shaped full-length
// render (default 60s ceiling, natural length 41s) passed the technical
// benchmark (scripts/music_benchmark.py — clean WAV, negligible clipping, no
// truncation) with 18.3-18.7 GB peak reserved VRAM, plus a positive full-length
// listening review (issue #4359). `minVramGb` is set above the observed peak
// for desktop/driver headroom; only this card class has been validated, so
// `recommendedVramGb` matches it rather than claiming a lower comfortable tier.
export const MINIMAX_MUSIC3_VRAM_PROFILES = Object.freeze({
  'cuda-bf16-auto-experimental': Object.freeze({
    label: 'CUDA BF16 (automatic full-residency/offload placement)',
    minVramGb: 20,
    recommendedVramGb: 24,
  }),
});

// These are immutable HF revisions because a shipped model must not silently
// change underneath an existing install. The 8-bit conversion is the practical
// default for general Apple-Silicon installs (~14 GB); BF16 remains selectable
// as the larger unquantized reference (~29 GB) for high-memory systems.
export const MINIMAX_MUSIC3_MLX_MODELS = Object.freeze([
  {
    id: 'minimax-music3-mlx-8bit',
    repo: 'mlx-community/MiniMax-Music3-8bit',
    revision: '10aa4ca578d04c6f5256c1bc22fc8405a09602b5',
    downloadSizeGb: 14,
    name: 'MiniMax-Music3 MLX 8-bit (~14 GB, lower-memory default)',
  },
  {
    id: 'minimax-music3-mlx-bf16',
    repo: 'mlx-community/MiniMax-Music3-bf16',
    revision: '83a5f2d365673689df5c8f36e21e108751fd92ea',
    downloadSizeGb: 29,
    name: 'MiniMax-Music3 MLX BF16 (~29 GB, unquantized reference)',
  },
]);

/**
 * Backend registry. Each engine is fully described here so the route, UI and
 * `generateMusic` stay generator-agnostic. Fields:
 *   - `id`/`name`        — stable id (the contract stored on the request) + label
 *   - `models`/`defaultModelId` — selectable weights for this backend
 *   - duration window    — min/max/default seconds, clamped before spawn
 *   - `scriptPath`       — the Python sidecar
 *   - `runtimeDir`       — value for the sidecar's --runtime-dir flag
 *   - `resolvePython`    — () => venv interpreter path | null (readiness probe)
 *   - `healthProbe`      — python source proving the venv can actually run this
 *     backend. `resolvePython` only confirms the interpreter exists, and a
 *     failed/cancelled install leaves the interpreter with no packages — see
 *     isEngineHealthy below. Mirrors each engine's assertion in
 *     scripts/setup-image-video.sh; keep the two in sync.
 *   - `requiresPlatform` — hosts this backend can run on at all, when it is not
 *     portable. Absent means "anywhere". The installer already refuses on the
 *     wrong host, but without this the UI offers an Install button that exits 0
 *     having done nothing — see isEnginePlatformSupported below.
 *   - `venvDefault`/`installEnv` — install-hint pieces for the 503 message
 */
export const ENGINES = Object.freeze({
  musicgen: {
    id: 'musicgen',
    name: 'MusicGen (MLX)',
    models: MUSICGEN_MODELS,
    defaultModelId: DEFAULT_MUSICGEN_MODEL_ID,
    minDurationSec: 1,
    maxDurationSec: 30,
    defaultDurationSec: 12,
    scriptPath: MUSICGEN_SCRIPT,
    runtimeDir: MUSICGEN_RUNTIME_DIR,
    resolvePython: resolveMusicgenPython,
    venvDefault: MUSICGEN_VENV_DEFAULT,
    installEnv: 'INSTALL_MUSICGEN',
    // MLX is Apple-Silicon only, and the implementation lives in the
    // ml-explore/mlx-examples clone rather than a pip package — there is no
    // Windows/Linux path at all. Mirrors the is_macos guard in
    // scripts/setup-image-video.sh's INSTALL_MUSICGEN block.
    requiresPlatform: { platform: 'darwin', arch: 'arm64', label: 'macOS on Apple Silicon (MLX)' },
    // Mirrors the setup script's MusicGen assertion — the class lives in the
    // mlx-examples clone, so the probe re-creates the sidecar's sys.path insert.
    healthProbe: 'import sys; sys.path.insert(0, r"' + MUSICGEN_RUNTIME_DIR + '"); import torch; from musicgen import MusicGen',
    // The sidecar passes `--model <repo>` straight to from_pretrained, so any
    // HuggingFace MusicGen checkpoint works — user-installed models are usable.
    customModels: true,
  },
  audioldm2: {
    id: 'audioldm2',
    name: 'AudioLDM2 (diffusers)',
    models: AUDIOLDM2_MODELS,
    defaultModelId: DEFAULT_AUDIOLDM2_MODEL_ID,
    minDurationSec: 1,
    maxDurationSec: 120,
    defaultDurationSec: 20,
    scriptPath: AUDIOLDM2_SCRIPT,
    runtimeDir: AUDIOLDM2_RUNTIME_DIR,
    resolvePython: resolveAudioldm2Python,
    venvDefault: AUDIOLDM2_VENV_DEFAULT,
    installEnv: 'INSTALL_AUDIOLDM2',
    healthProbe: 'import torch; from diffusers import AudioLDM2Pipeline',
    // `--model <repo>` → AudioLDM2Pipeline.from_pretrained: any HF AudioLDM2
    // checkpoint works, so user-installed models are usable.
    customModels: true,
  },
  acestep: {
    id: 'acestep',
    name: 'ACE-Step (full song + vocals)',
    models: ACESTEP_MODELS,
    defaultModelId: DEFAULT_ACESTEP_MODEL_ID,
    minDurationSec: 1,
    maxDurationSec: 240,
    defaultDurationSec: 60,
    scriptPath: ACESTEP_SCRIPT,
    runtimeDir: ACESTEP_RUNTIME_DIR,
    resolvePython: resolveAcestepPython,
    venvDefault: ACESTEP_VENV_DEFAULT,
    installEnv: 'INSTALL_ACESTEP',
    healthProbe: 'import torch; from acestep.pipeline_ace_step import ACEStepPipeline',
    // ACE-Step is lyric-aware: the route/UI may send `lyrics`, threaded into the
    // sidecar as --lyrics. The other engines ignore lyrics (the flag gates UI).
    lyrics: true,
    // ACE-Step resolves a single foundation checkpoint via its own checkpoint_dir
    // (NOT a from_pretrained repo id), so an arbitrary HF repo can't be swapped
    // in like the diffusers/MLX engines. Custom-model install/selection is
    // therefore disabled for it (customModels falsy) — the sidecar ignores
    // --model by design.
    customModels: false,
  },
  acestep15: {
    id: 'acestep15',
    name: 'ACE-Step 1.5 (full song + vocals)',
    models: ACESTEP15_MODELS,
    defaultModelId: DEFAULT_ACESTEP15_MODEL_ID,
    minDurationSec: 1,
    // The vendor supports much longer compositions, but retain the established
    // studio window until a user-facing duration expansion is separately tested.
    maxDurationSec: 240,
    defaultDurationSec: 60,
    scriptPath: ACESTEP15_SCRIPT,
    runtimeDir: ACESTEP15_RUNTIME_DIR,
    resolvePython: resolveAcestep15Python,
    venvDefault: ACESTEP15_VENV_DEFAULT,
    installEnv: 'INSTALL_ACESTEP15',
    // ACE-Step 1.5's handler imports the fixed snapshot's custom
    // modeling_acestep_v15_turbo.py via transformers AutoModel trust_remote_code.
    // Probe the generation import path too (acestep.inference), not just the
    // handler — a venv missing that submodule would otherwise report healthy
    // and fail generation with a bare ImportError instead of the actionable
    // "runtime not found" 503.
    healthProbe: 'import torch; from transformers import AutoModel; from acestep.handler import AceStepHandler; from acestep.inference import GenerationConfig, GenerationParams, generate_music',
    lyrics: true,
    customModels: false,
    fixedModelInstall: true,
  },
  'minimax-music3': {
    id: 'minimax-music3',
    name: 'MiniMax-Music3 (CUDA only)',
    models: MINIMAX_MUSIC3_MODELS,
    defaultModelId: 'minimax-music3',
    minDurationSec: 1,
    maxDurationSec: 300,
    defaultDurationSec: 60,
    scriptPath: MINIMAX_MUSIC3_SCRIPT,
    runtimeDir: MINIMAX_MUSIC3_RUNTIME_DIR,
    resolvePython: resolveMinimaxMusic3Python,
    venvDefault: MINIMAX_MUSIC3_VENV_DEFAULT,
    installEnv: 'INSTALL_MINIMAX_MUSIC3',
    healthProbe: 'import torch; from diffusers import ModularPipeline',
    lyrics: true,
    // This checkpoint REJECTS empty lyrics — its tokenize step raises
    // "`lyrics` must be a non-empty string" before generation starts, so an
    // instrumental prompt cannot simply omit them. The model card's contract is
    // a structure-tag-only lyric sheet, and `[Instrumental]` is one of its
    // documented section tags. Engines without this field (ACE-Step) accept an
    // empty string and render an instrumental themselves.
    //
    // The sheet is built per-render rather than fixed, because `audio_duration`
    // is only a CEILING for this engine — see buildMinimaxInstrumentalLyrics.
    instrumentalLyrics: buildMinimaxInstrumentalLyrics,
    // Guarantee a closing section on the sheet (see ensureClosingSection) so the
    // model resolves its ending instead of cutting off mid-phrase at an
    // arbitrary time. Applied to both MiniMax Music 3 variants below (not
    // ACE-Step) — MiniMax is the one whose resolution point is an end-token
    // the user's draft may not cue.
    ensureOutro: true,
    // Auto mode sizes that ceiling from lyric words/sections and leaves room
    // for an ending. MiniMax may still stop earlier by design.
    autoDuration: true,
    customModels: false,
    fixedModelInstall: true,
    cudaRequired: true,
    executionProfile: 'cuda-bf16-auto-experimental',
    vramProfiles: MINIMAX_MUSIC3_VRAM_PROFILES,
    benchmarkGuide: MUSIC_RENDERER_BENCHMARK_GUIDE,
    requiresFullLengthListening: false,
  },
  'minimax-music3-mlx': {
    id: 'minimax-music3-mlx',
    name: 'MiniMax-Music3 (MLX, Apple Silicon)',
    models: MINIMAX_MUSIC3_MLX_MODELS,
    defaultModelId: 'minimax-music3-mlx-8bit',
    minDurationSec: 1,
    maxDurationSec: 300,
    defaultDurationSec: 60,
    scriptPath: MINIMAX_MUSIC3_MLX_SCRIPT,
    runtimeDir: MINIMAX_MUSIC3_MLX_RUNTIME_DIR,
    resolvePython: resolveMinimaxMusic3MlxPython,
    venvDefault: MINIMAX_MUSIC3_MLX_VENV_DEFAULT,
    installEnv: 'INSTALL_MINIMAX_MUSIC3_MLX',
    healthProbe: 'import mlx; from mlx_audio.music import load',
    lyrics: true,
    instrumentalLyrics: buildMinimaxInstrumentalLyrics,
    ensureOutro: true,
    autoDuration: true,
    customModels: false,
    fixedModelInstall: true,
    supportsModelRevision: true,
    requiresPlatform: {
      platform: 'darwin',
      arch: 'arm64',
      label: 'macOS on Apple Silicon (MLX)',
    },
  },
});

export const DEFAULT_ENGINE_ID = 'musicgen';

// Resolve a requested engine id to its registry entry, falling back to the
// default engine for unknown/absent ids (the route validates against the known
// set, but generateMusic can be called directly).
export function getEngine(engineId) {
  return ENGINES[engineId] || ENGINES[DEFAULT_ENGINE_ID];
}

// Look up a model within a specific engine. Returns null for unknown ids so the
// caller can fall back to the engine's default.
export function getEngineModel(engineId, modelId) {
  const engine = getEngine(engineId);
  return engine.models.find((m) => m.id === modelId) || null;
}

// Back-compat: MusicGen-specific model lookup (pre-multi-engine callers/tests).
export function getMusicgenModel(modelId) {
  return MUSICGEN_MODELS.find((m) => m.id === modelId) || null;
}

// Whether this host can run a backend at all. An engine with no
// `requiresPlatform` is portable and always supported. Distinct from every other
// readiness signal: the others describe something the user can fix by
// installing, this one never becomes true here. Without it the UI offers an
// Install button that runs the setup script, hits its own platform guard, prints
// "Skipping.", and exits 0 — reported back as "installer exited 0 but the engine
// is still not available", which reads like a broken install rather than an
// unsupported host.
export function isEnginePlatformSupported(engineId) {
  const { requiresPlatform } = getEngine(engineId);
  if (!requiresPlatform) return true;
  if (requiresPlatform.platform && osPlatform() !== requiresPlatform.platform) return false;
  if (requiresPlatform.arch && osArch() !== requiresPlatform.arch) return false;
  return true;
}

// Human-readable requirement for the UI's "unavailable on this host" copy, or
// null for a portable engine.
export function enginePlatformLabel(engineId) {
  return getEngine(engineId).requiresPlatform?.label || null;
}

/**
 * Resolve a VRAM contract without collapsing an unreadable measurement into
 * zero. Keeping this pure makes the three readiness states testable without a
 * CUDA host and lets callers use the exact same comparison at every boundary.
 */
export function resolveVramReadiness({ cudaStatus, maxVramGb, minVramGb } = {}) {
  if (!Number.isFinite(minVramGb) || cudaStatus !== 'available' || !Number.isFinite(maxVramGb)) {
    return MUSIC_VRAM_READINESS.UNKNOWN_SIZE;
  }
  return maxVramGb >= minVramGb
    ? MUSIC_VRAM_READINESS.SUFFICIENT
    : MUSIC_VRAM_READINESS.INSUFFICIENT;
}

/**
 * Resolve the selected engine's execution-profile requirement against the
 * largest CUDA card reported by cudaCapability. Portable engines are
 * sufficient by definition; CUDA engines with no measured profile remain
 * unknown-size and are fail-closed by install/generation callers.
 */
export function resolveEngineVramReadiness(engineId, cuda = {}) {
  const engine = getEngine(engineId);
  const profile = engine.vramProfiles?.[engine.executionProfile] || null;
  const state = engine.cudaRequired
    ? resolveVramReadiness({
      cudaStatus: cuda.status,
      maxVramGb: cuda.maxVramGb,
      minVramGb: profile?.minVramGb,
    })
    : MUSIC_VRAM_READINESS.SUFFICIENT;
  return {
    state,
    executionProfile: engine.executionProfile || null,
    profileLabel: profile?.label || null,
    minVramGb: profile?.minVramGb ?? null,
    recommendedVramGb: profile?.recommendedVramGb ?? null,
    maxVramGb: Number.isFinite(cuda.maxVramGb) ? cuda.maxVramGb : null,
  };
}

export function formatEngineVramReadinessMessage(engineId, readiness, action = 'run') {
  const engine = getEngine(engineId);
  if (readiness?.state === MUSIC_VRAM_READINESS.INSUFFICIENT) {
    return `${engine.name} requires at least ${readiness.minVramGb} GB of VRAM for the ${readiness.profileLabel || 'selected'} profile; this host reports ${readiness.maxVramGb} GB.`;
  }
  if (readiness?.state === MUSIC_VRAM_READINESS.UNKNOWN_SIZE) {
    return `${engine.name} cannot be ${action} because the GPU VRAM requirement has not been measured for the ${readiness.profileLabel || 'selected'} execution profile.`;
  }
  return null;
}

// Whether a backend's venv interpreter exists. Cheap (an existsSync behind the
// resolver's cache) but NOT sufficient for a readiness verdict — a failed
// install leaves the interpreter with no packages, and this still says yes.
// Prefer `isEngineHealthy` for anything that gates install/generate UI; this
// stays as the synchronous "is there a venv at all" primitive.
export function isEngineReady(engineId) {
  return getEngine(engineId).resolvePython() !== null;
}

// Whether a backend's venv can actually RUN — not just whether its interpreter
// file exists. An install that dies partway (pip resolve failure, a killed
// child, a lost network) leaves `venv-<engine>/…/python` behind with none of the
// packages, and `isEngineReady` reports that corpse as provisioned forever: the
// install endpoint then short-circuits with "already installed", the UI hides
// the install affordance, and the engine can never be repaired from the app.
// Same failure `isFlux2VenvHealthy` exists to prevent for the FLUX.2 venv.
//
// Cached per engine because the probe spawns a Python process. `refresh: true`
// forces a re-probe — the install path passes it so a venv that broke after the
// last check is re-examined instead of trusting a stale `true`.
const engineHealthCache = new Map();

export async function isEngineHealthy(engineId, { refresh = false } = {}) {
  const engine = getEngine(engineId);
  // A host that can never run this backend is never healthy, and probing it
  // would spawn a python that cannot exist.
  if (!isEnginePlatformSupported(engine.id)) return false;
  if (refresh) engineHealthCache.delete(engine.id);
  else if (engineHealthCache.has(engine.id)) return engineHealthCache.get(engine.id);

  const python = engine.resolvePython();
  if (!python) {
    engineHealthCache.set(engine.id, false);
    return false;
  }
  // No declared probe → fall back to the interpreter-exists verdict rather than
  // guessing an import and reporting a working engine as broken.
  if (!engine.healthProbe) {
    engineHealthCache.set(engine.id, true);
    return true;
  }
  const healthy = await execFileAsync(python, ['-c', engine.healthProbe], safeChildProcessOptions({
    timeout: 60_000,
  })).then(() => true).catch(() => false);
  engineHealthCache.set(engine.id, healthy);
  return healthy;
}

// Drop a cached health verdict (or all of them). Called after an install so the
// next readiness check re-probes the freshly-built venv.
export function invalidateEngineHealth(engineId = null) {
  if (engineId) engineHealthCache.delete(engineId);
  else engineHealthCache.clear();
}

// Back-compat: MusicGen readiness probe.
export function isMusicGenReady() {
  return resolveMusicgenPython() !== null;
}

// Clamp a requested duration into an engine's usable window. Non-finite input
// falls back to that engine's default rather than throwing — the route
// validates shape, this guards the math. `engineId` defaults to the module's
// default engine so the back-compat signature `clampDuration(seconds)` keeps
// the original MusicGen window.
export function clampDuration(durationSec, engineId = DEFAULT_ENGINE_ID) {
  const engine = getEngine(engineId);
  const n = Number(durationSec);
  if (!Number.isFinite(n)) return engine.defaultDurationSec;
  return Math.max(engine.minDurationSec, Math.min(engine.maxDurationSec, n));
}

// Section tags for a MiniMax Music 3 instrumental body, cycled to pad the sheet
// out. Restricted to the tags the model card documents, and to the ones that
// don't imply a vocal line ([verse]/[chorus] would) — an instrumental render
// should not coax the model into singing.
const MINIMAX_INSTRUMENTAL_BODY = Object.freeze(['instrumental', 'bridge', 'instrumental', 'solo']);
// Roughly how much audio one body section buys. Deliberately pessimistic:
// `audio_duration` still truncates hard at the requested length, so an
// over-provisioned sheet costs nothing while an under-provisioned one is the
// bug this exists to fix.
const MINIMAX_SEC_PER_SECTION = 20;
const MINIMAX_MAX_BODY_SECTIONS = 12;

/**
 * Build MiniMax Music 3's structure-tag lyric sheet for an instrumental render,
 * sized to the requested duration.
 *
 * MiniMax Music 3 treats `audio_duration` as an UPPER BOUND, not a target: its
 * global LLM emits `<|audio_end|>` whenever it decides the piece is finished
 * and the autoregressive loop breaks there (see the diffusers
 * `MiniMaxMusic3AutoregressiveStep` — "The language model may stop earlier").
 * What actually paces the song is the lyric sheet's section tags. A one-tag
 * sheet is one section long, so a 60s request came back at 25s. Giving
 * the model a section count proportionate to the ask is the only lever the
 * architecture exposes — and per the model card, tags are "generative control
 * rather than strict symbolic guarantees", so this raises the expected length
 * without promising it.
 */
export function buildMinimaxInstrumentalLyrics(durationSec) {
  const seconds = clampDuration(durationSec, 'minimax-music3');
  // The intro and outro carry their own runtime, so only the remainder needs
  // body sections. At least one body section always survives the floor.
  const bodyCount = Math.min(
    MINIMAX_MAX_BODY_SECTIONS,
    Math.max(1, Math.ceil((seconds - MINIMAX_SEC_PER_SECTION) / MINIMAX_SEC_PER_SECTION)),
  );
  const body = Array.from({ length: bodyCount }, (_, i) => MINIMAX_INSTRUMENTAL_BODY[i % MINIMAX_INSTRUMENTAL_BODY.length]);
  return ['intro', ...body, 'outro'].map((tag) => `[${tag}]`).join('\n');
}

// A section tag alone on (or leading) a line, matching the same detection the
// duration heuristic uses (`analyzeMusicLyrics`).
const MINIMAX_LEADING_TAG = /^\[([^\]\r\n]+)\]/;
// A closing cue, case-insensitive and word-bounded, so `[outro]` and `[outro
// fade]` count but `[outroduction]` does not — identical to the
// `hasOutro` signal in server/lib/musicDuration.js.
const MINIMAX_OUTRO_TAG = /^outro\b/i;

/**
 * Guarantee a closing section on a MiniMax Music 3 lyric sheet.
 *
 * MiniMax resolves its ending wherever the global LLM emits an end token (its
 * autoregressive loop breaks there — "the language model may stop earlier"), and
 * the only pacing lever is the sheet's section tags. A sheet whose last section
 * is a verse/chorus/bridge gives the model no cue for "this is where the song
 * ends", so it can resolve mid-phrase at an arbitrary time — the "renders end
 * abruptly, no conclusion" report. Appending an explicit `[outro]` hands the
 * model a closing structure without touching any section the user wrote.
 *
 * Idempotent: a sheet whose LAST section already carries an outro tag is returned
 * unchanged, so the instrumental fallback (which already closes with `[outro]`)
 * is untouched and a user's own closing `[outro]` is never duplicated.
 */
export function ensureClosingSection(lyrics) {
  const text = typeof lyrics === 'string' ? lyrics : '';
  const lastTag = text
    .split(/\r?\n/)
    .map((raw) => MINIMAX_LEADING_TAG.exec(raw.trim()))
    .filter(Boolean)
    .at(-1);
  if (lastTag && MINIMAX_OUTRO_TAG.test(lastTag[1].trim())) return text;
  const trimmed = text.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n[outro]` : '[outro]';
}

/**
 * Build the `{ bin, args }` for a backend's sidecar. Pure — unit-tested without
 * spawning Python. All sidecars share the same base flag contract
 * (`--model/--text/--duration/--output/--runtime-dir`), so one builder serves
 * every engine; `engineId` selects the duration window + script + runtime dir.
 * Engines with immutable shipped snapshots can opt into `--revision` so the
 * Python loader and the local cache inspect the same HF commit.
 * Lyric-aware engines (`engine.lyrics`, e.g. ACE-Step) additionally get
 * `--lyrics`; non-lyric engines never receive the flag (their sidecars don't
 * define it), so a stray lyrics arg can't break a MusicGen/AudioLDM2 spawn.
 */
export function buildSidecarArgs({ engineId = DEFAULT_ENGINE_ID, pythonPath, scriptPath, runtimeDir, repo, revision, prompt, lyrics, durationSec, outputPath }) {
  const engine = getEngine(engineId);
  const seconds = clampDuration(durationSec, engine.id);
  const args = [
    scriptPath ?? engine.scriptPath,
    '--model', repo,
    ...(engine.supportsModelRevision && revision ? ['--revision', revision] : []),
    // Prompts are authored in a plain textarea that many users type markdown
    // into out of habit. Every backend's text encoder tokenizes `**` and `_`
    // as literal content, so the emphasis markers become conditioning noise —
    // strip them and keep the words.
    '--text', stripMarkdownEmphasis(prompt).trim(),
    '--duration', String(seconds),
    '--output', outputPath,
    '--runtime-dir', runtimeDir ?? engine.runtimeDir,
  ];
  if (engine.lyrics) {
    // Preserve the caller's string when they supplied one; substitute only when
    // it is absent or whitespace, and only for an engine that cannot accept
    // empty lyrics (see instrumentalLyrics). The substitute may be a builder
    // that sizes the sheet to the render length. `ensureOutro` engines may
    // still append a closing section to either sheet below.
    const provided = typeof lyrics === 'string' ? lyrics : '';
    const fallback = typeof engine.instrumentalLyrics === 'function'
      ? engine.instrumentalLyrics(seconds)
      : (engine.instrumentalLyrics || '');
    const sheet = provided.trim() ? provided : fallback;
    // ensureOutro engines resolve on an end-token the draft may not cue —
    // guarantee one on whatever sheet reaches the model, idempotently.
    args.push('--lyrics', engine.ensureOutro ? ensureClosingSection(sheet) : sheet);
  }
  return { bin: pythonPath, args };
}

/**
 * Back-compat wrapper: build the MusicGen sidecar argv. Pre-existing callers
 * and tests use this name; it forwards to the engine-agnostic builder pinned to
 * the `musicgen` engine.
 */
export function buildMusicGenArgs({ pythonPath, scriptPath = SIDECAR_SCRIPT, runtimeDir = MUSICGEN_RUNTIME_DIR, repo, prompt, durationSec, outputPath }) {
  return buildSidecarArgs({ engineId: 'musicgen', pythonPath, scriptPath, runtimeDir, repo, prompt, durationSec, outputPath });
}

/**
 * Generate a background-music track and land it in the shared music library.
 * Returns `{ filename, durationSec, modelId, model, engine }`. Throws a
 * ServerError (503) when the selected backend's venv isn't provisioned, or
 * (500) when the sidecar exits non-zero / produces no result.
 *
 * `engine` selects the backend (`musicgen` | `audioldm2` | `acestep` |
 * `acestep15` | `minimax-music3` | `minimax-music3-mlx`); unknown
 * ids fall back to the default. `modelId` is resolved within that engine's
 * registry. `lyrics` is forwarded only to lyric-aware engines; other engines
 * ignore it. `signal` (optional AbortSignal) SIGTERMs the child — wired
 * through so a cancel button can abort a long render. `onActivity` (optional)
 * fires once per `STAGE:` line the sidecar emits — the media-job queue's
 * generic idle watchdog resets its timer off it via the audio job-kind
 * adapter (server/services/audioGen/local.js), the same way the image/video
 * sidecars' stderr lines do, so a slow first-run model download doesn't trip a
 * flat timeout. Callers outside the queue (the Pipeline Audio routes) omit it
 * and behave exactly as before.
 */
export async function generateMusic({ prompt, lyrics, engine: engineId = DEFAULT_ENGINE_ID, durationSec, durationMode, modelId, repo, provenance, signal, onActivity } = {}) {
  const text = (prompt || '').trim();
  if (!text) {
    throw new ServerError('prompt is required', { status: 400, code: 'PIPELINE_MUSIC_EMPTY_PROMPT' });
  }
  const engine = getEngine(engineId);
  // `repo` (when given) is an explicit HF checkpoint — used for USER-INSTALLED
  // models that aren't in the shipped ENGINES registry (the caller resolved it
  // from the audio-models registry). It overrides the registry lookup so an
  // installed model actually renders instead of silently falling back to the
  // engine default. `modelId` is still reported for metadata.
  const shippedModel = getEngineModel(engine.id, modelId) || getEngineModel(engine.id, engine.defaultModelId);
  const model = repo
    ? { id: modelId || repo, repo, name: modelId || repo }
    : shippedModel;
  const resolvedDuration = durationMode === 'auto' && engine.autoDuration
    ? recommendMinimaxDurationSec(lyrics, {
      minDurationSec: engine.defaultDurationSec,
      maxDurationSec: engine.maxDurationSec,
    })
    : durationSec ?? engine.defaultDurationSec;
  const pythonPath = engine.resolvePython();
  if (engine.cudaRequired) {
    const cuda = await getCudaCapability();
    if (cuda.status !== 'available') {
      throw new ServerError(
        cuda.status === 'unknown' ? 'CUDA availability could not be determined.' : `${engine.name} requires an NVIDIA CUDA GPU.`,
        { status: 503, code: 'PIPELINE_MUSIC_CUDA_REQUIRED' },
      );
    }
    const vram = resolveEngineVramReadiness(engine.id, cuda);
    if (vram.state !== MUSIC_VRAM_READINESS.SUFFICIENT) {
      throw new ServerError(formatEngineVramReadinessMessage(engine.id, vram), {
        status: 503,
        code: vram.state === MUSIC_VRAM_READINESS.INSUFFICIENT
          ? 'PIPELINE_MUSIC_VRAM_INSUFFICIENT'
          : 'PIPELINE_MUSIC_VRAM_UNKNOWN',
      });
    }
  }
  if (engine.fixedModelInstall) {
    const cache = await inspectModelCache(model.repo, { revision: model.revision }).catch(() => ({ cached: false }));
    if (!cache.cached) {
      throw new ServerError(`${engine.name} model weights are not installed. Install them from Music before generating.`, {
        status: 503, code: 'PIPELINE_MUSIC_MODEL_MISSING',
      });
    }
  }
  // Health, not just "the interpreter file is there". A venv left half-built by
  // a failed install passes the path check and then dies inside the sidecar with
  // a raw ImportError traceback; this turns that into the actionable 503 the
  // module contract promises. Subsumes the old `!pythonPath` guard — a missing
  // interpreter is unhealthy by definition, and is answered without a spawn. The
  // verdict is cached, so this costs one spawn per engine per process.
  if (!await isEngineHealthy(engine.id)) {
    throw new ServerError(
      `${engine.name} runtime not found. Run \`${engine.installEnv}=1 bash scripts/setup-image-video.sh\` to bootstrap it (expected venv at ${engine.venvDefault}).`,
      { status: 503, code: 'PIPELINE_MUSIC_RUNTIME_MISSING' },
    );
  }

  await ensureDir(PATHS.music);
  const filename = `music-gen-${randomUUID()}.wav`;
  const outputPath = join(PATHS.music, filename);
  const { bin, args } = buildSidecarArgs({ engineId: engine.id, pythonPath, repo: model.repo, revision: model.revision, prompt: text, lyrics, durationSec: resolvedDuration, outputPath });

  console.log(`🎼 Generating music [${engine.id}/${model.id}] ${clampDuration(resolvedDuration, engine.id)}s: "${text.slice(0, 60)}"`);
  // The default backends use ungated HF weights (facebook/* and cvssp/*), so a
  // token isn't required — but pass it through when the user has one set so the
  // first download doesn't hit anonymous HF rate limits.
  const env = await hfChildEnv();
  // STAGE: lines are echoed to pm2 logs so a stuck first-run model download is
  // visible, and fire onActivity so the media-job queue's idle watchdog resets
  // (see the doc block above).
  const result = await runSidecarProcess({
    bin, args, env, signal,
    onStage: (stage, detail, raw) => {
      console.log(`🎼 ${engine.id} ${raw}`);
      onActivity?.();
    },
  });
  // A clean exit isn't enough — the sidecar could exit 0 yet write nothing (or
  // a truncated file) if the runtime changes shape. Require both a parsed
  // RESULT line AND a non-empty file on disk before we persist the library
  // pointer; otherwise unlink the partial and fail, so the audio stage never
  // attaches a dangling/empty track.
  const parsed = result.ok ? parseSidecarResult(result.stdout) : null;
  const wroteFile = existsSync(outputPath) && statSync(outputPath).size > 0;
  const executionProfile = typeof parsed?.executionProfile === 'string'
    ? parsed.executionProfile
    : null;
  if (!result.ok || !parsed || !wroteFile) {
    await unlink(outputPath).catch(() => {});
    const reason = !result.ok ? result.reason : (!wroteFile ? 'sidecar wrote no audio' : 'sidecar returned no result');
    throw new ServerError(`Music generation failed: ${reason}`, {
      status: 500, code: 'PIPELINE_MUSIC_GEN_FAILED',
    });
  }
  return {
    filename,
    durationSec: Number.isFinite(parsed.durationSec) ? parsed.durationSec : clampDuration(resolvedDuration, engine.id),
    modelId: model.id,
    model: model.name,
    engine: engine.id,
    ...(executionProfile ? { executionProfile } : {}),
    ...(provenance ? { provenance } : {}),
  };
}
