/**
 * Source contract for the graceful-shutdown handler's host-restart bookkeeping (#3202).
 *
 * `registerShutdownHandlers` has no unit harness — it wires real signal handlers
 * around a live HTTP/Socket.IO/DB stack — so the two ordering guarantees it must
 * uphold are asserted against the source instead. Both are the kind of thing a
 * well-meaning refactor silently breaks:
 *
 *   1. `markHostShuttingDown()` runs BEFORE the handler's first `await`. pm2's
 *      TreeKill signals the whole tree at once, so an agent PTY can exit during
 *      the very first await — and if the flag isn't latched yet, that exit is
 *      recorded as a completed run, which is the bug this issue is about.
 *   2. The marker is built from `activeAgents` (the agents THIS process owns),
 *      not from `getActiveAgentIds()` — runner-mode agents live in portos-cos,
 *      survive the restart untouched, and must never be named as interrupted.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
// The shared brace-walker + comment stripper. Hand-rolling either is what
// server/lib/README.md explicitly warns against — the naive "first `{` after the
// anchor" version silently slices the wrong region the moment a signature grows
// a destructured or defaulted parameter.
import { extractDeclaration, stripCommentsAndNormalize } from '../lib/mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'bootstrap.js'), 'utf-8').replace(/\r\n/g, '\n');

describe('shutdown handler — host-restart bookkeeping (#3202)', () => {
  const shutdownBody = extractDeclaration(SRC, 'shutdown');

  it('finds the shutdown handler at all', () => {
    expect(shutdownBody, 'const shutdown = … not found in bootstrap.js').toBeTruthy();
  });

  // Comments stripped for every assertion below: this file's own prose talks
  // about `await` and `getActiveAgentIds`, and matching that would be matching
  // the explanation rather than the code.
  const code = stripCommentsAndNormalize(shutdownBody || '');

  it('latches the host-shutdown flag before the handler awaits anything', () => {
    const latchAt = code.indexOf('markHostShuttingDown()');
    expect(latchAt, 'markHostShuttingDown() is not called in shutdown()').toBeGreaterThan(-1);

    const firstAwaitAt = code.search(/\bawait\b/);
    // No await at all would also satisfy the ordering requirement.
    if (firstAwaitAt > -1) expect(latchAt).toBeLessThan(firstAwaitAt);
  });

  it('snapshots the agent set from activeAgents only — runner agents survive the restart', () => {
    expect(code).toMatch(/writeHostShutdownMarker\(\{\s*agentIds:\s*\[\.\.\.activeAgents\.keys\(\)\]/);
    // getActiveAgentIds() folds in runnerAgents — naming those would tell the
    // next boot that portos-cos-owned agents were interrupted when they weren't.
    expect(code).not.toContain('getActiveAgentIds');
  });

  // The write is kicked off early (so the agent snapshot is taken before any
  // await can let the set change) but awaited last, so a slow disk spends none
  // of the graceful budget ahead of the socket/HTTP teardown.
  it('starts the marker write before the teardown and awaits it before exiting', () => {
    const startAt = code.indexOf('writeHostShutdownMarker(');
    const awaitAt = code.indexOf('await markerWritten');
    const exitAt = code.indexOf('process.exit(0)');

    expect(startAt).toBeGreaterThan(-1);
    expect(startAt).toBeLessThan(code.indexOf('closeAllConnections'));
    expect(awaitAt).toBeGreaterThan(startAt);
    expect(awaitAt).toBeLessThan(exitAt);
  });
});

// Execute only the close boundary; importing bootstrap loads the live service
// graph. Fake time pins the shutdown deadline without production sleeps.
describe('bounded server shutdown', () => {
  afterEach(() => vi.useRealTimers());

  const loadCloseServer = () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const error = vi.fn();
    const closeServer = runInNewContext(`
      ${extractDeclaration(SRC, 'logBootstrapFailure')}
      ${extractDeclaration(SRC, 'withGrace')}
      ${extractDeclaration(SRC, 'closeServer')}
      closeServer;
    `, { console: { log, error }, setTimeout });
    return { closeServer, log, error };
  };

  it('resolves successful, already-closed and failed closes with their respective logs', async () => {
    const { closeServer, log, error } = loadCloseServer();
    for (const outcome of [undefined, { code: 'ERR_SERVER_NOT_RUNNING' }, new Error('close failed')]) {
      const order = [];
      await expect(closeServer({
        close: (done) => { order.push('stop accepting'); done(outcome); },
        closeAllConnections: () => order.push('drop connections'),
      }, 'HTTP server')).resolves.toBeUndefined();
      expect(order).toEqual(['stop accepting', 'drop connections']);
    }
    await expect(closeServer(null, 'Local HTTP mirror')).resolves.toBeUndefined();
    expect(log.mock.calls).toEqual([['✅ HTTP server closed'], ['✅ HTTP server closed']]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe('⚠️ Error closing HTTP server: close failed');
    expect(error.mock.calls[0][1]).toContain('Error: close failed');
    await vi.runAllTimersAsync();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('continues at the grace deadline and ignores late close callbacks', async () => {
    const { closeServer, log, error } = loadCloseServer();
    let onClose;
    const settled = vi.fn();
    const closing = closeServer({ close: (done) => { onClose = done; } }, 'HTTP server').then(settled);
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(error.mock.calls).toEqual([['⚠️ HTTP server close exceeded 250ms — proceeding']]);
    onClose();
    onClose(new Error('late failure'));
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
