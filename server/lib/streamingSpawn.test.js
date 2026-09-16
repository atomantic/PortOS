import { describe, expect, it } from 'vitest';
import { runStreamingCommand } from './streamingSpawn.js';

const NODE = process.execPath;

describe('runStreamingCommand', () => {
  it('streams stdout and stderr lines in order and resolves success on exit 0', async () => {
    const lines = [];
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'console.log("one"); console.error("two"); console.log("three")'],
      (line) => lines.push(line),
    );

    expect(result).toEqual({ success: true });
    expect(lines).toContain('one');
    expect(lines).toContain('two');
    expect(lines).toContain('three');
  });

  it('carries the tail of the output into a non-zero exit, not just the code', async () => {
    // The whole reason for the tail: `brew upgrade ollama` exits 1 saying
    // "Error: ollama not installed", and "exited with code 1" is not a fix.
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'console.error("Error: ollama not installed"); process.exit(1)'],
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exit 1: .*ollama not installed/);
  });

  it('resolves rather than rejecting when the binary does not exist', async () => {
    // Callers run outside the Express request lifecycle — a rejection here
    // would surface as an unhandled rejection, not as a 500.
    const result = await runStreamingCommand('portos-no-such-binary-xyz', ['--version']);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('kills a command the caller cancels, without waiting for its timeout', async () => {
    // A weights download runs for hours and the caller holds a lock until this
    // settles, so a closed stream has to actually STOP the child — a timeout
    // bounds the worst case, it does not answer a cancel.
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 50);
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'setTimeout(() => {}, 600000)'],
      undefined,
      { timeoutMs: 600_000, isCancelled: () => cancelled },
    );

    expect(result).toEqual({ success: false, error: 'cancelled' });
  }, 20_000);

  it('treats a throwing cancellation check as "not cancelled" rather than crashing', async () => {
    // The poll fires outside the Express request lifecycle: an uncaught throw
    // there takes the process down, with no `next(err)` to bubble to.
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'console.log("done")'],
      undefined,
      { isCancelled: () => { throw new Error('gone'); } },
    );

    expect(result).toEqual({ success: true });
  });

  it('kills a command that outruns its timeout', async () => {
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'setTimeout(() => {}, 10000)'],
      undefined,
      { timeoutMs: 150 },
    );
    expect(result).toEqual({ success: false, error: 'timed out after 0s' });
  });

  it('survives a throwing output hook instead of taking the process down', async () => {
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'console.log("boom")'],
      () => { throw new Error('hook exploded'); },
    );
    expect(result).toEqual({ success: true });
  });
});

describe('runStreamingCommand — stream separation', () => {
  it('keeps stdout and stderr lines intact when partial chunks interleave', async () => {
    // One buffer shared by both streams splices a half-written stdout line into
    // the next stderr chunk: the caller sees `OUT-ERR-one` and loses both real
    // lines. `server/lib/README.md` states the rule this pins — one line reader
    // per stream.
    const lines = [];
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'process.stdout.write("OUT-"); process.stderr.write("ERR-"); process.stdout.write("one\\n"); process.stderr.write("two\\n")'],
      (line) => lines.push(line),
    );

    expect(result).toEqual({ success: true });
    expect(lines).toContain('OUT-one');
    expect(lines).toContain('ERR-two');
  });
});

// #7496. `opencodeTask` hands this helper a credential-bootstrap WRAPPER rather
// than the harness, and a per-pid SIGKILL reaches only that wrapper — the
// harness behind it keeps running past the task's timeout or the user's cancel.
describe('runStreamingCommand — process-group teardown', () => {
  const SH = '/bin/sh';
  // A wrapper that outlives its own SIGKILL'd child: `sleep` is a separate
  // process, so killing only the shell's pid leaves it running. Printing its
  // pid is what lets the assertion probe the real outcome.
  const FORKING_WRAPPER = ['-c', 'sleep 30 & echo $!; wait'];

  const probeAlive = (pid) => {
    // Signal 0 tests for existence without delivering anything.
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  it.skipIf(process.platform === 'win32')('takes the grandchild down with the wrapper on timeout', async () => {
    let grandchildPid = null;
    const result = await runStreamingCommand(SH, FORKING_WRAPPER, (line) => {
      if (grandchildPid === null && /^\d+$/.test(line)) grandchildPid = Number(line);
    }, { timeoutMs: 300, processGroup: true });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(Number.isInteger(grandchildPid)).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 200));
    const alive = probeAlive(grandchildPid);
    if (alive) process.kill(grandchildPid, 'SIGKILL');
    expect(alive).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('leaves an ordinary command on the per-pid kill', async () => {
    // Without the flag the grandchild survives — which is correct for every
    // ordinary caller (an npm install, a model download), whose direct child IS
    // the process to kill. This is the baseline the test above is measured from.
    let grandchildPid = null;
    await runStreamingCommand(SH, FORKING_WRAPPER, (line) => {
      if (grandchildPid === null && /^\d+$/.test(line)) grandchildPid = Number(line);
    }, { timeoutMs: 300 });

    await new Promise(resolve => setTimeout(resolve, 200));
    const alive = probeAlive(grandchildPid);
    // Clean up regardless — this test deliberately strands a `sleep`.
    if (alive) process.kill(grandchildPid, 'SIGKILL');
    expect(alive).toBe(true);
  });
});
