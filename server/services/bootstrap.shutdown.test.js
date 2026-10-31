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
 *   2. The marker includes active agents and unfinished dispatches,
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
import { createEventLoopLagProbe, __createManualClock } from '../lib/eventLoopLagProbe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'bootstrap.js'), 'utf-8').replace(/\r\n/g, '\n');

// Execute the signal boundary without importing the live service graph. Module
// loading is injected so a suspended teardown uses fake time, never a real disk.
const loadShutdown = (loadModule) => {
  const signals = new Map();
  const exit = vi.fn();
  const marker = vi.fn(async () => {});
  const flush = vi.fn(async () => ({ ok: true }));
  const close = vi.fn(async () => {});
  const noop = () => {};
  runInNewContext(`
    ${extractDeclaration(SRC, 'withGrace')}
    ${extractDeclaration(SRC, 'closeServer')}
    const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10000;
    const HTTP_DRAIN_WINDOW_MS = 5000;
    const PEER_SYNC_STOP_GRACE_MS = 1000;
    ${extractDeclaration(SRC, 'registerShutdownHandlers').replace(/^export /, '').replace(/\bimport\(/g, 'loadModule(')}
    registerShutdownHandlers({ io: { close: done => done() }, httpServer: null, localHttpServer: null });
  `, {
    process: { on: (signal, handler) => signals.set(signal, handler), exit, env: {}, stdin: {}, pid: 1, ppid: 2 },
    console: { log: noop, warn: noop, error: noop }, setTimeout, clearTimeout,
    createHttpDrain: () => ({ begin: async () => ({ remaining: 0 }), destroyUpgraded: noop }),
    markHostShuttingDown: noop, quiesceMediaJobQueue: noop, quiesceScheduledEvents: noop,
    drainScheduledEvents: async () => {},
    createEventLoopLagProbe: () => ({ begin: () => ({ mark: noop, end: noop, snapshot: () => ({ totalMs: 0 }) }) }),
    describeSlowShutdown: () => null,
    stopIdleReaper: noop, stopHostedSessionSweep: noop, stopBeeperSocket: noop,
    activeAgents: new Map([['example-agent', {}]]), dispatchingAgentIds: new Set(),
    writeHostShutdownMarker: marker, signalDetachedGroups: noop, stopCodexAppServer: async () => {},
    flushIdeaLoomAutoSync: async () => {}, flushCatalogUniverseFiling: async () => {}, flushMediaJobQueue: flush,
    quiesceSharingForExit: noop, drainPeerSyncOperations: async () => {},
    logBootstrapFailure: noop,
    loadModule: (path) => path === '../lib/db.js' ? Promise.resolve({ close }) : loadModule(path),
  });
  return { stop: () => signals.get('SIGTERM')(), exit, marker, flush, close };
};

