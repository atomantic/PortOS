/** Register signal handlers and drain listeners, owned processes, queues, and durable writes during shutdown. */

import { stopIdleReaper } from '../../lib/managedDaemon.js';
import { markHostShuttingDown, writeHostShutdownMarker } from '../../lib/hostShutdown.js';
import { signalDetachedGroups } from '../../lib/credentialBootstrap.js';
import { createHttpDrain } from '../../lib/httpDrain.js';
import { createEventLoopLagProbe } from '../../lib/eventLoopLagProbe.js';
import { quiesce as quiesceScheduledEvents, drain as drainScheduledEvents } from '../eventScheduler.js';
import { flushPendingUsageWrites } from '../usage.js';
import { stopHistoricalUsageBackfill } from '../usageBackfill.js';
import { stopHarnessActionRecovery } from '../harnessActionRecovery.js';
import { stopAutomaticUpdateReservationRecovery } from '../automaticUpdateReservationRecovery.js';
import { activeAgents, dispatchingAgentIds } from '../agent/agentState.js';
import { flushSettingsLedger } from '../settings.js';
import { drainJevSidecarStops, stopJevSidecar } from '../jev.js';
import mediaService from '../mediaService.js';
import { stopBeeperSocket } from '../beeper/beeperSocket.js';
import { flushAutoSync as flushIdeaLoomAutoSync } from '../idealoomAutoSync.js';
import { flushMediaJobQueue, quiesceMediaJobQueue } from '../mediaJobQueue/index.js';
import { quiesceSharingForExit, drainPeerSyncOperations } from '../sharing/index.js';
import { flushCatalogUniverseFiling } from '../catalog/catalogUniverseFiling.js';
import { stopHostedSessionSweep } from '../fableLoom/hostedSession.js';
import { stopCodexAppServer } from '../codexAppServer.js';
import { logFailureWithStack as logBootstrapFailure } from '../../lib/failureLogging.js';

// Run an async close but resolve anyway after `ms` — so a close that never
// settles (e.g. a WebSocket-upgraded socket the server no longer tracks, or a
// leaked DB client) can't hang shutdown; process.exit() reclaims the resources at
// the OS level. Both callbacks passed to run resolve the same settle-once
// promise: finish logs success, finishWithError logs an error (and its stack)
// and continues.
// The backstop is .unref()'d so it never keeps the event loop alive on its own.
const withGrace = (label, ms, run) => new Promise((resolve) => {
  let settled = false;
  const complete = (msg, log, error) => {
    if (settled) return;
    settled = true;
    if (msg) {
      if (error) logBootstrapFailure(msg, error, log);
      else log(msg);
    }
    resolve();
  };
  const finish = (msg) => complete(msg, console.log);
  const finishWithError = (msg, error) => complete(msg, console.error, error);
  run({ finish, finishWithError });
  // Expected on most restarts (lingering upgraded sockets); the bounded wait is the handling.
  setTimeout(() => finish(`⏱️ ${label} close exceeded ${ms}ms — proceeding`), ms).unref?.();
});

// graceMs is deliberately bounded: this runs after the request drain's deadline,
// and closeAllConnections() force-drops every connection still open, so there is
// no graceful drain left to wait for. The close callback
// still needs a short window for TLS/socket teardown — the only thing that can
// outlast it is a WebSocket-upgraded socket the server no longer tracks (and
// io.close()'s engine.close() already tore those down protocol-side; the OS reaps
// the TCP remnant on process.exit).
// ERR_SERVER_NOT_RUNNING means it was already closed (io.close() closes whichever
// server is its current this.httpServer) — success for us, not a failure.
const closeServer = (server, label, graceMs = 1000) => withGrace(label, graceMs, ({ finish, finishWithError }) => {
  if (!server) return finish();
  server.close((err) => {
    if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') finishWithError(`⚠️ Error closing ${label}`, err);
    else finish(`✅ ${label} closed`);
  });
  // Order matters: close() above stops accepting NEW connections (the drain has
  // normally done that already); NOW force-drop whatever outlived the drain
  // window. (Node 18.2+.)
  server.closeAllConnections?.();
});

// Hard ceiling on graceful shutdown: if Socket.IO/HTTP don't close within this
// window, force-exit so PM2 isn't left waiting on a hung process.
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10000;

