import { describe, it, expect } from 'vitest';
import {
  buildMusicGenArgs,
  clampDuration,
  getMusicgenModel,
  MUSICGEN_MODELS,
  DEFAULT_MUSICGEN_MODEL_ID,
  MIN_DURATION_SEC,
  MAX_DURATION_SEC,
  DEFAULT_DURATION_SEC,
} from './musicGen.js';

describe('MUSICGEN_MODELS registry', () => {
  it('has a stable, unique id + repo for each model', () => {
    const ids = MUSICGEN_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MUSICGEN_MODELS) {
      expect(typeof m.id).toBe('string');
      expect(m.repo).toMatch(/^facebook\/musicgen-/);
      expect(typeof m.name).toBe('string');
    }
  });

  it('default model id resolves to a real entry', () => {
    expect(getMusicgenModel(DEFAULT_MUSICGEN_MODEL_ID)).toBeTruthy();
  });

  it('getMusicgenModel returns null for unknown ids', () => {
    expect(getMusicgenModel('nope')).toBeNull();
    expect(getMusicgenModel(undefined)).toBeNull();
  });
});

describe('clampDuration', () => {
  it('passes through an in-range value', () => {
    expect(clampDuration(12)).toBe(12);
  });
  it('floors at MIN and caps at MAX', () => {
    expect(clampDuration(0)).toBe(MIN_DURATION_SEC);
    expect(clampDuration(-5)).toBe(MIN_DURATION_SEC);
    expect(clampDuration(9999)).toBe(MAX_DURATION_SEC);
  });
  it('falls back to the default on non-finite input', () => {
    expect(clampDuration(NaN)).toBe(DEFAULT_DURATION_SEC);
    expect(clampDuration('abc')).toBe(DEFAULT_DURATION_SEC);
    expect(clampDuration(undefined)).toBe(DEFAULT_DURATION_SEC);
  });
});

describe('buildMusicGenArgs', () => {
  const base = {
    pythonPath: '/venv/bin/python3',
    repo: 'facebook/musicgen-medium',
    prompt: 'tense cinematic synth',
    durationSec: 10,
    outputPath: '/data/music/music-gen-abc.wav',
    runtimeDir: '/home/u/.portos/mlx-examples/musicgen',
  };

  it('builds the sidecar argv with every flag the script expects', () => {
    const { bin, args } = buildMusicGenArgs(base);
    expect(bin).toBe('/venv/bin/python3');
    expect(args[0]).toMatch(/generate_musicgen\.py$/);
    const flag = (name) => args[args.indexOf(name) + 1];
    expect(flag('--model')).toBe('facebook/musicgen-medium');
    expect(flag('--text')).toBe('tense cinematic synth');
    expect(flag('--output')).toBe('/data/music/music-gen-abc.wav');
    expect(flag('--runtime-dir')).toBe('/home/u/.portos/mlx-examples/musicgen');
  });

  it('passes the clamped duration as a string', () => {
    const { args } = buildMusicGenArgs({ ...base, durationSec: 9999 });
    const dur = args[args.indexOf('--duration') + 1];
    expect(dur).toBe(String(MAX_DURATION_SEC));
    expect(typeof dur).toBe('string');
  });

  it('clamps a sub-minimum duration', () => {
    const { args } = buildMusicGenArgs({ ...base, durationSec: 0 });
    expect(args[args.indexOf('--duration') + 1]).toBe(String(MIN_DURATION_SEC));
  });
});
