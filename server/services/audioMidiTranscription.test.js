import { describe, it, expect } from 'vitest';
import {
  MUSCRIPTOR_MODELS,
  DEFAULT_MUSCRIPTOR_MODEL,
  resolveMuscriptorModel,
  buildMuscriptorArgs,
  cancelMidiTranscription,
  classifyMidiFailure,
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

describe('classifyMidiFailure', () => {
  it('reads the sidecar structured USER_ERROR:gated_repo marker for the repo', () => {
    const reason = 'STAGE:load-model:medium | USER_ERROR:gated_repo:MuScriptor/muscriptor-medium | '
      + '❌ Access to MuScriptor/muscriptor-medium is restricted. Visit https://huggingface.co/... to request access';
    const result = classifyMidiFailure(reason, 'medium');
    expect(result.code).toBe('gated_repo');
    expect(result.repo).toBe('MuScriptor/muscriptor-medium');
    expect(result.error).toContain('https://huggingface.co/MuScriptor/muscriptor-medium');
  });

  it('flags a gated-repo 403 from raw prose (marker-less sidecar) with the repo pulled from the error', () => {
    const reason = 'huggingface_hub.errors.GatedRepoError: 403 Client Error. '
      + 'Cannot access gated repo for url https://huggingface.co/MuScriptor/muscriptor-medium/resolve/main/model.safetensors. '
      + 'Access to model MuScriptor/muscriptor-medium is restricted and you are not in the authorized list.';
    const result = classifyMidiFailure(reason, 'medium');
    expect(result.code).toBe('gated_repo');
    expect(result.repo).toBe('MuScriptor/muscriptor-medium');
    expect(result.error).toContain('https://huggingface.co/MuScriptor/muscriptor-medium');
    expect(result.error).toContain('HuggingFace token');
  });

  it('falls back to the model-derived repo when the error omits it', () => {
    const result = classifyMidiFailure('Cannot access gated repo', 'large');
    expect(result.code).toBe('gated_repo');
    expect(result.repo).toBe('MuScriptor/muscriptor-large');
  });

  it('passes non-gated failures through as a plain error with no code', () => {
    const result = classifyMidiFailure('sidecar wrote no MIDI', 'medium');
    expect(result.code).toBeUndefined();
    expect(result.repo).toBeUndefined();
    expect(result.error).toBe('sidecar wrote no MIDI');
  });

  it('supplies a default message for an empty reason', () => {
    expect(classifyMidiFailure('', 'medium').error).toBe('MIDI transcription failed');
  });
});
