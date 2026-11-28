/**
 * Start PortOS services, listen after the required storage and recovery steps, and expose the shutdown handler.
 *
 * bootstrapSequence.js owns the ordering and await boundaries. The phase modules
 * supply the concrete services. Boot reads local state and arms configured schedules.
 */

import { isSmokeBoot } from '../lib/runtimeEnv.js';
import { PORTS } from '../lib/ports.js';
import { getSelfHost } from '../lib/peerSelfHost.js';
import { getBuildIdentity, getCachedBuildIdentity, formatBuildIdentity } from '../lib/buildIdentity.js';
import { setupProcessErrorHandlers } from '../lib/errorHandler.js';
import { isHostShuttingDown } from '../lib/hostShutdown.js';
import { runPostRouteSequence, runPostListenSequence, gateStepsForSmokeBoot } from './bootstrapSequence.js';
import { reconcileDeadOwnerReservations } from './deadOwnerReservations.js';
import { startAutomaticUpdateReservationRecovery } from './automaticUpdateReservationRecovery.js';
import { initCertRenewer } from './certRenewer.js';
import { startBrainScheduler } from './brainScheduler.js';
import { replayPersistedResync as replayBrainMemoryResync } from './brainMemoryBridge.js';
import { recoverStuckClassifications } from './brain.js';
import { recoverInterruptedRepoClones } from './brainLinks.js';
import { recoverInFlightProjects } from './creativeDirector/recovery.js';
import { startPolling } from './instances.js';
import { ensureSelf } from './instanceIdentity.js';
import { initSyncLog } from './brainSyncLog.js';
import { backfillOriginInstanceId } from './brainStorage.js';
import { relayUnloggedRecords } from './brainReconcile.js';
import { initMediaJobQueue, resumeMediaJobCompletions } from './mediaJobQueue/index.js';
import { createMediaJobHookLoader } from './mediaJobQueue/hookRegistry.js';
import { initSharing } from './sharing/index.js';
import { logFailureWithStack as logBootstrapFailure } from '../lib/failureLogging.js';
import { initImageOriginStamping } from './imageGen/imageRecords.js';
import { runDatabaseBootPhase } from './bootstrap/storagePhase.js';
import { initMediaJobDependentHooks, startBackgroundServices } from './bootstrap/servicesPhase.js';

export { bootstrapServices } from './bootstrap/servicesPhase.js';
export { registerShutdownHandlers } from './bootstrap/shutdown.js';

/** Log the canonical "where do I open this" banner and wire the HTTPS extras. */
const announceListening = ({ io, httpServer, localHttpServer, httpsEnabled, port }) => {
  // One canonical "where do I open this" banner — :5555 is always user-facing
  // (HTTP or HTTPS), :PORTOS_HTTP_PORT (default 5553) is the loopback HTTP
  // mirror that only spawns when HTTPS is active. See docs/PORTS.md.
  // A smoke boot requests port 0 (#12543), so log the port actually bound.
  const boundPort = httpServer.address()?.port ?? port;
  console.log(`🚀 PortOS listening on :${boundPort} (${httpsEnabled ? 'https' : 'http'})`);
  // Which code is up. One PM2-managed portos-server serves :5555 for the whole
  // machine while any number of worktrees hold different code, so `pm2 logs
  // portos-server` should answer "which commit is this?" without a request
  // (#4694). Logged here rather than fire-and-forget at module scope so it
  // lands at a DETERMINISTIC position in the banner instead of racing it.
  // Read synchronously from the cache primed at boot: this function's caller
  // does not await it, so an await here would let the lines below print around
  // the yield and scramble the banner. In the normal case boot (migrations, DB)
  // far outlasts one git call, so the value is ready and lands in place.
  //
  // If it is NOT ready — a git wedged on a locked index or a slow network mount
  // — defer rather than printing `unknown`, which would be a permanent lie: the
  // probe resolves moments later and every other consumer reports it correctly.
  // Losing banner adjacency beats logging a wrong answer that never updates.
  const identity = getCachedBuildIdentity();
  if (identity) {
    console.log(`   🧬 build ${formatBuildIdentity(identity)}`);
  } else {
    getBuildIdentity()
      .then((late) => {
        // Only print once there is something true to print. A failed probe
        // resolves to an all-null tuple, and formatting THAT would claim "no git
        // metadata" — the wrong reason, permanently, about a checkout that is
        // fine. Say the probe did not finish instead; the API and the UI report
        // the real value as soon as a retry succeeds.
        if (late?.shortCommit) console.log(`   🧬 build ${formatBuildIdentity(late)}`);
        else console.log(`   🧬 build — git probe did not finish in time; /api/system/build will report it`);
      })
      .catch((err) => logBootstrapFailure('❌ Build identity probe failed', err));
  }
  if (!httpsEnabled) {
    console.log(`   🌐 http://localhost:${boundPort}`);
    console.log(`⚠️  HTTP only — getUserMedia (mic) won't work over Tailscale IP. Run "npm run setup:cert" to enable HTTPS.`);
    return;
  }
  // Only the boot smoke may ask for a kernel-assigned mirror (#12543); elsewhere
  // 0, empty or invalid keeps meaning the shipped default.
  const localHttpPort = isSmokeBoot() && process.env.PORTOS_HTTP_PORT === '0'
    ? 0
    : Number(process.env.PORTOS_HTTP_PORT) || PORTS.API_LOCAL;
  // Lead with the URL that works from THIS machine with no cert warnings:
  // the loopback HTTP mirror. http://localhost:${port} does NOT work in
  // HTTPS mode (the :${port} socket speaks TLS only), so local users who
  // type it land on a dead port — point them here instead.
  console.log(`   👉 http://localhost:${localHttpPort} (open locally — no cert warnings)`);
  // Only advertise the Tailscale hostname when it's actually usable. A cert
  // provisioned while MagicDNS was down can carry a bogus host like
  // "undefined.<tailnet>.ts.net"; printing it as "trusted" just misleads.
  const selfHost = getSelfHost();
  if (selfHost && !/^(undefined|null)\b/i.test(selfHost)) {
    console.log(`   ✅ https://${selfHost}:${port} (remote via Tailscale, trusted)`);
  }
  console.log(`   🔐 https://<tailscale-ip>:${port} (remote via Tailscale; cert warning unless using the hostname above)`);
  initCertRenewer(httpServer);
  if (localHttpServer) {
    io.attach(localHttpServer);
    localHttpServer.listen(localHttpPort, '127.0.0.1');
    localHttpServer.on('error', (err) => {
      console.warn(`⚠️  Loopback HTTP mirror on :${localHttpPort} failed: ${err.message} — http://localhost:${localHttpPort} won't work; use https://...:${port}`, err.stack || '');
    });
  }
};