// How long an already-accepted ordinary API request may keep running after the
// signal (#8323). Measured from the signal, so it overlaps the teardown steps
// before the HTTP close rather than adding to them. Afterward, peer sync and
// ledger flushes overlap to leave time for closing the DB pool.
const HTTP_DRAIN_WINDOW_MS = 5000;

// Bound on stopping peer sync and settling its in-flight pushes before the DB
// pool closes.
const PEER_SYNC_STOP_GRACE_MS = 1000;

// A shutdown at or above this logs one numbers-only line naming where the time
// went (#12853). A step's loop lag is time the event loop could not run timers —
// a synchronous block — rather than asynchronous waiting.
const SLOW_SHUTDOWN_MS = 1000;
const describeSlowShutdown = (summary, settledMs) => {
  if (summary.totalMs < SLOW_SHUTDOWN_MS) return null;
  const phases = Object.entries(summary.phases);
  const [slowest] = phases.reduce((max, entry) => (entry[1].ms > max[1].ms ? entry : max), phases[0]);
  const steps = phases.map(([name, { ms, lagMs }]) => `${name}Ms=${ms} ${name}LagMs=${lagMs}`);
  const settled = Object.entries(settledMs).map(([name, ms]) => `${name}SettledMs=${ms}`);
  return `🐢 Graceful shutdown slow totalMs=${summary.totalMs} slowestStep=${slowest} loopLagMs=${summary.lagMs} loopLagMaxMs=${summary.lagMaxMs} ${[...steps, ...settled].join(' ')}`;
};

/**
 * Wire SIGTERM/SIGINT to the graceful-shutdown state machine. Idempotent per
 * signal: once shutdown starts, later signals are ignored.
 */
