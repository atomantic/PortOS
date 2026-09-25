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
import { logFailureWithStack } from '../lib/failureLogging.js';

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
    expect(startAt).toBeLessThan(code.indexOf('closeServer('));
    expect(awaitAt).toBeGreaterThan(startAt);
    expect(awaitAt).toBeLessThan(exitAt);
  });
});

// #8323. The drain itself (intake refusal, in-flight completion, deadline) is
// exercised against real listeners in lib/httpDrain.test.js; what only this
// handler can get wrong is WHEN it runs relative to the rest of the teardown.
describe('shutdown handler — request drain ordering (#8323)', () => {
  const code = stripCommentsAndNormalize(extractDeclaration(SRC, 'shutdown') || '');

  it('stops request intake before the first await and waits on it before the forced close', () => {
    const beginAt = code.indexOf('httpDrain.begin(HTTP_DRAIN_WINDOW_MS)');
    expect(beginAt, 'httpDrain.begin(...) is not called in shutdown()').toBeGreaterThan(-1);
    expect(beginAt).toBeLessThan(code.search(/\bawait\b/));

    const drainedAt = code.indexOf('await requestsDrained');
    expect(drainedAt).toBeGreaterThan(code.indexOf('io.close('));
    expect(drainedAt).toBeLessThan(code.indexOf('closeServer('));
    // Force-dropping connections up front would cut the requests being drained.
    expect(code.indexOf('closeAllConnections')).toBe(-1);
  });

  it('fits the drain window and the close graces inside the shutdown ceiling', () => {
    const constant = (name) => Number(SRC.match(new RegExp(`const ${name} = (\\d+);`))?.[1]);
    const closeGrace = Number(SRC.match(/const closeServer = \(server, label, graceMs = (\d+)\)/)?.[1]);
    const dbGrace = Number(code.match(/withGrace\('DB pool', (\d+)/)?.[1]);
    expect(constant('HTTP_DRAIN_WINDOW_MS') + closeGrace + dbGrace)
      .toBeLessThan(constant('GRACEFUL_SHUTDOWN_TIMEOUT_MS'));
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
      ${extractDeclaration(SRC, 'withGrace')}
      ${extractDeclaration(SRC, 'closeServer')}
      closeServer;
    `, { console: { log, error }, setTimeout, logBootstrapFailure: logFailureWithStack });
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
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(error.mock.calls).toEqual([['⚠️ HTTP server close exceeded 1000ms — proceeding']]);
    onClose();
    onClose(new Error('late failure'));
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

// #7496. A credential-bootstrap-wrapped child is spawned `detached: true` so
// stop/timeout/cancel can signal its whole process group. That detach moves it
// out of the server's own process group, so a shutdown driven by a signal aimed
// at that group (Ctrl-C at an `npm start` terminal, `kill -<pgid>`) no longer
// reaches it. The sweep has to cover EVERY detached spawn site — agent runs,
// CLI runs and vision calls — which is why it reads the credentialBootstrap
// registry rather than `activeAgents`, whose map holds only the agent children.
describe('shutdown handler — detached-group teardown (#7496)', () => {
  const code = stripCommentsAndNormalize(extractDeclaration(SRC, 'shutdown') || '');

  it('sweeps the detached-group registry, not just the agent map', () => {
    const signalAt = code.indexOf('signalDetachedGroups(');
    expect(signalAt, 'signalDetachedGroups(...) is not called in shutdown()').toBeGreaterThan(-1);
    // A sweep over activeAgents would silently miss every executeCliRun /
    // describeImageViaCli child, which are detached by the same rule.
    expect(code).not.toContain('signalDetachedAgentGroups');
  });

  it('signals the groups before dropping connections', () => {
    // Signalling after the server has begun closing would race process.exit.
    expect(code.indexOf('signalDetachedGroups(')).toBeLessThan(code.indexOf('closeServer('));
  });
});

// #8325. An admitted media job is acknowledged only once its snapshot is on
// disk; shutdown must not exit while that write, a terminal transition, or the
// final progress snapshot is still in the persist chain.
describe('shutdown handler — media-job queue flush (#8325)', () => {
  const code = stripCommentsAndNormalize(extractDeclaration(SRC, 'shutdown') || '');

  it('flushes after admissions stop, before the DB close, and awaits it before exiting', () => {
    const flushAt = code.indexOf('flushMediaJobQueue(');
    expect(flushAt, 'flushMediaJobQueue() is not called in shutdown()').toBeGreaterThan(-1);
    // Started only once the HTTP servers stop accepting requests, so no route
    // can admit a job the flush misses.
    expect(flushAt).toBeGreaterThan(code.indexOf("closeServer(httpServer"));
    expect(flushAt).toBeLessThan(code.indexOf("import('../lib/db.js')"));
    const awaitAt = code.indexOf('await mediaQueueFlushed');
    expect(awaitAt).toBeGreaterThan(flushAt);
    expect(awaitAt).toBeLessThan(code.indexOf('process.exit(0)'));
  });
});