describe('shutdown signal deadline and recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('starts the hard deadline at the signal even when the first teardown import stalls', async () => {
    vi.useFakeTimers();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const lifecycle = loadShutdown(() => gate);
    const stopping = lifecycle.stop();
    try {
      await vi.advanceTimersByTimeAsync(9999);
      expect(lifecycle.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(lifecycle.exit).toHaveBeenCalledWith(1);
      expect(lifecycle.marker).toHaveBeenCalledOnce();
    } finally {
      release({ stopAllForwards: () => {}, stopServeProcess: () => {}, stopFleetLlmHost: async () => {}, stopTailcatIngress: () => {} });
      await stopping;
    }
  });

  it('preserves agent recovery and flushes the queue and DB when model-host usage cannot flush', async () => {
    vi.useFakeTimers();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const lifecycle = loadShutdown(async () => ({
      stopAllForwards: () => {}, stopServeProcess: () => {},
      stopFleetLlmHost: () => gate, stopTailcatIngress: () => {},
    }));
    const stopping = lifecycle.stop();
    try {
      await vi.advanceTimersByTimeAsync(1500);
      expect(lifecycle.marker).toHaveBeenCalledOnce();
      expect(lifecycle.flush).toHaveBeenCalledOnce();
      expect(lifecycle.close).toHaveBeenCalledOnce();
      expect(lifecycle.exit).toHaveBeenCalledWith(0);
    } finally {
      release();
      await stopping;
    }
  });
});

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

  it('snapshots active agents and unfinished dispatches without adopted runner agents', () => {
    const markerArgs = code.match(/writeHostShutdownMarker\((\{[^}]+\})\)/)?.[1];
    expect(markerArgs).toBeTruthy();
    const snapshot = runInNewContext(`(${markerArgs})`, {
      activeAgents: new Map([['agent-active', {}]]),
      dispatchingAgentIds: new Set(['agent-initializing']),
      runnerAgents: new Map([['agent-survivor', {}]]),
      signal: 'SIGTERM',
    });
    expect([...snapshot.agentIds]).toEqual(['agent-active', 'agent-initializing']);
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

  it('reports requests that outlive the drain window on stdout: closing them is the bounded handling', () => {
    expect(code).toMatch(/remaining > 0\) console\.log\(`⏱️ /);
    expect(code).not.toMatch(/remaining > 0\) console\.(warn|error)\(/);
  });

  it('fits the drain window and the close graces inside the shutdown ceiling', () => {
    const constant = (name) => Number(SRC.match(new RegExp(`const ${name} = (\\d+);`))?.[1]);
    const closeGrace = Number(SRC.match(/const closeServer = \(server, label, graceMs = (\d+)\)/)?.[1]);
    const dbGrace = Number(code.match(/withGrace\('DB pool', (\d+)/)?.[1]);
    expect(constant('HTTP_DRAIN_WINDOW_MS') + closeGrace + constant('PEER_SYNC_STOP_GRACE_MS') + dbGrace)
      .toBeLessThan(constant('GRACEFUL_SHUTDOWN_TIMEOUT_MS'));
  });
});

describe('shutdown handler — scheduled handlers finish before the DB pool closes', () => {
  const code = stripCommentsAndNormalize(extractDeclaration(SRC, 'shutdown') || '');

  it('quiesces and starts a bounded drain before any await, then joins it before DB close', () => {
    const firstAwait = code.indexOf('await ');
    expect(code.indexOf('quiesceScheduledEvents()')).toBeGreaterThan(-1);
    expect(code.indexOf('quiesceScheduledEvents()')).toBeLessThan(firstAwait);
    expect(code.indexOf('drainScheduledEvents()')).toBeGreaterThan(code.indexOf('quiesceScheduledEvents()'));
    expect(code.indexOf('drainScheduledEvents()')).toBeLessThan(firstAwait);
    expect(code).toContain("withGrace('Scheduled events', HTTP_DRAIN_WINDOW_MS,");
    const joinAt = code.indexOf('await scheduledEventsDrained');
    expect(joinAt).toBeGreaterThan(code.indexOf('closeServer('));
    expect(joinAt).toBeLessThan(code.indexOf("withGrace('DB pool'"));
  });
});

// Issue #11756: the IdeaLoom export debounce is in memory, so shutdown must
// flush it — after the servers close (nothing can schedule another export),
// bounded by a grace, overlapping the DB close, and awaited before exit.
describe('shutdown handler — IdeaLoom auto-sync flush (#11756)', () => {
  const code = stripCommentsAndNormalize(extractDeclaration(SRC, 'shutdown') || '');

  it('flushes auto-sync under a bounded grace after the servers close and awaits it before exit', () => {
    const flushAt = code.indexOf('flushIdeaLoomAutoSync()');
    expect(flushAt, 'flushAutoSync() is not called in shutdown()').toBeGreaterThan(-1);
    expect(code).toMatch(/const ideaLoomFlushed = withGrace\('IdeaLoom auto-sync flush', \d+,/);
    expect(flushAt).toBeGreaterThan(code.indexOf('closeServer('));
    expect(flushAt).toBeLessThan(code.indexOf("withGrace('DB pool'"));
    const awaitAt = code.indexOf('await ideaLoomFlushed');
    expect(awaitAt).toBeGreaterThan(code.indexOf("withGrace('DB pool'"));
    expect(awaitAt).toBeLessThan(code.indexOf('process.exit(0)'));
  });

  it('keeps the flush grace within the DB close grace so the ceiling is unchanged', () => {
    const flushGrace = Number(code.match(/withGrace\('IdeaLoom auto-sync flush', (\d+)/)?.[1]);
    const dbGrace = Number(code.match(/withGrace\('DB pool', (\d+)/)?.[1]);
    expect(flushGrace).toBeLessThanOrEqual(dbGrace);
  });
});

// Issue #14262: debounced catalog universe filing is in memory, so shutdown must
// flush it after the servers close, bounded by a grace, and await it before the
// DB pool closes (the pass reads and writes through the DB).
describe('shutdown handler — catalog universe filing flush (#14262)', () => {
  const code = stripCommentsAndNormalize(extractDeclaration(SRC, 'shutdown') || '');

  it('flushes filing under a bounded grace after the servers close and awaits it before the pool', () => {
    const flushAt = code.indexOf('flushCatalogUniverseFiling()');
    expect(flushAt, 'flushCatalogUniverseFiling() is not called in shutdown()').toBeGreaterThan(-1);
    expect(code).toMatch(/const catalogFilingFlushed = withGrace\('Catalog universe filing flush', \d+,/);
    expect(flushAt).toBeGreaterThan(code.indexOf('closeServer('));
    expect(code.indexOf('await catalogFilingFlushed')).toBeGreaterThan(-1);
    expect(code.indexOf('await catalogFilingFlushed')).toBeLessThan(code.indexOf("withGrace('DB pool'"));
  });

  it('keeps the filing grace within the DB close grace so the ceiling is unchanged', () => {
    const flushGrace = Number(code.match(/withGrace\('Catalog universe filing flush', (\d+)/)?.[1]);
    const dbGrace = Number(code.match(/withGrace\('DB pool', (\d+)/)?.[1]);
    expect(flushGrace).toBeLessThanOrEqual(dbGrace);
  });
});

// Issue #12585: a peer:online convergence walk still running when the pool ends
// logs a pool-ended stack per remaining subscription, so sharing stops (and its
// background work settles, bounded) after the servers close and before the pool.
describe('shutdown handler — peer sync stops before the DB pool closes (#12585)', () => {
  const code = stripCommentsAndNormalize(extractDeclaration(SRC, 'shutdown') || '');

  it('stops sharing then drains, under a grace, between the HTTP close and the DB pool close', () => {
    const stopAt = code.indexOf('quiesceSharingForExit');
    expect(stopAt, 'quiesceSharingForExit is not called in shutdown()').toBeGreaterThan(-1);
    expect(code).toMatch(/withGrace\('Peer sync', PEER_SYNC_STOP_GRACE_MS,/);
    expect(code.indexOf('drainPeerSyncOperations()')).toBeGreaterThan(stopAt);
    expect(stopAt).toBeGreaterThan(code.indexOf('closeServer('));
    expect(stopAt).toBeLessThan(code.indexOf("withGrace('DB pool'"));
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
    expect(log.mock.calls).toEqual([['⏱️ HTTP server close exceeded 1000ms — proceeding']]);
    onClose();
    onClose(new Error('late failure'));
    expect(log).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
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
describe('shutdown handler — media-job queue quiesce + flush (#8325, #8691)', () => {
  const code = stripCommentsAndNormalize(extractDeclaration(SRC, 'shutdown') || '');

  // #8691: dispatch stops at the signal, not at the flush — a lane freed while
  // accepted requests drain must not start a waiting job the exit abandons.
  it('quiesces media-job dispatch before the handler awaits anything', () => {
    const quiesceAt = code.indexOf('quiesceMediaJobQueue()');
    expect(quiesceAt, 'quiesceMediaJobQueue() is not called in shutdown()').toBeGreaterThan(-1);
    expect(quiesceAt).toBeLessThan(code.search(/\bawait\b/));
    expect(quiesceAt).toBeLessThan(code.indexOf('flushMediaJobQueue('));
  });

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

// #12853: closing the share-bucket watchers blocked the main thread for seconds
// on macOS, starving the marker and media-flush timers and, past PM2's kill
// window, skipping the rest of the teardown.
describe('shutdown handler — no blocking teardown at exit (#12853)', () => {
  const code = stripCommentsAndNormalize(extractDeclaration(SRC, 'shutdown') || '');

  it('leaves share-bucket watchers open and starts the durable writes before stopping sharing', () => {
    expect(code).not.toMatch(/shutdownSharing|shutdownAllWatchers|detachWatcher/);
    const stopAt = code.indexOf('quiesceSharingForExit');
    expect(code.indexOf('writeHostShutdownMarker(')).toBeLessThan(stopAt);
    expect(code.indexOf('flushMediaJobQueue(')).toBeLessThan(stopAt);
  });

  it('reports a slow shutdown on both exits', () => {
    const exits = [...code.matchAll(/process\.exit\([01]\)/g)];
    expect(exits).toHaveLength(2);
    for (const exit of exits) {
      expect(code.slice(0, exit.index).trimEnd().endsWith('reportIfSlow();')).toBe(true);
    }
  });

  const describeSlowShutdown = runInNewContext(`
    ${SRC.match(/const SLOW_SHUTDOWN_MS = \d+;/)[0]}
    ${extractDeclaration(SRC, 'describeSlowShutdown')}
    describeSlowShutdown;
  `, {});

  it('names the step that blocked the loop in one numbers-only line, and stays silent when fast', () => {
    const clock = __createManualClock();
    const span = createEventLoopLagProbe({ clock }).begin('httpClose');
    clock.advance(20);
    span.mark('peerSync');
    clock.advance(100);
    clock.stall(6000);
    clock.advance(100);
    span.mark('dbPool');
    clock.advance(30);
    const line = describeSlowShutdown(span.end(), { marker: 6250, mediaFlush: 6240 });
    expect(line).toMatch(/^🐢 Graceful shutdown slow totalMs=6250 slowestStep=peerSync /);
    // Most of the step was loop lag: a synchronous block, not slow I/O.
    expect(Number(line.match(/ peerSyncMs=6200 peerSyncLagMs=(\d+) /)?.[1])).toBeGreaterThan(5000);
    expect(line).toContain('markerSettledMs=6250 mediaFlushSettledMs=6240');

    const fast = createEventLoopLagProbe({ clock }).begin('httpClose');
    clock.advance(300);
    expect(describeSlowShutdown(fast.end(), {})).toBeNull();
  });
});
