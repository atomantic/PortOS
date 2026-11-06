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
    const pending = runCliProviderPrompt({ provider: { id: 'grok-cli', command: 'grok' }, model: 'grok-4.7',
      prompt: 'synthetic untrusted diff', safetyProfile: 'public-review-gate', codeReview: true, timeoutMs: 600000 });
    child.emit('spawn');
    await vi.advanceTimersByTimeAsync(100);
    if (phase !== 'no-output') child.stdout.emit('data', Buffer.from('private transcript'));
    if (phase === 'exit-drain') child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(599900);
    const result = await pending;
    expect(result).toMatchObject({ code: 'REVIEWER_PROCESS_TIMEOUT', diagnostics: { cli: {
      phase, spawnMs: 0, elapsedMs: 600000, closeMs: null,
      firstOutputMs: phase === 'no-output' ? null : 100,
      lastOutputMs: phase === 'no-output' ? null : 100,
      exitMs: phase === 'exit-drain' ? 100 : null,
      stdoutBytes: phase === 'no-output' ? 0 : 18, stderrBytes: 0,
    } } });
    expect(result.error).toContain('timed out');
    expect(result.exitCode).toBeUndefined();
    expect(JSON.stringify(result.diagnostics)).not.toContain('private transcript');
    expect(killProcessTree).toHaveBeenCalledOnce();
    child.emit('close', 0); // a late close must not turn failure into a verdict
  });
});
