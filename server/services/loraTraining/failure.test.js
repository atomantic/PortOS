import { describe, it, expect } from 'vitest';
import { classifyTrainingFailure } from './failure.js';

describe('classifyTrainingFailure', () => {
  it('prefers the trainer-reported USER_ERROR', () => {
    const out = classifyTrainingFailure({
      userError: { kind: 'DATASET_ERROR', message: 'manifest contains no images' },
      stderrTail: ['CUDA out of memory'], // would otherwise classify as OOM
    });
    expect(out).toEqual({ code: 'DATASET_ERROR', message: 'manifest contains no images' });
  });

  it('classifies OOM variants', () => {
    for (const line of ['MPS backend out of memory', 'CUDA out of memory. Tried to allocate']) {
      expect(classifyTrainingFailure({ stderrTail: [line] }).code).toBe('OOM');
    }
  });

  it('classifies missing modules and HF auth', () => {
    expect(classifyTrainingFailure({ stderrTail: ["ModuleNotFoundError: No module named 'peft'"] }).code)
      .toBe('MODULE_NOT_FOUND');
    expect(classifyTrainingFailure({ stderrTail: ['GatedRepoError: 403'] }).code).toBe('HF_AUTH');
  });

  it('extracts the gated repo for the UI deep-link (USER_ERROR path)', () => {
    // The real production path: the trainer re-emits the raw gated stderr line
    // as USER_ERROR:HF_AUTH:<line>, so the repo rides in userError.message.
    const out = classifyTrainingFailure({
      userError: {
        kind: 'HF_AUTH',
        message: 'Access to model black-forest-labs/FLUX.2-klein-base-9B is restricted and you are not in the authorized list. Visit https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9B to ask for access.',
      },
    });
    expect(out.code).toBe('HF_AUTH');
    expect(out.repo).toBe('black-forest-labs/FLUX.2-klein-base-9B');
  });

  it('normalizes the torch runner gated_repo USER_ERROR kind to HF_AUTH with a repo', () => {
    // _runner_common (torch FLUX.2) emits USER_ERROR:gated_repo:… instead of
    // HF_AUTH — both must classify as HF_AUTH so the UI banner fires.
    const out = classifyTrainingFailure({
      userError: {
        kind: 'gated_repo',
        message: 'Access to black-forest-labs/FLUX.2-klein-base-9B is restricted. Visit https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9B to request access, then make sure your HF token is set in PortOS.',
      },
    });
    expect(out.code).toBe('HF_AUTH');
    expect(out.repo).toBe('black-forest-labs/FLUX.2-klein-base-9B');
  });

  it('extracts the gated repo from a raw stderr tail and rewrites the message', () => {
    const out = classifyTrainingFailure({
      stderrTail: ['Cannot access gated repo for url https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9B/resolve/main/config.json.'],
    });
    expect(out.code).toBe('HF_AUTH');
    expect(out.repo).toBe('black-forest-labs/FLUX.2-klein-base-9B');
    expect(out.message).toContain('black-forest-labs/FLUX.2-klein-base-9B');
  });

  it('falls back to a null repo when no repo is parseable from an HF auth failure', () => {
    const out = classifyTrainingFailure({ stderrTail: ['GatedRepoError: 403'] });
    expect(out.code).toBe('HF_AUTH');
    expect(out.repo).toBeNull();
  });

  it('classifies argparse CLI mismatch as a stale-mflux upgrade hint', () => {
    // The exact tail the wrapper replays when mflux 0.12.x rejects --config.
    // This is the REAL production path: the wrapper intentionally does NOT emit
    // a USER_ERROR for argparse rejections (that would short-circuit on the raw
    // line), so CLI_MISMATCH must be reachable from stderrTail alone — with no
    // userError set — for the actionable upgrade message to actually surface.
    const tail = [
      'mflux: usage: mflux-train [-h] ...',
      'mflux: mflux-train: error: unrecognized arguments: --config /run/mflux-train.json',
    ];
    const out = classifyTrainingFailure({ exitCode: 2, stderrTail: tail });
    expect(out.code).toBe('CLI_MISMATCH');
    expect(out.message).toMatch(/mflux>=0\.17/);
  });

  it('flags SIGKILL as memory reclaim', () => {
    expect(classifyTrainingFailure({ signal: 'SIGKILL' }).code).toBe('KILLED');
  });

  it('falls back to a generic message with the stderr tail', () => {
    const out = classifyTrainingFailure({ exitCode: 1, stderrTail: ['Traceback', 'ValueError: bad shape'] });
    expect(out.code).toBe('TRAINING_FAILED');
    expect(out.message).toContain('ValueError: bad shape');
    expect(out.message).toContain('code 1');
  });
});