export const registerShutdownHandlers = ({ io, httpServer, localHttpServer }, {
  hostProcess = process,
  createLagProbe = createEventLoopLagProbe
} = {}) => {
  // Track in-flight requests from boot so shutdown knows what it is waiting on.
  const httpDrain = createHttpDrain([httpServer, localHttpServer]);
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Latch the host-shutdown flag BEFORE anything can await. pm2's TreeKill
    // signals the whole descendant tree, so a server-owned agent PTY can exit
    // microseconds from now — and its exit handler must already know the PTY
    // died because PortOS is going down, not because the agent finished (#3202).
    markHostShuttingDown();
    // Stop request intake on BOTH listeners before the first await, so nothing
    // new is accepted while the teardown below runs; requests already accepted
    // keep running and are waited on (bounded) just before the HTTP close.
    const requestsDrained = httpDrain.begin(HTTP_DRAIN_WINDOW_MS);
    // Stop media-job dispatch before the first await too (#8691): a lane freed
    // during teardown must not promote a waiting job the process is about to
    // abandon — the next boot fails a running record but restores a queued one.
    quiesceMediaJobQueue();
    quiesceScheduledEvents();
    // Start alongside the request drain so a stuck background handler spends
    // no additional shutdown budget. The DB remains open until both settle.
    const scheduledEventsDrained = withGrace('Scheduled events', HTTP_DRAIN_WINDOW_MS, ({ finish, finishWithError }) =>
      drainScheduledEvents().then(
        () => finish('✅ Scheduled events drained'),
        (err) => finishWithError('⚠️ Scheduled events drain failed', err),
      ));
    // Stop the worker while HTTP drains. Any ledger work its last message
    // already queued must settle before the usage flush and DB close.
    const usageBackfillStopped = withGrace('Historical usage backfill', HTTP_DRAIN_WINDOW_MS, ({ finish, finishWithError }) =>
      stopHistoricalUsageBackfill().then(
        () => finish(),
        (err) => finishWithError('⚠️ Historical usage backfill stop failed', err),
      ));
    const timing = createLagProbe().begin('tailcat');
    // Concurrent steps settle out of phase order; recorded as ms since the signal.
    const settledMs = {};
    const recordSettled = (name) => () => { settledMs[name] = timing.snapshot().totalMs; };
    const reportIfSlow = () => {
      const line = describeSlowShutdown(timing.end(), settledMs);
      if (line) console.log(line);
    };
    // Diagnostic context for the shutdown trigger. ppid tells us whether the
    // signal came from PM2 (parent is the PM2 god process), a TTY (parent is
    // the user's shell), or some external orchestrator. pm_* env vars are set
    // by PM2 so their presence + a matching ppid is the smoking gun.
    const { pid, ppid, stdin, env } = hostProcess;
    const tty = stdin.isTTY ? 'tty' : 'no-tty';
    const pmId = env.pm_id ?? env.PM2_ID ?? '<not set>';
    const pmExecPath = env.pm_exec_path ?? '<not set>';
    console.log(`🛑 Received ${signal} - shutting down gracefully (pid=${pid} ppid=${ppid} ${tty} pm_id=${pmId})`);
    if (pmExecPath !== '<not set>') console.log(`   ↳ launched by PM2: pm_exec_path=${pmExecPath}`);

    const forceExitTimer = setTimeout(() => {
      console.error('⚠️ Graceful shutdown timed out, forcing exit');
      reportIfSlow();
      hostProcess.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    // Don't let the safety timer itself keep the event loop alive — if every
    // other handle has closed we should exit immediately, not wait out the timer.
    forceExitTimer.unref?.();

    // Record which agents this process owned, so the NEXT boot's orphan sweep can
    // tell "PortOS was restarted out from under a healthy agent" apart from "the
    // agent's own process died" and skip the retry-budget/cooldown penalty for a
    // fault the agent didn't cause (#3202). Include dispatches whose durable
    // registration exists but whose process handoff has not finished: shutdown
    // destroys that setup too. Exclude `runnerAgents`; those handed-off runs
    // survive this restart and are re-adopted on the next boot.
    //
    // Note `activeAgents` is NOT "direct-spawn only": runner-launched TUI agents
    // register there too (`agentTuiSpawning.js`, both launch modes). The
    // distinction that matters here is process ownership, not spawn mode — do
    // not re-derive the snapshot from "was this spawned via the runner".
    //
    // Started here so the agent snapshot is taken before anything can await, but
    // awaited just before exit so a stalled filesystem spends none of the graceful
    // budget ahead of the teardown below. Best-effort throughout: the helper logs
    // both outcomes and never rejects (hence `finish()` with no message), the
    // `.catch` is the belt-and-suspenders for an out-of-lifecycle rejection, and a
    // marker we fail to write only degrades recovery to the pre-existing orphan path.
    const markerWritten = withGrace('Host-shutdown marker', 1500, ({ finish, finishWithError }) =>
      writeHostShutdownMarker({ agentIds: [...activeAgents.keys(), ...dispatchingAgentIds], signal })
        .then(() => finish(), (err) => finishWithError('⚠️ Host-shutdown marker failed', err)));
    markerWritten.then(recordSettled('marker'));

    // No teardown await may delay the hard deadline, recovery snapshot, or
    // disarming timers that could launch work while shutdown is suspended.
    stopIdleReaper();
    stopHarnessActionRecovery();
    stopAutomaticUpdateReservationRecovery();
    stopHostedSessionSweep();
    stopBeeperSocket();
    // Send SIGTERM before closing HTTP and let escalation overlap the drain.
    await Promise.all([
      Promise.resolve().then(stopJevSidecar)
        .catch((err) => logBootstrapFailure('❌ JEV sidecar shutdown failed', err)),
      Promise.resolve().then(() => mediaService.stopAll())
        .catch((err) => logBootstrapFailure('❌ Media capture shutdown failed', err)),
    ]);
    await import('../tailcatPeer.js').then(({ stopAllForwards }) => stopAllForwards())
      .catch((err) => logBootstrapFailure('❌ Tailcat forward shutdown failed', err));
    await import('../tailcatServe.js').then(({ stopServeProcess }) => stopServeProcess())
      .catch((err) => logBootstrapFailure('❌ Tailcat serve shutdown failed', err));
    timing.mark('modelHost');
    // Usage persistence is best effort; a stalled ledger write must leave
    // time for the media queue and DB to settle inside the shutdown ceiling.
    await withGrace('Dedicated model host', 1000, ({ finish, finishWithError }) =>
      import('../fleetLlmHost.js').then(({ stopFleetLlmHost }) => stopFleetLlmHost()).then(
        () => finish(),
        (err) => finishWithError('❌ Dedicated model host shutdown failed', err),
      ));

    // Reach every child spawned into its own process group — agent runs, CLI
    // runs and vision calls alike. A credential-bootstrap-wrapped child is
    // spawned `detached: true` so stop/timeout/cancel can signal its whole
    // group (#7496); that also moves it OUT of this server's process group, and
    // the one teardown route it thereby loses is a signal aimed at THAT group —
    // Ctrl-C at an `npm start` terminal, or `kill -<pgid>`. (pm2's TreeKill
    // walks the pid TREE, so the managed path is unaffected, and every child
    // already survives a plain SIGTERM to the parent.) This restores exactly
    // that lost reach rather than orphaning a harness holding a freshly minted
    // credential. Before the teardown below, while the process still owns its
    // state; best-effort, like everything else in this window.
    const detachedGroups = signalDetachedGroups('SIGTERM', logBootstrapFailure);
    if (detachedGroups) console.log(`🛑 Signalled ${detachedGroups} detached process group(s)`);

    // Terminate the Codex app-server child before the socket teardown below.
    // pm2's TreeKill would reap it anyway, but a direct SIGTERM keeps a manual
    // `kill` of the server from orphaning a Codex process holding the user's
    // sign-in, and it is a no-op when nothing was ever spawned.
    timing.mark('codex');
    await withGrace('Codex app-server', 2000, ({ finish, finishWithError }) =>
      stopCodexAppServer().then(
        () => finish(),
        (err) => finishWithError('⚠️ Codex app-server stop failed', err),
      ));

    // socket.io's io.close() closes engine.io AND its current this.httpServer — and
    // every io.attach() reassigns this.httpServer (socket.io index.js:303), so with
    // HTTPS on (io.attach(localHttpServer) at boot) io.close() closes the *mirror*,
    // not the primary :5555 server. The historical bug was calling close() a second
    // time on that already-closed server: Node registers the callback as a one-time
    // 'close' listener for an event that already fired, so it never runs and shutdown
    // hangs forever — the real cause of the reconcile "stopping apps" hang.
    // The drain already stopped that server, so io.close() reporting
    // ERR_SERVER_NOT_RUNNING is the expected outcome, not a failure. Its callback
    // still waits for that server's connections to end, so while a slow request
    // is draining this grace can lapse first — Socket.IO itself is torn down by
    // then, and the drain wait below bounds the rest.
    timing.mark('socketIo');
    await withGrace('Socket.IO', 3000, ({ finish, finishWithError }) =>
      io.close((err) => {
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') finishWithError('⚠️ Error closing Socket.IO', err);
        else finish('✅ Socket.IO closed');
      }));
    timing.mark('ingress');
    await import('../tailcatIngress.js').then(({ stopTailcatIngress }) => stopTailcatIngress())
      .catch((err) => logBootstrapFailure('❌ Tailcat ingress shutdown failed', err));
    // Let accepted requests finish (bounded by the drain window), then force the
    // rest closed below — a handler mid-write loses its response only at the deadline.
    timing.mark('requestDrain');
    const { remaining } = await requestsDrained;
    // The drain window is bounded on purpose, so closing what outlives it is the handling.
    if (remaining > 0) console.log(`⏱️ ${remaining} request(s) still running after the ${HTTP_DRAIN_WINDOW_MS}ms drain — closing them`);
    // Close BOTH servers explicitly. The drain already stopped both listeners
    // (ERR_SERVER_NOT_RUNNING → treated as success by closeServer), and
    // the bounded backstop in closeServer guarantees neither can hang shutdown even
    // if a future socket.io version changes which server it owns.
    // Upgraded (WebSocket) sockets are invisible to closeAllConnections() but
    // keep server.close() pending; Socket.IO has already sent its close frames.
    httpDrain.destroyUpgraded();
    timing.mark('httpClose');
    await Promise.all([
      closeServer(httpServer, 'HTTP server'),
      closeServer(localHttpServer, 'Local HTTP mirror')
    ]);

    // A request finishing during the drain may have queued a detached settings
    // ledger write. Keep its DB connection available while the write settles.
    const settingsLedgerFlushed = withGrace('Settings ledger', 2000, ({ finish, finishWithError }) =>
      flushSettingsLedger().then(() => finish(), (err) => finishWithError('⚠️ Settings ledger flush failed', err)));

    // An IdeaLoom vault export still inside its 5s debounce would otherwise be
    // lost. A local file write, so it overlaps the DB close below inside that
    // close's budget rather than adding to the shutdown ceiling; no request can
    // schedule another export now that the servers are closed.
    const ideaLoomFlushed = withGrace('IdeaLoom auto-sync flush', 2500, ({ finish, finishWithError }) =>
      flushIdeaLoomAutoSync().then(() => finish('✅ IdeaLoom auto-sync flushed'), (err) => finishWithError('⚠️ IdeaLoom auto-sync flush failed', err)));
    ideaLoomFlushed.then(recordSettled('ideaLoom'));

    // A debounced catalog universe filing (a render finished in the last second)
    // would otherwise be dropped, and a pass still running races the DB pool
    // close. Started here, awaited before the pool closes (it reads and writes
    // through the DB); the grace bounds it either way.
    const catalogFilingFlushed = withGrace('Catalog universe filing flush', 2500, ({ finish, finishWithError }) =>
      flushCatalogUniverseFiling().then(() => finish('✅ Catalog universe filing flushed'), (err) => finishWithError('⚠️ Catalog universe filing flush failed', err)));

    // Flush the media-job queue now that no request can admit another job
    // (#8325): terminal transitions and the latest progress reach the snapshot a
    // restart restores from. Not earlier: quiescing stops dispatch, not enqueue.
    // Started ahead of the sharing and DB steps, so its write is already in
    // flight when they run (#12853); awaited before exit and bounded by its own
    // timeout so it spends no budget beyond the DB close's.
    const mediaQueueFlushed = flushMediaJobQueue().then((outcome) => {
      recordSettled('mediaFlush')();
      if (outcome.ok) console.log('✅ Media job queue flushed');
      else console.error(`❌ Media job queue flush failed: ${outcome.error}`);
    });

    // Stop peer sync before the pool ends: a peer:online convergence walk still
    // running would otherwise log one pool-ended stack per remaining subscription.
    // Abandoning it is safe — the next boot's peer:online pass repeats it (#11750).
    // The exit form leaves share-bucket watchers open: closing them blocks the
    // main thread for seconds on macOS, and process.exit releases them (#12853).
    timing.mark('peerSync');
    await withGrace('Peer sync', PEER_SYNC_STOP_GRACE_MS, ({ finish, finishWithError }) =>
      Promise.resolve().then(quiesceSharingForExit).then(() => drainPeerSyncOperations()).then(
        () => finish(),
        (err) => finishWithError('⚠️ Peer sync shutdown failed', err),
      ));

    await scheduledEventsDrained;
    await catalogFilingFlushed;
    await usageBackfillStopped;
    await flushPendingUsageWrites().catch(err => logBootstrapFailure('❌ Usage ledger flush failed', err));
    await settingsLedgerFlushed;
    timing.mark('dbPool');
    const { close } = await import('../../lib/db.js');
    if (typeof close === 'function') {
      // Bound the DB pool close: pool.end() waits for every checked-out client to
      // be released, so one hung/leaked connection (e.g. a LISTEN channel) would
      // otherwise stall shutdown until the force-exit timer.
      await withGrace('DB pool', 2500, ({ finish, finishWithError }) =>
        close().then(() => finish('✅ DB pool closed'), (err) => finishWithError('⚠️ DB pool close failed', err)));
    } else {
      console.warn('ℹ️ DB pool close not available; skipping DB shutdown');
    }

    timing.mark('flushWait');
    await markerWritten;
    await mediaQueueFlushed;
    await ideaLoomFlushed;
    // process.exit() would otherwise skip any pending escalation timer.
    await Promise.all([drainJevSidecarStops(), mediaService.drainCaptureStops()]);
    clearTimeout(forceExitTimer);
    reportIfSlow();
    hostProcess.exit(0);
  };
  hostProcess.on('SIGTERM', () => shutdown('SIGTERM'));
  hostProcess.on('SIGINT', () => shutdown('SIGINT'));
};
