import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./childProcess.js', async importOriginal => ({ ...await importOriginal(), spawn: vi.fn() }));
vi.mock('./bufferedSpawn.js', async importOriginal => ({
  ...await importOriginal(), killProcessTree: vi.fn(),
}));
const { spawn } = await import('./childProcess.js');
const { killProcessTree } = await import('./bufferedSpawn.js');
const { runCliProviderPrompt } = await import('./cliProviderRun.js');

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

// Regression: elapsed time alone cannot distinguish a silent process, an
// unfinished response, and a dead process whose descendant holds its pipes.
describe('review process progress at the CLI boundary', () => {
  it.each(['no-output', 'output-open', 'exit-drain'])('reports %s at the deadline without accepting partial output', async phase => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    });
    spawn.mockReturnValue(child);
    const pending = runCliProviderPrompt({ provider: { id: 'grok-cli', type: 'cli', command: 'grok' }, model: 'grok-4.7',
      prompt: 'synthetic untrusted diff', safetyProfile: 'public-review-gate', codeReview: true, timeoutMs: 600000 });
    child.emit('spawn');
    await vi.advanceTimersByTimeAsync(100);
    const event = JSON.stringify({ type: 'thought', data: 'private transcript' }) + '\n';
    if (phase !== 'no-output') child.stdout.emit('data', Buffer.from(event));
    if (phase === 'exit-drain') child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(599900);
    const result = await pending;
    expect(result).toMatchObject({ code: 'REVIEWER_PROCESS_TIMEOUT', diagnostics: { cli: {
      phase, spawnMs: 0, elapsedMs: 600000, closeMs: null,
      firstOutputMs: phase === 'no-output' ? null : 100,
      lastOutputMs: phase === 'no-output' ? null : 100,
      exitMs: phase === 'exit-drain' ? 100 : null,
      stdoutBytes: phase === 'no-output' ? 0 : Buffer.byteLength(event), stderrBytes: 0,
      thoughtEvents: phase === 'no-output' ? 0 : 1, textEvents: 0, endEvents: 0,
    } } });
    expect(result.error).toContain('timed out');
    expect(result.exitCode).toBeUndefined();
    expect(JSON.stringify(result.diagnostics)).not.toContain('private transcript');
    expect(killProcessTree).toHaveBeenCalledOnce();
    child.emit('close', 0); // a late close must not turn failure into a verdict
  });
  it('lets active reasoning exceed the wall clock and stops only after a full silence window', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    });
    spawn.mockReturnValue(child);
    const onActivity = vi.fn();
    const pending = runCliProviderPrompt({ provider: { id: 'grok-cli', type: 'cli', command: 'grok' },
      model: 'grok-4.7', prompt: 'synthetic untrusted diff', safetyProfile: 'public-review-gate',
      codeReview: true, timeoutMs: 600000, inactivityTimeoutMs: 1800000, onActivity });
    child.emit('spawn');
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1799999);
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thought', data: 'private reasoning' }) + '\n'));
    }
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1800000);
    const result = await pending;
    expect(result).toMatchObject({ code: 'REVIEWER_PROCESS_TIMEOUT', error: 'Provider call inactive for 1800000ms',
      diagnostics: { cli: { phase: 'output-open', idleMs: 1800000, inactivityTimeoutMs: 1800000, thoughtEvents: 3 } } });
    expect(result.diagnostics.cli.elapsedMs).toBeGreaterThan(600000);
    expect(killProcessTree).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.diagnostics)).not.toContain('private reasoning');
  });

});
