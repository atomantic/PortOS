import { describe, it, expect, vi } from 'vitest';
import { runSidecarProcess, parseSidecarResult } from './sidecarProcess.js';

// Drive the real runner with the current node binary as a stand-in sidecar —
// cross-platform (node is what's running the tests) and exercises the actual
// spawn/stream/close paths rather than a mocked child.
const node = process.execPath;
const run = (script, opts = {}) => runSidecarProcess({ bin: node, args: ['-e', script], ...opts });

describe('parseSidecarResult', () => {
  it('parses the last RESULT: line from sidecar stdout', () => {
    const stdout = [
      'some noise',
      'RESULT:{"output":"/tmp/stale.mid","bytes":1}',
      'RESULT:{"output":"/tmp/out.mid","model":"medium","bytes":2048}',
      '',
    ].join('\n');
    expect(parseSidecarResult(stdout)).toEqual({ output: '/tmp/out.mid', model: 'medium', bytes: 2048 });
  });

  it('returns null when no parseable RESULT line is present', () => {
    expect(parseSidecarResult('no result here')).toBeNull();
    expect(parseSidecarResult('RESULT:not-json')).toBeNull();
    expect(parseSidecarResult('')).toBeNull();
    expect(parseSidecarResult(undefined)).toBeNull();
  });
});

describe('runSidecarProcess', () => {
  it('resolves ok with stdout and fires onStage per STAGE: stderr line', async () => {
    const onStage = vi.fn();
    const result = await run(
      'process.stderr.write("STAGE:load-model:medium\\nSTAGE:done\\n"); process.stdout.write("RESULT:{\\"x\\":1}\\n");',
      { onStage },
    );
    expect(result.ok).toBe(true);
    expect(parseSidecarResult(result.stdout)).toEqual({ x: 1 });
    expect(onStage).toHaveBeenCalledWith('load-model', 'medium', 'load-model:medium');
    expect(onStage).toHaveBeenCalledWith('done', null, 'done');
  });

  it('reports a non-zero exit with the stderr tail as the reason', async () => {
    const result = await run('process.stderr.write("boom: model exploded\\n"); process.exit(3);');
    expect(result.ok).toBe(false);
    expect(result.canceled).toBeUndefined();
    expect(result.reason).toContain('boom: model exploded');
  });

  it('resolves canceled when the child is SIGTERMed and hands the live child to onProcess', async () => {
    let child = null;
    const seen = [];
    const promise = run('setInterval(() => {}, 1000);', {
      onProcess: (p) => { seen.push(p); if (p) child = p; },
    });
    await vi.waitFor(() => { if (!child) throw new Error('not spawned yet'); });
    child.kill('SIGTERM');
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.canceled).toBe(true);
    // onProcess got the live child, then null on exit.
    expect(seen[0]).not.toBeNull();
    expect(seen[seen.length - 1]).toBeNull();
  });

  it('resolves canceled without spawning when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run('process.stdout.write("should not run")', { signal: controller.signal });
    expect(result).toEqual({ ok: false, canceled: true, reason: 'cancelled (aborted before spawn)', stdout: '' });
  });

  it('resolves a spawn failure as a structured result instead of throwing', async () => {
    const result = await runSidecarProcess({ bin: '/nonexistent/python3', args: ['x.py'] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/spawn failed/);
  });
});
