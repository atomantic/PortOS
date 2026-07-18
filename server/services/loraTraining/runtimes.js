/**
 * LoRA training runtime routing + argument/config builders. Pure — no I/O.
 *
 * Both runtimes train FLUX.2 Klein character LoRAs; they are two ENGINES
 * for the same output (verified against mflux 0.17.5, which removed
 * FLUX.1 training entirely):
 *
 *   - 'mflux' — MLX-native training via mflux's `mflux-train` CLI,
 *     wrapped by scripts/train_mflux_lora.py. Preferred on Apple Silicon
 *     when the user's mflux install ships the trainer. Trains the
 *     non-distilled `flux2-klein-base-{4b,9b}` models (mflux's documented
 *     recommendation) and exports adapters with diffusers-style key
 *     naming (`transformer.transformer_blocks.N...lora_A.weight`), so
 *     the result loads in PortOS's diffusers-based flux2 renderer.
 *   - 'flux2' — torch/diffusers+peft training via the vendored
 *     scripts/train_flux2_lora.py in ~/.portos/venv-flux2. The fallback
 *     when mflux's trainer is unavailable (non-Darwin installs, older
 *     mflux). Trains against the bf16 base repos.
 *
 * Either way the trained LoRA is gated to its size variant via the
 * `flux2-4b` / `flux2-9b` compat key (hidden dims differ between sizes).
 */

import { ServerError } from '../../lib/errorHandler.js';
import { isFlux2, flux2VariantFromModel, FLUX2_BF16_BASE_REPOS } from '../../lib/runners.js';

export const TRAINING_RUNTIMES = Object.freeze({ MFLUX: 'mflux', FLUX2: 'flux2' });

// Defaults validated 2026-06-15 on a real-face character LoRA (44-image dataset,
// FLUX.2 Klein 9B 4-bit): identity bound cleanly and fast, stable through the run.
// History worth knowing before lowering these again: an earlier run "diverged"
// (sample collapsed to black) and the defaults were cut to 600 steps / lr 5e-5 /
// rank 16 — but the real cause was captions over-describing invariant identity
// (it bound to the words, not the trigger), NOT the learning rate. With good
// captions, lr 1e-4 + rank 32 + ~1200 steps converges faster and sharper without
// collapse. 768 captures more facial detail than 512; checkpoint/sample cadence
// gives the picker several healthy steps to choose from. The base model + quant
// tier are chosen elsewhere (deriveMfluxMemoryConfig + the base-model picker,
// which prefers 9B); these are the per-run hyperparameters the form seeds from.
export const TRAINING_DEFAULTS = Object.freeze({
  steps: 1200,
  rank: 32,
  learningRate: 0.0001,
  resolution: 768,
  checkpointEvery: 300,
  sampleEvery: 300,
});

// bf16 training bases per FLUX.2 size variant (torch runtime). Inference may
// run quantized repos; training resolves to these regardless of which flux2-*
// model id the user picked. Same repos the image runner renders a LoRA against
// (PEFT can't load onto quantized weights) — one source of truth in runners.js.
export const FLUX2_TRAIN_REPOS = FLUX2_BF16_BASE_REPOS;

// mflux model ids per size variant. mflux's flux2 README recommends the
// non-distilled base models for training; the resulting adapter applies to
// the distilled inference models of the same size (identical module names
// and hidden dims).
export const MFLUX_TRAIN_MODELS = Object.freeze({
  '4b': 'flux2-klein-base-4b',
  '9b': 'flux2-klein-base-9b',
});

// Crash-resilience floor: guarantee at least this many checkpoints across a
// run regardless of the user's checkpointEvery. macOS GPU watchdog-timeout
// kernel panics during sustained mflux training (see docs/TROUBLESHOOTING.md
// "GPU watchdog kernel panic") hard-reboot the machine mid-run; without a
// floor, checkpointEvery=0 ("only final save") or a very large interval means
// such a crash discards the entire run. Capping the interval at
// totalSteps/MIN_CHECKPOINTS bounds the worst-case loss to ~1/N of the run.
export const MFLUX_MIN_CHECKPOINTS = 4;

// Noise-schedule shape for mflux base-model training — mirrors the official
// flux2 README example (steps 40, guidance 1.0, train the high-noise window
// [25, 40)). These are INFERENCE-schedule steps, distinct from the training
// duration (num_epochs × images).
const MFLUX_SCHED = Object.freeze({ steps: 40, guidance: 1.0, timestepLow: 25, timestepHigh: 40 });

