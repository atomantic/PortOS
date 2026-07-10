import { describe, it, expect } from 'vitest';
import {
  MUSCRIPTOR_MODELS,
  DEFAULT_MUSCRIPTOR_MODEL,
  resolveMuscriptorModel,
  buildMuscriptorArgs,
  cancelMidiTranscription,
} from './audioMidiTranscription.js';

describe('resolveMuscriptorModel', () => {
  it('accepts every known model size', () => {
    for (const m of MUSCRIPTOR_MODELS) expect(resolveMuscriptorModel(m)).toBe(m);
  });

  it('clamps unknown/absent values to the default', () => {
    expect(resolveMuscriptorModel('xl')).toBe(DEFAULT_MUSCRIPTOR_MODEL);
    expect(resolveMuscriptorModel(undefined)).toBe(DEFAULT_MUSCRIPTOR_MODEL);
    expect(resolveMuscriptorModel(null)).toBe(DEFAULT_MUSCRIPTOR_MODEL);
  });
});

describe('buildMuscriptorArgs', () => {
  it('builds the sidecar argv with the resolved model', () => {
    const { bin, args } = buildMuscriptorArgs({
      pythonPath: '/venv/bin/python3',
      scriptPath: '/repo/scripts/transcribe_muscriptor.py',
      audioPath: '/data/uploads/song.wav',
      outputPath: '/tmp/out.mid',
      model: 'large',
    });
    expect(bin).toBe('/venv/bin/python3');
    expect(args).toEqual([
      '/repo/scripts/transcribe_muscriptor.py',
      '--audio', '/data/uploads/song.wav',
      '--output', '/tmp/out.mid',
      '--model', 'large',
    ]);
  });

  it('defaults the script path and clamps an unknown model', () => {
    const { args } = buildMuscriptorArgs({
      pythonPath: 'py', audioPath: 'a.wav', outputPath: 'o.mid', model: 'bogus',
    });
    expect(args[0]).toMatch(/transcribe_muscriptor\.py$/);
    expect(args[args.indexOf('--model') + 1]).toBe(DEFAULT_MUSCRIPTOR_MODEL);
  });
});

describe('cancelMidiTranscription', () => {
  it('returns false for an unknown job', () => {
    expect(cancelMidiTranscription('nope')).toBe(false);
  });
});