/**
 * Post-route boot. Kicks off the background services, then walks the ordered
 * boot chain that ends in `httpServer.listen()` — the walk itself is
 * `runPostRouteSequence` in bootstrapSequence.js, which owns which of these
 * steps are awaited and which are fire-and-forget. Returns the chain's promise
 * so a caller can await it; index.js intentionally does not (boot proceeds in
 * the background and any fatal step exits the process itself).
 */
export const runBootSequence = ({ io, httpServer, localHttpServer, httpsEnabled, port, host, spawnerReady }, {
  onFatal,
  backgroundDependencies
} = {}) =>
  runPostRouteSequence(gateStepsForSmokeBoot({
    isStopping: isHostShuttingDown,
    onFatal,
    startBackgroundServices: () => startBackgroundServices({ spawnerReady, io, httpsEnabled, port }, backgroundDependencies),

    // Instance identity + sync log come up before requests are accepted, so a
    // brain mutation can't arrive before the sync log is ready.
    ensureSelf,
    initSyncLog,

    // Recover inbox classifications and repository clones interrupted by a
    // previous crash. Must run AFTER initSyncLog() because both recovery paths
    // append to the brain sync log — running them before currentSeq is loaded
    // would mint colliding seqs and corrupt peer cursors.
    recoverStuckClassifications,
    recoverInterruptedRepoClones,

    // Awaited by the sequence so data/ exists and the worker loop is running
    // before /api/video-gen or /api/image-gen can enqueue (otherwise persist()
    // can race with ensureDir). A failure here is fatal: the queue owns
    // persistence + SSE + temp-file cleanup, and accepting requests with a
    // half-init queue silently corrupts state.
    initMediaJobQueue: options => initMediaJobQueue({ ...options, prepareTerminalHooks: createMediaJobHookLoader() }),
    // LoRA run records reconcile against the live queue (interrupted runs →
    // failed) and mirror queue-side cancels. Own step so the smoke boot can
    // no-op it: the reconcile needs a database the hermetic root does not have.
    initMediaJobDependentHooks,
    // Needs the reloaded queue (live frame jobs keep their panel state) and the
    // database; state repair only, never a provider or image call.
    recoverStoryboardRuns: () => import('./storyboards/make.js')
      .then(({ recoverInterruptedStoryboardNodes }) => recoverInterruptedStoryboardNodes()),
    resumeMediaJobCompletions: () => {
      resumeMediaJobCompletions();
      startAutomaticUpdateReservationRecovery();
    },

    // Sharing: attach directory watchers to every registered share bucket so
    // incoming manifests from peers are picked up live. Backlog processing
    // (manifests that arrived while the server was offline) runs as part of
    // initSharing.
    initSharing: () => initSharing({ io }),

    // Resume any Creative Director projects that were mid-flight when the server
    // died. The queue reload above just reclassified their renders as 'failed
    // (interrupted by restart)'; this nudges the orchestrator so projects don't
    // sit frozen waiting for listeners that no longer exist.
    recoverCreativeDirectorProjects: () => recoverInFlightProjects().catch((e) => {
      logBootstrapFailure('⚠️ CD boot recovery failed', e, console.log);
    }),

    runDatabasePhase: async () => {
      await runDatabaseBootPhase();
      // Brain→memory resyncs a previous process queued but never finished. Runs
      // after initSyncLog and the DB phase (the memory index needs both), in the
      // background so a large backlog can't delay accepting requests.
      replayBrainMemoryResync().catch((err) => logBootstrapFailure('❌ Brain memory resync replay failed', err));
      const { bindPeerExecutionIo, initializePeerExecution } = await import('./peerExecutionRuntime.js');
      bindPeerExecutionIo(io);
      await initializePeerExecution().catch(err => console.error(`❌ Peer execution recovery remains held: ${err.message}`));
    },

    // One-time series cover-thumbnail backfill: derive `series.coverImage` (the
    // rendered volume/issue cover shown on the pipeline list) for series whose
    // covers rendered before the feature shipped. Runs after the series + issues
    // stores are warmed above so the derivation reads migrated records. Drives
    // the services, so it works on both the PG backend and the file escape hatch.
    // Marker-gated, so it runs at most once regardless. Loading it is a
    // separate step from running it: the sequence awaits the load (a script
    // that won't load is a real breakage) but never the backfill itself.
    loadSeriesCoverBackfill: async () => (await import('../scripts/backfillSeriesCoverImages.js')).backfillSeriesCoverImages,

    startListening: () => httpServer.listen(port, host, () => runPostListenSequence(gateStepsForSmokeBoot({
      isStopping: isHostShuttingDown,
      announceListening: () => announceListening({ io, httpServer, localHttpServer, httpsEnabled, port }),
      // Process-level safety net, wired with the io instance so unhandled
      // failures also surface in the UI.
      setupProcessErrorHandlers: () => setupProcessErrorHandlers(io),
      reconcileMediaAssetIndex: async () => (await import('./mediaAssetIndex/index.js')).reconcileMediaAssetIndexAtBoot(),
      // The dead-owner sweep in startBackgroundServices ran before this, so a
      // cli-run reservation whose record recovery just closed is released by a
      // second sweep; it releases only what the closed record now proves.
      recoverInterruptedRuns: async () => {
        const { recoverInterruptedRuns } = await import('./interruptedRunRecovery.js');
        const { recovered } = await recoverInterruptedRuns();
        if (recovered > 0) reconcileDeadOwnerReservations();
      },
      backfillOriginInstanceId,
      // Relay any brain record whose current state never reached the sync log
      // (a crash or failed append on a previous run) — #8351.
      relayUnloggedBrainRecords: relayUnloggedRecords,
      startPolling: () => {
        startPolling();
        // Best-effort: re-attach tailcat forwards persisted across restarts.
        void import('./tailcatPeer.js')
          .then(({ restoreForwards }) => restoreForwards())
          .catch((err) => logBootstrapFailure('⚠️ tailcat forward restore failed', err, console.warn));
        void import('./tailcatServe.js')
          .then(({ restoreServe }) => restoreServe())
          .catch((err) => logBootstrapFailure('⚠️ tailcat serve restore failed', err, console.warn));
      },
      initSyncOrchestrator: () => {
        void import('./syncOrchestrator.js')
          .then(({ initSyncOrchestrator }) => initSyncOrchestrator())
          .catch((err) => logBootstrapFailure('❌ Sync orchestrator init failed', err));
        // Queued remote media deletes drain when their owner comes online.
        void import('./mediaRemoteDelete.js')
          .then(({ initMediaRemoteDelete }) => initMediaRemoteDelete())
          .catch((err) => logBootstrapFailure('❌ Media delete queue init failed', err));
        // Queued Make-primary releases drain when their holder comes online.
        void import('./mediaHolders.js')
          .then(({ initMediaHolders }) => initMediaHolders())
          .catch((err) => logBootstrapFailure('❌ Media release queue init failed', err));
        // Gallery renders record this machine as their origin, which remote delete targets.
        void Promise.resolve().then(() => initImageOriginStamping())
          .catch((err) => logBootstrapFailure('❌ Image origin stamping init failed', err));
      },
      // Brain digests/reviews call an AI provider, so the scheduler arms only
      // once the server is listening and only acts when the user opted in
      // (`scheduledReviewsEnabled`).
      startBrainScheduler
    }, 'postListen', isSmokeBoot())))
  }, 'postRoute', isSmokeBoot()));