/**
 * Memory-derived training knobs — mirrors the FFLF pixel-budget pattern
 * (videoGen/local.js): pure, with total RAM injected by the caller.
 * Training a bf16 base + in-RAM latent cache OOM-killed a 48 GB machine
 * during verification, so every tier trains QLoRA-style against an
 * on-the-fly-quantized base. The encoded dataset cache ALWAYS spills to
 * disk (`low_ram`): keeping it in RAM bought nothing but pushed a 128 GB box
 * to 122 GB used + 21 GB swap (the swap-thrash that coincided with GPU
 * watchdog reboots — see docs/research/2026-06-13-mflux-training-watchdog-panic.md);
 * disk-backing it costs only I/O, no training quality. Quantizing the FROZEN
 * base is the standard QLoRA recipe — the LoRA weights stay full precision.
 *
 * Default tier never auto-selects unquantized bf16 (issue #1321): even a
 * ≥96 GB box gets 8-bit QLoRA, not bf16. The bf16 9B path was pathologically
 * slow (couldn't complete a step in 14 min on an M5 Max 128 GB) AND the config
 * that GPU-watchdog-panicked the box three times
 * (docs/research/2026-06-13-mflux-training-watchdog-panic.md) — so it's opt-in
 * only, never the silent default. 8-bit QLoRA is the standard character-LoRA
 * recipe with minimal fidelity loss; a run that genuinely wants a heavier base
 * asks for it explicitly via `baseQuant: 16` (→ `quantize: null`).
 *
 * Callers feed the *available* memory budget (post-unload, see memoryPrep.js),
 * not raw RAM, so the tier reflects real headroom on a shared box.
 *
 * Override (`LORA_TRAIN_MAX_QUANT_BITS`): a hard per-install ceiling on the
 * frozen-base bit-width. Setting it to `4` forces every tier (and every per-run
 * opt-in) down to 4-bit; setting it to `8` clamps an explicit `baseQuant: 16`
 * bf16 opt-in back to 8-bit (the 8-bit default is already at/under the cap, so
 * it's a no-op there). Unset → the memory-derived tier plus whatever a run opts
 * into. Accepts 8 or 4; anything else is ignored.
 *
 * Per-run overrides (`overrides = { quantize?, low_ram? }`, issue #1321): a
 * single run can opt into a heavier or lighter frozen base than its memory tier
 * without a code change (exposed as the `baseQuant`/`lowRam` request params).
 * `quantize` present — including `null` (bf16) — replaces the derived tier;
 * `low_ram` boolean replaces the derived spill setting; absent keys keep the
 * memory-derived value. The `LORA_TRAIN_MAX_QUANT_BITS` cap still applies AFTER
 * the override, so a per-run opt-in can never exceed a box's hard safety
 * ceiling (the cap only ever makes the base lighter, never heavier).
 */
export function deriveMfluxMemoryConfig(totalMemGb, overrides = {}) {
  const gb = Number.isFinite(totalMemGb) ? totalMemGb : 0; // unknown → most conservative
  // bf16 is never the auto default (issue #1321) — the top tier is 8-bit QLoRA,
  // not unquantized bf16, even at ≥96 GB (bf16 9B was pathologically slow and
  // GPU-watchdog-panicked the box). A run opts into bf16 explicitly via
  // `baseQuant: 16`. Tighter budgets step down to 4-bit.
  const result = gb >= 64
    ? { quantize: 8, low_ram: true }
    : { quantize: 4, low_ram: true };
  // Request override wins over the memory-derived tier. hasOwnProperty (not a
  // truthiness check) so an explicit `quantize: null` (bf16) is honored as a
  // deliberate clear, not mistaken for "absent".
  if (Object.prototype.hasOwnProperty.call(overrides, 'quantize')) {
    result.quantize = overrides.quantize;
  }
  if (typeof overrides.low_ram === 'boolean') {
    result.low_ram = overrides.low_ram;
  }
  const capRaw = Number.parseInt(process.env.LORA_TRAIN_MAX_QUANT_BITS ?? '', 10);
  if (capRaw === 8 || capRaw === 4) {
    // null (bf16) is "16+ bits" → always capped; an existing smaller quant
    // (more aggressive) is kept. Lower bits = smaller = stays. Applied last so
    // it clamps the post-override value, not just the memory tier.
    const curBits = result.quantize == null ? 16 : result.quantize;
    if (curBits > capRaw) result.quantize = capRaw;
  }
  return result;
}

/**
 * Resolve the runtime + repos for a base model id. `models` is the
 * getImageModels() registry; `mlxAvailable` says whether the user's mflux
 * install ships `mflux-train` (probed by the caller — this stays pure).
 */
