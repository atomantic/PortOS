import { describe, it, expect } from 'vitest';
import {
  TRAINING_DEFAULTS,
  buildFlux2TrainArgs,
  buildMfluxLoraTargets,
  buildMfluxTrainArgs,
  buildMfluxTrainConfig,
  deriveMfluxMemoryConfig,
  resolveTrainingRuntime,
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

  it('derives quantize/low_ram from total RAM (unknown → most conservative)', () => {
    expect(deriveMfluxMemoryConfig(128)).toEqual({ quantize: null, low_ram: false });
    expect(deriveMfluxMemoryConfig(64)).toEqual({ quantize: 8, low_ram: false });
    expect(deriveMfluxMemoryConfig(48)).toEqual({ quantize: 4, low_ram: true });
    expect(deriveMfluxMemoryConfig(null)).toEqual({ quantize: 4, low_ram: true });
    const config = buildMfluxTrainConfig({ ...base, totalMemGb: 48 });
    expect(config.quantize).toBe(4);
    expect(config.low_ram).toBe(true);
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

  it('refuses non-bf16 train repos', () => {
    expect(() => buildFlux2TrainArgs({
      scriptPath: '/x.py', trainRepo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic',
      manifestPath: '/m.json', runDir: '/r', triggerWord: 'kessa',
    })).toThrow(/bf16/);
  });
});
