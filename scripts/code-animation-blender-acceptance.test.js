/** CLI verdict regressions; these fixtures are never real-renderer evidence. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerError } from '../server/lib/errorHandler.js';
import { parseAcceptanceArgs, runAcceptance } from './code-animation-blender-acceptance.js';

const roots = [];
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function options(extra = []) {
  const root = await mkdtemp(join(tmpdir(), 'blender-acceptance-test-'));
  roots.push(root);
  return parseAcceptanceArgs(['--executable', process.execPath, '--out', join(root, 'run'), ...extra]);
}
const sample = hash => ({ samples: [{ t: 1, renderHash: hash }], artifacts: [], renderer: {} });
const renderFailure = message => new ServerError(message, { status: 422, code: 'CODE_ANIMATION_BLENDER_RENDER_FAILED' });

async function captureFailure(error, extra = []) {
  const config = await options(extra);
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const evidence = await runAcceptance(config, { render: async () => { throw error; } });
    const written = JSON.parse(await readFile(join(config.out, 'evidence.json'), 'utf8'));
    return { evidence, written, output: [...stdout.mock.calls, ...stderr.mock.calls].flat().join('\n') };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('standalone Blender acceptance verdicts', () => {
  it('refuses invalid formats/times and conflicting modes before creating output or starting a worker', () => {
    const args = ['--executable', '/example/Blender', '--out', '/example/out'];
    for (const extra of [['--seconds', 'NaN'], ['--times', ''], ['--times', '1,1.001'], ['--times', '10'],
      ['--size', '63x64'], ['--phase', 'unknown'], ['--cancel-after', '0'], ['--cancel-after', '1', '--repeat'],
      ['--engine', 'BLENDER_EEVEE_NEXT'], ['--backend', 'METAL'], ['--engine', 'BLENDER_EEVEE_NEXT', '--backend', 'CPU']]) {
      expect(() => parseAcceptanceArgs([...args, ...extra])).toThrow();
    }
    expect(parseAcceptanceArgs(args).mode).toBe('contained');
    expect(parseAcceptanceArgs([...args, '--engine', 'BLENDER_EEVEE_NEXT', '--backend', 'METAL']).backend).toBe('METAL');
  });
  it('writes a failed verdict for unequal repeated frames and refuses stale output reuse', async () => {
    const config = await options(['--repeat', '--times', '1']);
    const render = vi.fn().mockResolvedValueOnce(sample('first')).mockResolvedValueOnce(sample('different'));
    const evidence = await runAcceptance(config, { render });
    expect(evidence).toMatchObject({ accepted: false, repeat: { allIdentical: false } });
    expect(JSON.parse(await readFile(join(config.out, 'evidence.json'), 'utf8')).accepted).toBe(false);
    await expect(runAcceptance(config, { render })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(render).toHaveBeenCalledTimes(2);
  });
  it('does not mistake an unrelated error after abort for proved cancellation/process cleanup', async () => {
    const config = await options(['--cancel-after', '0.001']);
    // The 1ms timer can fire before render is invoked, so honor an already-aborted signal too.
    const render = ({ signal }) => new Promise((_, reject) => {
      const fail = () => reject(new Error('unrelated failure'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
    expect(await runAcceptance(config, { render })).toMatchObject({ accepted: false,
      cancel: { aborted: true, rejected: true, abortError: false } });
  });
  it('preserves bounded failure evidence when the executable is missing without claiming renderer acceptance', async () => {
    const config = await options();
    config.executable = join(config.out, 'missing-Blender');
    const render = vi.fn();
    expect(await runAcceptance(config, { render })).toMatchObject({ accepted: false, error: { code: 'ENOENT' }, workerRuns: [] });
    expect(render).not.toHaveBeenCalled();
  });
  it.each([
    'Baked scene artifact is invalid',
    'Blender was stopped by the memory limit. No render accepted.',
    'Blender crashed with SIGTERM. No render accepted.',
    'Blender exited with code 1. No render accepted.',
  ])('reports the safe renderer validation reason: %s', async message => {
    const { evidence, written, output } = await captureFailure(renderFailure(message));
    expect(evidence).toMatchObject({ accepted: false, error: { name: 'ServerError', code: 'CODE_ANIMATION_BLENDER_RENDER_FAILED', message } });
    expect(written.error).toEqual(evidence.error);
    expect(output).toContain(message);
  });
  it.each([
    ['CODE_ANIMATION_STAGE_PATH', 'Staged worker paths collide'],
    ['CODE_ANIMATION_WORKER_UNSUPPORTED', 'Trusted-local worker process supervision requires macOS or Linux'],
    ['CODE_ANIMATION_CONTAINMENT_UNAVAILABLE', 'Contained execution refused: Linux containment unavailable: install bubblewrap (/usr/bin/bwrap).'],
    ['CODE_ANIMATION_CONTAINMENT_UNAVAILABLE', 'Contained execution refused: No enforced worker containment is implemented for win32. Production code execution is refused; package import/export and the browser preview sandbox remain available.'],
  ])('reports a safe worker validation reason for %s', async (code, message) => {
    const { evidence, written, output } = await captureFailure(new ServerError(message, { code }));
    expect(evidence.error).toMatchObject({ code, message });
    expect(written.error).toEqual(evidence.error);
    expect(output).toContain(message);
  });
  it('reports a validation failure in cancellation mode without claiming cancellation succeeded', async () => {
    const message = 'Baked scene artifact is invalid';
    const { evidence, written, output } = await captureFailure(renderFailure(message), ['--cancel-after', '1']);
    expect(evidence).toMatchObject({ accepted: false, cancel: { aborted: false, abortError: false }, error: { message } });
    expect(written.error).toEqual(evidence.error);
    expect(output).toContain(message);
  });
  it('does not serialize a changing message getter after validating its value', async () => {
    const message = 'Blender exited with code 1. No render accepted.';
    const error = renderFailure('placeholder');
    let reads = 0;
    Object.defineProperty(error, 'message', { get: () => (++reads === 1 ? message : {
      toString: () => message, path: '/home/example/private/scene.blend',
    }) });
    const { written, output } = await captureFailure(error);
    expect(reads).toBe(1);
    expect(written.error.message).toBe(message);
    expect(JSON.stringify(written)).not.toContain('/home/example/private');
    expect(output).toContain(message);
    expect(output).not.toContain('/home/example/private');
  });
  const coerced = renderFailure('placeholder');
  coerced.message = { toString: () => 'Blender exited with code 1. No render accepted.', path: '/home/example/private/scene.blend' };
  it.each([
    Object.assign(new Error('Failed at /home/example/private/scene.blend'), { code: 'CODE_ANIMATION_BLENDER_RENDER_FAILED' }),
    renderFailure('Sequence encoding failed: spawn failed at /home/example/private/ffmpeg and C:\\Users\\example\\private\\ffmpeg.exe'),
    new ServerError('Baked scene artifact is invalid', { code: 'OTHER_ERROR' }),
    new ServerError('Contained execution refused: /home/example/private/tool', { code: 'CODE_ANIMATION_CONTAINMENT_UNAVAILABLE' }),
    coerced,
  ])('does not disclose messages from unrelated or unsafe errors', async error => {
    const { evidence, written, output } = await captureFailure(error);
    expect(evidence.error).not.toHaveProperty('message');
    expect(written.error).toEqual(evidence.error);
    expect(output).not.toContain(String(error.message));
    expect(JSON.stringify(written)).not.toContain('/home/example/private');
    expect(output).not.toContain('/home/example/private');
    expect(JSON.stringify(written)).not.toContain('Users');
    expect(output).not.toContain('Users');
  });
});