export function resolveTrainingRuntime(baseModelId, models, { mlxAvailable = false } = {}) {
  const entry = (models || []).find((m) => m.id === baseModelId);
  if (!entry) {
    throw new ServerError(`Unknown image model: ${baseModelId}`, {
      status: 400, code: 'TRAINING_UNSUPPORTED_MODEL',
    });
  }
  if (!isFlux2(entry)) {
    // mflux ≥0.17 removed FLUX.1 training ("Flux1 training is no longer
    // supported"), so dev/schnell and the diffusers families are all out.
    throw new ServerError(
      `LoRA training supports FLUX.2 Klein models only — not ${baseModelId}`,
      { status: 400, code: 'TRAINING_UNSUPPORTED_MODEL' },
    );
  }
  const variant = flux2VariantFromModel(entry);
  if (!variant || !FLUX2_TRAIN_REPOS[variant]) {
    throw new ServerError(
      `Cannot determine FLUX.2 size variant for ${baseModelId} — training needs a klein-4B/9B model`,
      { status: 400, code: 'TRAINING_UNSUPPORTED_MODEL' },
    );
  }
  return {
    runtime: mlxAvailable ? TRAINING_RUNTIMES.MFLUX : TRAINING_RUNTIMES.FLUX2,
    entry,
    variant,
    trainRepo: FLUX2_TRAIN_REPOS[variant],
    mfluxModel: MFLUX_TRAIN_MODELS[variant],
  };
}

const mergedParams = (params = {}) => ({ ...TRAINING_DEFAULTS, ...params });

// The full attention + feed-forward target set from mflux's flux2 training
// README, parameterized by rank and the variant's block counts. Klein 4B:
// 5 double + 20 single blocks; 9B: 8 double + 24 single (counts from the
// model configs; an over-long range would throw at injection, so these are
// pinned per variant).
const FLUX2_BLOCK_COUNTS = Object.freeze({
  '4b': { double: 5, single: 20 },
  '9b': { double: 8, single: 24 },
});

export function buildMfluxLoraTargets(variant, rank) {
  const counts = FLUX2_BLOCK_COUNTS[variant] || FLUX2_BLOCK_COUNTS['4b'];
  const doubleRange = { start: 0, end: counts.double };
  const singleRange = { start: 0, end: counts.single };
  const doublePaths = [
    'attn.to_q', 'attn.to_k', 'attn.to_v', 'attn.to_out',
    'attn.add_q_proj', 'attn.add_k_proj', 'attn.add_v_proj', 'attn.to_add_out',
    'ff.linear_in', 'ff.linear_out', 'ff_context.linear_in', 'ff_context.linear_out',
  ];
  const singlePaths = ['attn.to_qkv_mlp_proj', 'attn.to_out'];
  return [
    ...doublePaths.map((p) => ({ module_path: `transformer_blocks.{block}.${p}`, blocks: doubleRange, rank })),
    ...singlePaths.map((p) => ({ module_path: `single_transformer_blocks.{block}.${p}`, blocks: singleRange, rank })),
  ];
}

/**
 * Build the mflux-train config JSON (mflux ≥0.17 schema — verified against
 * TrainingSpec.from_conf). Captions are NOT in the config: mflux
 * auto-discovers `NNNN.png` + `NNNN.txt` pairs under `data`, and preview
 * prompts come from `data/preview*.txt` — the run-staging step lays those
 * files out. "steps" in OUR params means total training iterations; mflux
 * counts epochs over the example set, so we translate.
 */
