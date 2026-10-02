/** CLI verdict regressions; these fixtures are never real-renderer evidence. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAcceptanceArgs, runAcceptance } from './code-animation-blender-acceptance.js';

const roots = [];
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function options(extra = []) {
  const root = await mkdtemp(join(tmpdir(), 'blender-acceptance-test-'));
  roots.push(root);
  return parseAcceptanceArgs(['--executable', process.execPath, '--out', join(root, 'run'), ...extra]);
}
const sample = hash => ({ samples: [{ t: 1, renderHash: hash }], artifacts: [], renderer: {} });

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
    const render = ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('unrelated failure')), { once: true });
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
});
