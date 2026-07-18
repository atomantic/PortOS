import { describe, it, expect } from 'vitest';
import {
  TRAINING_DEFAULTS,
  buildFlux2TrainArgs,
  buildMfluxLoraTargets,
  buildMfluxTrainArgs,
  buildMfluxTrainConfig,
  deriveMfluxMemoryConfig,
  resolveTrainingRuntime,
  MFLUX_DEFAULT_COOLDOWN_SEC,
} from './runtimes.js';

const MODELS = [
  { id: 'dev', name: 'Flux 1 Dev' },
  { id: 'schnell', name: 'Flux 1 Schnell' },
  { id: 'flux2-klein-4b', runner: 'flux2', repo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic' },
  { id: 'flux2-klein-9b-bf16', runner: 'flux2', repo: 'black-forest-labs/FLUX.2-klein-9B' },
  { id: 'z-image-turbo', runner: 'z-image', repo: 'Tongyi/Z-Image-Turbo' },
];

describe('resolveTrainingRuntime', () => {
  it('routes flux2 models to mflux when its trainer is available', () => {
    const out = resolveTrainingRuntime('flux2-klein-4b', MODELS, { mlxAvailable: true });
    expect(out.runtime).toBe('mflux');
    expect(out.mfluxModel).toBe('flux2-klein-base-4b');
    expect(out.trainRepo).toBe('black-forest-labs/FLUX.2-klein-4B');
    expect(out.variant).toBe('4b');
  });

  it('falls back to the torch runtime without mflux', () => {
    const out = resolveTrainingRuntime('flux2-klein-9b-bf16', MODELS, { mlxAvailable: false });
    expect(out.runtime).toBe('flux2');
    expect(out.mfluxModel).toBe('flux2-klein-base-9b');
    expect(out.trainRepo).toBe('black-forest-labs/FLUX.2-klein-9B');
  });

  it('rejects FLUX.1 (training removed upstream), diffusers families, and unknown ids', () => {
    expect(() => resolveTrainingRuntime('dev', MODELS)).toThrow(/FLUX\.2 Klein models only/);
    expect(() => resolveTrainingRuntime('schnell', MODELS)).toThrow(/FLUX\.2 Klein models only/);
    expect(() => resolveTrainingRuntime('z-image-turbo', MODELS)).toThrow(/FLUX\.2 Klein models only/);
    expect(() => resolveTrainingRuntime('ghost', MODELS)).toThrow(/Unknown image model/);
  });
});

describe('buildMfluxLoraTargets', () => {
  it('pins block ranges per size variant (4b: 5+20, 9b: 8+24)', () => {
    const t4 = buildMfluxLoraTargets('4b', 16);
    const double4 = t4.find((t) => t.module_path === 'transformer_blocks.{block}.attn.to_q');
    const single4 = t4.find((t) => t.module_path === 'single_transformer_blocks.{block}.attn.to_qkv_mlp_proj');
    expect(double4.blocks).toEqual({ start: 0, end: 5 });
    expect(single4.blocks).toEqual({ start: 0, end: 20 });
    const t9 = buildMfluxLoraTargets('9b', 8);
    expect(t9.find((t) => t.module_path.startsWith('transformer_blocks')).blocks.end).toBe(8);
    expect(t9.find((t) => t.module_path.startsWith('single_transformer_blocks')).blocks.end).toBe(24);
    expect(t9.every((t) => t.rank === 8)).toBe(true);
  });
});

describe('buildMfluxTrainConfig', () => {
  const base = {
    variant: '4b',
    mfluxModel: 'flux2-klein-base-4b',
    dataDir: '/data/training-runs/r1/data',
    imageCount: 2,
    outputDir: '/data/training-runs/r1/mflux',
  };

  it('matches the mflux ≥0.17 schema and translates steps → epochs', () => {
    const config = buildMfluxTrainConfig({ ...base, params: { steps: 100 } });
    expect(config.model).toBe('flux2-klein-base-4b');
    expect(config.data).toBe(base.dataDir);
    expect(config.training_loop).toEqual({
      num_epochs: 50, batch_size: 1, timestep_low: 25, timestep_high: 40,
    });
    expect(config.steps).toBe(40); // noise-schedule steps, not training duration
    expect(config.guidance).toBe(1.0);
    expect(config.checkpoint.output_path).toBe(base.outputDir);
    expect(config.lora_layers.targets.length).toBeGreaterThan(10);
    // mflux rejects unknown keys like the legacy `examples`/`save` shapes.
    expect(config.examples).toBeUndefined();
    expect(config.save).toBeUndefined();
  });

  it('applies params and disables monitoring when samples are off', () => {
    const config = buildMfluxTrainConfig({
      ...base,
      params: { steps: 200, rank: 8, learningRate: 0.0002, resolution: 768, checkpointEvery: 0, sampleEvery: 0 },
    });
    expect(config.optimizer.learning_rate).toBe(0.0002);
    expect(config.max_resolution).toBe(768);
    // checkpointEvery:0 would mean "only the final save", but the crash-
    // resilience floor caps the interval at totalSteps/MIN_CHECKPOINTS (200/4).
    expect(config.checkpoint.save_frequency).toBe(50);
    expect(config.monitoring).toBeUndefined();
    expect(config.lora_layers.targets[0].rank).toBe(8);
  });

  it('caps save_frequency at totalSteps/MIN_CHECKPOINTS for crash resilience', () => {
    // A huge checkpointEvery (or 0 → "only final save") must still checkpoint
    // periodically so a mid-run hard reboot (GPU watchdog panic) keeps progress.
    const onlyFinal = buildMfluxTrainConfig({ ...base, params: { steps: 600, checkpointEvery: 0 } });
    expect(onlyFinal.checkpoint.save_frequency).toBe(150); // ceil(600/4)
    const tooLarge = buildMfluxTrainConfig({ ...base, params: { steps: 600, checkpointEvery: 9999 } });
    expect(tooLarge.checkpoint.save_frequency).toBe(150);
    // A reasonable user interval below the cap is left untouched.
    const reasonable = buildMfluxTrainConfig({ ...base, params: { steps: 600, checkpointEvery: 100 } });
    expect(reasonable.checkpoint.save_frequency).toBe(100);
  });

  it('enables monitoring with sample dimensions when sampleEvery > 0', () => {
    const config = buildMfluxTrainConfig({ ...base, params: { sampleEvery: 50, resolution: 512 } });
    expect(config.monitoring).toEqual({
      preview_width: 512, preview_height: 512, plot_frequency: 50, generate_image_frequency: 50,
    });
  });

  it('throws on an empty example set', () => {
    expect(() => buildMfluxTrainConfig({ ...base, imageCount: 0 })).toThrow(/at least one/);
  });

  it('derives quantize from the memory budget; latent cache always spills to disk', () => {
    // low_ram is true at every tier — an in-RAM latent cache bought nothing
    // but risked swap-thrash (the 128 GB / 21 GB-swap incident). bf16 is never
    // the auto default (issue #1321): even a 128 GB box gets 8-bit QLoRA, not
    // unquantized bf16. quantize still steps down to 4-bit on tighter budgets.
    expect(deriveMfluxMemoryConfig(128)).toEqual({ quantize: 8, low_ram: true });
    expect(deriveMfluxMemoryConfig(64)).toEqual({ quantize: 8, low_ram: true });
    expect(deriveMfluxMemoryConfig(48)).toEqual({ quantize: 4, low_ram: true });
    expect(deriveMfluxMemoryConfig(null)).toEqual({ quantize: 4, low_ram: true });
    const config = buildMfluxTrainConfig({ ...base, totalMemGb: 48 });
    expect(config.quantize).toBe(4);
    expect(config.low_ram).toBe(true);
  });

  it('LORA_TRAIN_MAX_QUANT_BITS caps the top tier (M5 bf16-panic mitigation)', () => {
    const prev = process.env.LORA_TRAIN_MAX_QUANT_BITS;
    try {
      // cap=8: already at the 8-bit default (no-op); smaller (4) is kept.
      process.env.LORA_TRAIN_MAX_QUANT_BITS = '8';
      expect(deriveMfluxMemoryConfig(128)).toEqual({ quantize: 8, low_ram: true });
      expect(deriveMfluxMemoryConfig(64)).toEqual({ quantize: 8, low_ram: true });
      expect(deriveMfluxMemoryConfig(48)).toEqual({ quantize: 4, low_ram: true });
      // cap=4: everything (default 8-bit and the 4-bit tier) forced to 4-bit.
      process.env.LORA_TRAIN_MAX_QUANT_BITS = '4';
      expect(deriveMfluxMemoryConfig(128)).toEqual({ quantize: 4, low_ram: true });
      expect(deriveMfluxMemoryConfig(64)).toEqual({ quantize: 4, low_ram: true });
      // garbage / unsupported values are ignored → memory-derived default (8-bit).
      process.env.LORA_TRAIN_MAX_QUANT_BITS = '16';
      expect(deriveMfluxMemoryConfig(128)).toEqual({ quantize: 8, low_ram: true });
      process.env.LORA_TRAIN_MAX_QUANT_BITS = 'banana';
      expect(deriveMfluxMemoryConfig(128)).toEqual({ quantize: 8, low_ram: true });
    } finally {
      if (prev === undefined) delete process.env.LORA_TRAIN_MAX_QUANT_BITS;
      else process.env.LORA_TRAIN_MAX_QUANT_BITS = prev;
    }
  });

  it('per-run overrides replace the memory-derived tier (issue #1321)', () => {
    // quantize override wins over the budget tier — heavier (bf16) on a 48 GB
    // box, or lighter than the box would otherwise pick.
    expect(deriveMfluxMemoryConfig(48, { quantize: null })).toEqual({ quantize: null, low_ram: true });
    expect(deriveMfluxMemoryConfig(128, { quantize: 4 })).toEqual({ quantize: 4, low_ram: true });
    // low_ram override flips the spill independently of quantize (128 GB → 8-bit default).
    expect(deriveMfluxMemoryConfig(128, { low_ram: false })).toEqual({ quantize: 8, low_ram: false });
    // Absent keys keep the memory-derived value; an empty override is a no-op.
    expect(deriveMfluxMemoryConfig(64, {})).toEqual({ quantize: 8, low_ram: true });
    // An explicit quantize: null (bf16) is honored as a deliberate clear, not
    // mistaken for "absent" — distinguishes intentional-empty from absent.
    expect(deriveMfluxMemoryConfig(48, { quantize: null }).quantize).toBeNull();
  });

  it('LORA_TRAIN_MAX_QUANT_BITS clamps a per-run override (cap is the ceiling)', () => {
    const prev = process.env.LORA_TRAIN_MAX_QUANT_BITS;
    try {
      // A run asks for bf16 (heaviest) but the install caps at 8-bit — the cap
      // wins, so a per-run opt-in can never breach the box's panic guard.
      process.env.LORA_TRAIN_MAX_QUANT_BITS = '8';
      expect(deriveMfluxMemoryConfig(48, { quantize: null })).toEqual({ quantize: 8, low_ram: true });
      // A run can still go LIGHTER than the cap.
      expect(deriveMfluxMemoryConfig(128, { quantize: 4 })).toEqual({ quantize: 4, low_ram: true });
    } finally {
      if (prev === undefined) delete process.env.LORA_TRAIN_MAX_QUANT_BITS;
      else process.env.LORA_TRAIN_MAX_QUANT_BITS = prev;
    }
  });

  it('maps baseQuant/lowRam request params into the mflux config (issue #1321)', () => {
    // baseQuant 16 → unquantized bf16 (mflux quantize: null), overriding the
    // null-budget tier (which would otherwise be 4-bit).
    const bf16 = buildMfluxTrainConfig({ ...base, params: { baseQuant: 16, lowRam: false } });
    expect(bf16.quantize).toBeNull();
    expect(bf16.low_ram).toBe(false);
    // baseQuant 8/4 map straight through as the QLoRA bit-width.
    expect(buildMfluxTrainConfig({ ...base, params: { baseQuant: 8 } }).quantize).toBe(8);
    expect(buildMfluxTrainConfig({ ...base, totalMemGb: 128, params: { baseQuant: 4 } }).quantize).toBe(4);
    // lowRam alone flips the spill at the config-builder level, leaving the
    // memory-derived quant (128 GB → 8-bit default) untouched.
    expect(buildMfluxTrainConfig({ ...base, totalMemGb: 128, params: { lowRam: false } }).low_ram).toBe(false);
    // No override → memory-derived tier is untouched (128 GB → 8-bit, never bf16; issue #1321).
    expect(buildMfluxTrainConfig({ ...base, totalMemGb: 128 }).quantize).toBe(8);
  });

  it('treats null baseQuant/lowRam ("Auto") as no override (issue #1407)', () => {
    // The form sends an explicit `null` for "Auto" (a deliberate clear that
    // beats a saved default), which must behave identically to absent: the
    // memory-derived tier wins. A null baseQuant must NOT be coerced to 0.
    const cfg = buildMfluxTrainConfig({ ...base, totalMemGb: 48, params: { baseQuant: null, lowRam: null } });
    expect(cfg.quantize).toBe(4); // 48 GB tier, not touched by the null clear
    expect(cfg.low_ram).toBe(true);
  });
});

describe('buildMfluxTrainArgs / buildFlux2TrainArgs', () => {
  it('builds the wrapper argv', () => {
    const args = buildMfluxTrainArgs({
      scriptPath: '/x/train_mflux_lora.py', configPath: '/r/cfg.json', runDir: '/r', totalSteps: 500,
    });
    expect(args).toEqual([
      '/x/train_mflux_lora.py', '--config', '/r/cfg.json',
      '--output-dir', '/r', '--total-steps', '500',
    ]);
  });

  it('builds the flux2 argv with merged params', () => {
    const args = buildFlux2TrainArgs({
      scriptPath: '/x/train_flux2_lora.py',
      trainRepo: 'black-forest-labs/FLUX.2-klein-4B',
      manifestPath: '/r/manifest.json',
      runDir: '/r',
      triggerWord: 'kessa',
      params: { steps: 20, rank: 4 },
    });
    expect(args).toContain('--model-repo');
    expect(args[args.indexOf('--steps') + 1]).toBe('20');
    expect(args[args.indexOf('--rank') + 1]).toBe('4');
    expect(args[args.indexOf('--lr') + 1]).toBe(String(TRAINING_DEFAULTS.learningRate));
    expect(args[args.indexOf('--sample-prompt') + 1]).toContain('kessa');
  });

  it('appends the resume flag for each runtime when a checkpoint is given', () => {
    const mflux = buildMfluxTrainArgs({
      scriptPath: '/x/train_mflux_lora.py', configPath: '/r/cfg.json', runDir: '/r', totalSteps: 500,
      resumeCheckpoint: '/r/mflux/checkpoints/0000150_checkpoint.zip',
    });
    expect(mflux[mflux.indexOf('--resume-checkpoint') + 1]).toBe('/r/mflux/checkpoints/0000150_checkpoint.zip');

    const flux2 = buildFlux2TrainArgs({
      scriptPath: '/x/train_flux2_lora.py',
      trainRepo: 'black-forest-labs/FLUX.2-klein-4B',
      manifestPath: '/r/manifest.json', runDir: '/r', triggerWord: 'kessa',
      resumeFrom: '/r/checkpoints/step-000150',
    });
    expect(flux2[flux2.indexOf('--resume-from') + 1]).toBe('/r/checkpoints/step-000150');
  });

  it('omits the resume flag on a fresh run', () => {
    const args = buildMfluxTrainArgs({
      scriptPath: '/x.py', configPath: '/r/cfg.json', runDir: '/r', totalSteps: 500,
    });
    expect(args).not.toContain('--resume-checkpoint');
  });

  it('omits segment flags when segmentSteps is 0 (single-process run)', () => {
    const args = buildMfluxTrainArgs({
      scriptPath: '/x.py', configPath: '/r/cfg.json', runDir: '/r', totalSteps: 500, segmentSteps: 0,
    });
    expect(args).not.toContain('--segment-steps');
    expect(args).not.toContain('--cooldown-sec');
  });

  it('emits segment + cooldown flags when segmentation is enabled', () => {
    const args = buildMfluxTrainArgs({
      scriptPath: '/x.py', configPath: '/r/cfg.json', runDir: '/r', totalSteps: 600,
      segmentSteps: 150, cooldownSec: 120,
    });
    expect(args[args.indexOf('--segment-steps') + 1]).toBe('150');
    expect(args[args.indexOf('--cooldown-sec') + 1]).toBe('120');
  });

  it('defaults the cooldown when only segmentSteps is given', () => {
    const args = buildMfluxTrainArgs({
      scriptPath: '/x.py', configPath: '/r/cfg.json', runDir: '/r', totalSteps: 600, segmentSteps: 150,
    });
    expect(args[args.indexOf('--cooldown-sec') + 1]).toBe(String(MFLUX_DEFAULT_COOLDOWN_SEC));
  });

  it('clamps a negative cooldown to 0', () => {
    const args = buildMfluxTrainArgs({
      scriptPath: '/x.py', configPath: '/r/cfg.json', runDir: '/r', totalSteps: 600,
      segmentSteps: 150, cooldownSec: -5,
    });
    expect(args[args.indexOf('--cooldown-sec') + 1]).toBe('0');
  });

  it('refuses non-bf16 train repos', () => {
    expect(() => buildFlux2TrainArgs({
      scriptPath: '/x.py', trainRepo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic',
      manifestPath: '/m.json', runDir: '/r', triggerWord: 'kessa',
    })).toThrow(/bf16/);
  });
});