export function buildMfluxTrainConfig({
  params = {},
  variant,
  mfluxModel,
  dataDir,
  imageCount,
  outputDir,
  totalMemGb = null,
}) {
  const p = mergedParams(params);
  if (!Number.isInteger(imageCount) || imageCount < 1) {
    throw new ServerError('mflux train config needs at least one example image', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  const totalSteps = p.steps;
  const epochs = Math.max(1, Math.round(totalSteps / imageCount));
  // save_frequency must be > 0; 0/absent checkpointEvery → only the final
  // save (frequency = total). The crash-resilience floor then caps the
  // interval so a hard reboot mid-run loses at most ~1/MIN_CHECKPOINTS of it.
  const requestedSaveFrequency = p.checkpointEvery > 0 ? p.checkpointEvery : totalSteps;
  const maxSaveInterval = Math.max(1, Math.ceil(totalSteps / MFLUX_MIN_CHECKPOINTS));
  const saveFrequency = Math.min(requestedSaveFrequency, maxSaveInterval);
  // Per-run base-tier overrides (issue #1321): `baseQuant` lets a run pick the
  // frozen-base quant — 16 = unquantized bf16 (mflux `quantize: null`), 8/4 =
  // QLoRA bit-width — and `lowRam` toggles the on-disk latent-cache spill,
  // independent of the memory-derived default. mflux-only knobs (the torch
  // runtime always trains the bf16 base); absent → memory-derived tier.
  const memoryOverride = {};
  if (p.baseQuant != null) memoryOverride.quantize = p.baseQuant >= 16 ? null : p.baseQuant;
  if (typeof p.lowRam === 'boolean') memoryOverride.low_ram = p.lowRam;
  const memory = deriveMfluxMemoryConfig(totalMemGb, memoryOverride);
  return {
    model: mfluxModel,
    data: dataDir,
    seed: Number.isInteger(p.seed) ? p.seed : 42,
    steps: MFLUX_SCHED.steps,
    guidance: MFLUX_SCHED.guidance,
    quantize: memory.quantize,
    max_resolution: p.resolution,
    low_ram: memory.low_ram,
    training_loop: {
      num_epochs: epochs,
      batch_size: 1,
      timestep_low: MFLUX_SCHED.timestepLow,
      timestep_high: MFLUX_SCHED.timestepHigh,
    },
    optimizer: { name: 'AdamW', learning_rate: p.learningRate },
    checkpoint: { save_frequency: saveFrequency, output_path: outputDir },
    // monitoring omitted entirely when samples are off — mflux treats the
    // whole block as optional and skips previews/plots without it.
    ...(p.sampleEvery > 0 ? {
      monitoring: {
        preview_width: p.resolution,
        preview_height: p.resolution,
        plot_frequency: p.sampleEvery,
        generate_image_frequency: p.sampleEvery,
      },
    } : {}),
    lora_layers: { targets: buildMfluxLoraTargets(variant, p.rank) },
  };
}

// Default GPU cooldown (seconds) between training segments — long enough for
// the GPU to clock down and the system to settle after a full Metal-context
// teardown, short relative to a segment's compute. See the segmentation block
// in scripts/train_mflux_lora.py and the watchdog-panic incident record.
export const MFLUX_DEFAULT_COOLDOWN_SEC = 90;

/**
 * Argv for the mflux wrapper script.
 *
 * `segmentSteps > 0` enables segmented training (watchdog-panic mitigation):
 * the wrapper trains one checkpoint interval, tears down the GPU child, cools
 * down `cooldownSec`, then resumes — so sustained GPU pressure never spans the
 * whole run. Pass `segmentSteps = the effective save_frequency` so each segment
 * ends exactly on a checkpoint. `segmentSteps = 0` keeps the single-process run.
 */
export function buildMfluxTrainArgs({
  scriptPath,
  configPath,
  runDir,
  totalSteps,
  resumeCheckpoint = null,
  segmentSteps = 0,
  cooldownSec = MFLUX_DEFAULT_COOLDOWN_SEC,
}) {
  const args = [
    scriptPath,
    '--config', configPath,
    '--output-dir', runDir,
    '--total-steps', String(totalSteps),
  ];
  if (segmentSteps > 0) {
    args.push('--segment-steps', String(segmentSteps), '--cooldown-sec', String(Math.max(0, cooldownSec)));
  }
  if (resumeCheckpoint) args.push('--resume-checkpoint', resumeCheckpoint);
  return args;
}

/** Argv for the vendored torch FLUX.2 trainer. */
export function buildFlux2TrainArgs({
  scriptPath,
  trainRepo,
  manifestPath,
  runDir,
  triggerWord,
  params = {},
  samplePrompt = null,
  resumeFrom = null,
}) {
  if (!trainRepo || !/^black-forest-labs\//.test(trainRepo)) {
    // Belt-and-suspenders: training against a quantized repo silently
    // produces garbage gradients — refuse anything but the bf16 bases.
    throw new ServerError(`FLUX.2 training requires a bf16 base repo (got: ${trainRepo})`, {
      status: 400, code: 'TRAINING_UNSUPPORTED_MODEL',
    });
  }
  const p = mergedParams(params);
  const args = [
    scriptPath,
    '--model-repo', trainRepo,
    '--manifest', manifestPath,
    '--output-dir', runDir,
    '--trigger-word', triggerWord,
    '--steps', String(p.steps),
    '--rank', String(p.rank),
    '--lr', String(p.learningRate),
    '--resolution', String(p.resolution),
    '--checkpoint-every', String(p.checkpointEvery),
    '--sample-every', String(p.sampleEvery),
    '--sample-prompt', samplePrompt || `${triggerWord} portrait, neutral background`,
    '--seed', String(Number.isInteger(p.seed) ? p.seed : 42),
    '--device', 'auto',
  ];
  if (resumeFrom) args.push('--resume-from', resumeFrom);
  return args;
}
