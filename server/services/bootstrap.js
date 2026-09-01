/**
 * Server boot orchestration.
 *
 * `server/index.js` owns HTTP/Socket.IO construction and route registration;
 * everything about *starting the install up* lives here:
 *
 *   1. `bootstrapServices()` — pre-route boot: data migrations, collection
 *      schema verification, AI Toolkit construction + runner registration, and
 *      the background workers that must exist before any route handler runs.
 *   2. `runBootSequence()` — post-route boot: fire-and-forget service inits +
 *      schedulers, then the ordered instance/sync/media-queue/DB chain that
 *      ends in `httpServer.listen()`.
 *   3. `registerShutdownHandlers()` — the graceful-shutdown state machine.
 *
 * Ordering inside each phase is load-bearing. It lives in `bootstrapSequence.js`
 * — a dependency-injected, service-free module — so it can be executed and
 * asserted under test (#3451) without opening a listener or touching a real
 * database. This file supplies the real implementations; that file decides when
 * each one runs and which are awaited. Read both before reordering anything.
 *
 * NOTE (AGENTS.md "No cold-bootstrap LLM calls"): nothing in this file may
 * queue an AI provider call. Boot only loads on-disk state and ARMS schedulers;
 * every scheduler here is off by default or user-configured.
 */
import { join } from 'path';
import { resolveInstallRoot } from '../lib/dataRoot.js';
import { PORTS } from '../lib/ports.js';
import { getSelfHost } from '../lib/peerSelfHost.js';
import { getBuildIdentity, getCachedBuildIdentity, formatBuildIdentity } from '../lib/buildIdentity.js';
import { setupProcessErrorHandlers, asyncHandler, ServerError, errorEvents } from '../lib/errorHandler.js';
import { ERROR_CATEGORIES } from '../lib/aiToolkit/errorDetection.js';
import { createAIToolkit } from '../lib/aiToolkit/index.js';
import { verifyCollectionVersions } from '../lib/collectionStore.js';
import { startIdleReaper, stopIdleReaper } from '../lib/managedDaemon.js';
import { conflictJournalStore } from '../lib/conflictJournal.js';
import { markHostShuttingDown, writeHostShutdownMarker } from '../lib/hostShutdown.js';
import { setUserCatalogTypes } from '../lib/catalogTypes.js';
import { runMigrations } from '../../scripts/run-migrations.js';

import {
  runPreRouteSequence,
  runPostRouteSequence,
  runPostListenSequence,
  runDatabasePhase,
  gateOnDatabase,
  runDbAndCatalogMigrations,
  warmMandatoryStores,
  initCosAfterSpawner,
  armCommissionScheduler
} from './bootstrapSequence.js';

import { ensureBackendProvider, getBackend as getLocalLlmBackend } from './localLlm.js';
import { ensureRunning as ensureOllamaRunning } from './ollamaManager.js';
import { ensureProviderReadyForExecution } from './providerExecutionReadiness.js';
import { loadUsage, recordSession } from './usage.js';
import { recordCompletedRunUsage } from './usageReconciler.js';
import { setAIToolkit as setProvidersToolkit } from './providers.js';
import { setAIToolkit as setProviderStatusToolkit } from './providerStatus.js';
import { setAIToolkit as setRunnerToolkit, executeCliRun as executeCliRunFixed } from './runner.js';
import { setAIToolkit as setPromptsToolkit } from './promptService.js';
import { executeTuiRun as executeTuiRunFixed } from './tuiPromptRunner.js';
import { initAutoFixer } from './autoFixer.js';
import { initTaskLearning } from './taskLearning.js';
import { initSpawner } from './subAgentSpawner.js';
import { initCertRenewer } from './certRenewer.js';

import * as cos from './cos.js';
// Side-effect-free shared state module — importing it here does NOT pull in the
// agent-lifecycle orchestrator graph (that's why activeAgents lives in its own
// leaf module), so the shutdown handler can read the live agent set cheaply.
import { activeAgents } from './agentState.js';
import * as automationScheduler from './automationScheduler.js';
import * as agentActionExecutor from './agentActionExecutor.js';
import * as telegram from './telegram.js';
import * as telegramBridge from './telegramBridge.js';
import { getSettings as getInitSettings } from './settings.js';
import { readUserTypes as readUserTypeSlice } from './catalogUserTypes/store.js';
import { getVoiceConfig } from './voice/config.js';
import { reconcile as reconcileVoice } from './voice/bootstrap.js';
import { initVoiceTimers } from './voice/timers.js';
import { startBackupScheduler } from './backupScheduler.js';
import { startPrivacyRecheckScheduler } from './privacyRecheckScheduler.js';
import { startQuotaBurnScheduler } from './quotaBurnRunner.js';
import { startSeriesAutopilotScheduler } from './seriesAutopilotScheduler.js';
import { startCommissionScheduler } from './creativeCommissions/scheduler.js';
import { startImessageScheduler } from './imessageScheduler.js';
import { startSignalScheduler } from './signalScheduler.js';
import { startSpotifyScheduler } from './spotifyScheduler.js';
import { startYoutubeScheduler } from './youtubeScheduler.js';
import { reconcileStackerNewsSchedulers } from './stackerNewsScheduler.js';
import { startBrainScheduler } from './brainScheduler.js';
import { startActivityDigestScheduler } from './activityDigestScheduler.js';
import { startTwinEnrichmentScheduler } from './twinEnrichmentScheduler.js';
import { startUpdateScheduler, clearStaleUpdateInProgress, processUpdateMarker } from './updateChecker.js';
import { captureBootCommit } from './installState.js';
import { restoreLoops } from './loops.js';
import { startOrphanShellGc } from './importerOrphanGc.js';
import { startImageRefsGc } from './imageRefsGc.js';
import { startImageCleanTmpGc } from './imageCleanTmpGc.js';
import { initBridge as initBrainMemoryBridge } from './brainMemoryBridge.js';
import { initDrillCache } from './meatspacePostDrillCache.js';
import { registerPostReminderSchedule } from './meatspacePostReminder.js';
import { recoverInterruptedRepoClones, recoverStuckClassifications } from './brain.js';
import { recoverStuckAnalyses } from './writersRoom/evaluator.js';
import { recoverStuckAutoRuns } from './pipeline/autoRunner.js';
import { recoverStuckAutopilots } from './pipeline/seriesAutopilot.js';
import { recoverInFlightProjects } from './creativeDirector/recovery.js';
import { recoverInterruptedModels as recoverInterruptedThreejsModels } from './threejsModels/index.js';
import { recoverInterruptedModels as recoverInterruptedImageTo3dModels } from './imageTo3d/models.js';
import { ensureSelf, startPolling } from './instances.js';
import { initSyncLog } from './brainSyncLog.js';
import { backfillOriginInstanceId, brainCollectionStores } from './brainStorage.js';
import { initSyncOrchestrator } from './syncOrchestrator.js';
import { initMediaJobQueue } from './mediaJobQueue/index.js';
import { initSpriteLocalAnimationHook } from './sprites/localAnimationJobHook.js';
import { initLoraTraining } from './loraTraining/index.js';
import { initSharing } from './sharing/index.js';
import { initMortalLoomStore } from './mortalLoomStore.js';
import { initUniverseBuilderCollectionHook } from './universeBuilderCollectionHook.js';
import { initCatalogImageAttachHook } from './catalogImageAttachHook.js';
import { initWritersRoomSceneImageHook } from './writersRoomSceneImageHook.js';
import { initFableLoomSceneImageHook } from './fableLoomSceneImageHook.js';
import { initFableLoomSceneVideoHook } from './fableLoomSceneVideoHook.js';
import { initMusicVideoSceneImageHook } from './musicVideoSceneImageHook.js';
import { initMusicVideoSceneVideoHook } from './musicVideoSceneVideoHook.js';
import { initCreativeDirectorMusicBedHook } from './creativeDirectorMusicBedHook.js';
import { initMusicStudioHook } from './musicStudioHook.js';
import { initImageGenQuotaHook } from './imageGenQuota.js';
import { initSpriteReferenceImageHook } from './spriteReferenceImageHook.js';
import { initCreativeDirectorSceneImageHook } from './creativeDirectorSceneImageHook.js';
import { initCreativeDirectorRenderFailureHook } from './creativeDirector/renderFailureHook.js';
import { initComicPagesFilenameHook } from './pipeline/comicPagesFilenameHook.js';
import { initStoryboardsFilenameHook } from './pipeline/storyboardsFilenameHook.js';
import { initSeasonCoverFilenameHook } from './pipeline/seasonCoverFilenameHook.js';
import { universeStore } from './universeBuilder.js';
import { seriesStore } from './pipeline/series.js';
import { issueStore } from './pipeline/issues.js';
import { storyBuilderStore } from './storyBuilder.js';
import { writersRoomStore } from './writersRoom/store.js';
import { mediaCollectionStore } from './mediaCollections.js';
import { loraDatasetStore } from './loraDatasets.js';
import { rapidReaderLibraryStore } from './rapidReaderLibrary.js';
import { commissionStore, backfillAllCommissionFeedback } from './creativeCommissions/store.js';
import { backfillProjectCommissionIds } from './creativeCommissions/projectControl.js';
import { outcomesStore as liOutcomesStore } from './layeredIntelligenceOutcomes.js';
import * as gameStore from './games/store.js';
import * as fableLoomStore from './fableLoom/store.js';
import { prerequisitesMetForRouting } from './providerPrerequisites.js';
import { stopCodexAppServer } from './codexAppServer.js';

/**
 * Pre-route boot. Everything a route handler may depend on being ready the
 * moment the first request lands: applied data migrations, a constructed AI
 * Toolkit (routes are built from it), and the spawner/autofixer/task-learning
 * background workers.
 *
 * Returns `{ aiToolkit, spawnerReady }` — `aiToolkit` feeds the toolkit-backed
 * route factories in index.js, `spawnerReady` gates CoS init in
 * `runBootSequence` below.
 */
export const bootstrapServices = async ({ io, dataDir, dataReferenceDir, serverDir }) => {
  // Lifecycle hooks shared between AI Toolkit and PortOS runner shim
  const aiToolkitHooks = {
    ensureProviderReady: (provider) => ensureProviderReadyForExecution(provider),
    onRunCreated: (metadata) => {
      recordSession(metadata.providerId, metadata.providerName, metadata.model).catch(err => {
        console.error(`❌ Failed to record usage session: ${err.message}`);
      });
    },
    onRunCompleted: (metadata, output) => {
      // Reads the provider CLI's own transcript for real token counts (including
      // the prompt-cache tiers that dominate cost), falling back to the
      // prompt-length/stdout estimate when none is found. Owns its own error
      // handling — a usage-accounting failure must not fail the run.
      recordCompletedRunUsage(metadata, output);
    },
    onRunFailed: (metadata, error) => {
      const errorMessage = error?.message ?? String(error);
      // A content/safety refusal is a known, self-explanatory outcome — not a
      // provider fault. Emit a distinct code + warning severity so (a) the
      // autofixer skips it (it only spawns investigation tasks for
      // AI_PROVIDER_EXECUTION_FAILED) and (b) the client shows a calm "model
      // declined, trying a fallback" notice instead of a red error toast. The
      // fallback retry itself is driven by promptRunner.js.
      const isRefusal = metadata.errorAnalysis?.category === ERROR_CATEGORIES.CONTENT_REFUSAL;
      errorEvents.emit('error', {
        code: isRefusal ? 'AI_PROVIDER_CONTENT_REFUSED' : 'AI_PROVIDER_EXECUTION_FAILED',
        message: isRefusal
          ? `${metadata.providerName} declined this prompt on content/safety grounds — trying a fallback model if one is configured.`
          : `AI provider ${metadata.providerName} execution failed: ${errorMessage}`,
        severity: isRefusal ? 'warning' : 'error',
        canAutoFix: !isRefusal,
        timestamp: Date.now(),
        context: {
          runId: metadata.id,
          provider: metadata.providerName,
          providerId: metadata.providerId,
          model: metadata.model,
          exitCode: metadata.exitCode,
          duration: metadata.duration,
          workspacePath: metadata.workspacePath,
          workspaceName: metadata.workspaceName,
          errorDetails: errorMessage,
          errorAnalysis: metadata.errorAnalysis,
          // Note: promptPreview and outputTail intentionally omitted to avoid leaking sensitive data
        }
      });
    }
  };

  // The ORDER these run in is `runPreRouteSequence`'s contract (see
  // bootstrapSequence.js); this object is only the "what".
  return runPreRouteSequence({
    // Apply pending data migrations BEFORE the AI toolkit reads stage-config.json
    // and providers.json. Without this, a plain pull-and-restart (no update.sh)
    // leaves new prompt stages and other shipped data changes unregistered —
    // existing installs hit "Stage X not found" until the user manually runs
    // `npm run migrations` or `npm run update`. Idempotent and cheap when the
    // applied-list is already current.
    // Prefer PORTOS_DATA_ROOT (set at real launch in ecosystem.config.cjs) over the
    // import.meta.url-derived path so a server booted from inside a CoS agent
    // worktree still resolves to the real install; runMigrations also skips a
    // worktree-rooted path as a backstop (#1947).
    applyDataMigrations: () => runMigrations({ rootDir: resolveInstallRoot(join(serverDir, '..')) }),

    // usage.js and migration 304 both update usage.json. Initialize the service
    // only after migrations finish so their whole-file writes cannot race and
    // replace a freshly normalized or rolled-up snapshot with stale bytes.
    loadUsage,

    // Verify every registered collection's on-disk type-level schemaVersion
    // matches what the code expects. Mismatches mean a migration didn't run (or
    // the user rolled the code back below a forward-only migration) — log loudly
    // but DO NOT crash the server. PortOS is single-user (AGENTS.md "Security
    // Model"); a hard exit on startup is worse than a noisy log the user can act
    // on. Returns per-store statuses for downstream telemetry; we discard them.
    verifyCollections: () => verifyCollectionVersions([universeStore(), seriesStore(), issueStore(), conflictJournalStore(), storyBuilderStore(), mediaCollectionStore(), loraDatasetStore, rapidReaderLibraryStore, liOutcomesStore(), commissionStore(), gameStore, fableLoomStore, ...brainCollectionStores()]),

    createToolkit: () => createAIToolkit({
      dataDir,
      providersFile: 'providers.json',
      runsDir: 'runs',
      promptsDir: 'prompts',
      screenshotsDir: join(dataDir, 'screenshots'),
      sampleProvidersFile: join(dataReferenceDir, 'providers.json'),
      io,
      asyncHandler,
      // Inject PortOS's ServerError so toolkit route errors normalize into the
      // canonical `{ error, code, timestamp, context? }` envelope (issue #1084).
      ServerError,
      hooks: aiToolkitHooks,
      // Keep the fallback chain off providers whose CLI is not installed on
      // this host (#4611), so a run falls through to the next candidate instead
      // of dying at spawn time. Sync by contract: it reads the runtime probe's
      // cache and never blocks.
      prerequisitesMet: prerequisitesMetForRouting
    }),

    // Compatibility shims for services that import from the old service files.
    registerToolkitShims: (aiToolkit) => {
      setProvidersToolkit(aiToolkit);
      setProviderStatusToolkit(aiToolkit);
      setRunnerToolkit(aiToolkit, { dataDir, hooks: aiToolkitHooks });
      setPromptsToolkit(aiToolkit);
      // Note: the prompts service is initialized automatically by createAIToolkit().
    },

    // Warm the providers file at startup so the codex-sentinel migration runs
    // before any inbound request can hit the providers cache. A pure READ of
    // on-disk provider config — it dispatches nothing to a provider.
    warmProviders: (aiToolkit) => aiToolkit.services.providers.getAllProviders(),

    // Ensure the provider paired with the active local-LLM backend (LLM_BACKEND in
    // .env, chosen at setup time) is enabled, so a fresh install can use Ollama /
    // LM Studio for runs without hand-toggling it in the Providers UI. Starting
    // the Ollama server is not a provider CALL — nothing is inferred until the
    // user asks for it.
    ensureLocalLlmBackend: () => {
      const activeLocalLlmBackend = getLocalLlmBackend();
      ensureBackendProvider(activeLocalLlmBackend).catch((err) =>
        console.error(`⚠️ Failed to enable local LLM backend provider: ${err.message}`));
      if (activeLocalLlmBackend === 'ollama') {
        ensureOllamaRunning({ preferPersistent: true }).catch((err) =>
          console.error(`⚠️ Failed to start Ollama for active local LLM backend: ${err.message}`));
      }
    },

    // Register PortOS's CLI + TUI runners through the toolkit's declared extension
    // points (setCliRunner / setTuiRunner) instead of overwriting private props.
    // The CLI variant adds per-provider argv building (Codex `exec -`, Antigravity
    // `agy --print`, Claude Code `-p -`); the toolkit's in-tree implementation is
    // also safe (no shell, prompt via stdin) — the variant exists for the per-CLI
    // invocation conventions, not for security. The TUI runner has no toolkit
    // built-in: registering it lets POST /api/runs with a TUI provider dispatch
    // here instead of 400ing. Both runners track their child process / pty via the
    // toolkit's external-run registry, so the toolkit's own stopRun/isRunActive/
    // deleteRun account for live runs without any sibling-method monkey-patching.
    registerRunners: (aiToolkit) => {
      aiToolkit.services.runner.setCliRunner(executeCliRunFixed);
      aiToolkit.services.runner.setTuiRunner(executeTuiRunFixed);
    },

    // Auto-fixer for error recovery.
    initAutoFixer,
    // Task learning system, tracking agent completions.
    initTaskLearning,
    // The CoS agent spawner (event wiring + orphan cleanup), initialized
    // explicitly now that the runner registration + task learning are ready.
    startSpawner: initSpawner
  });
};

/**
 * Fire-and-forget service inits + scheduler arming. None of these block the
 * server from listening; each logs its own failure and the boot continues.
 */
const startBackgroundServices = ({ spawnerReady }) => {
  // Explicit call (not a module-level side effect) so test imports of cos.js
  // don't spin up its event listeners and timers. The spawner gate itself lives
  // in bootstrapSequence.js.
  initCosAfterSpawner({ spawnerReady, initCos: () => cos.init() });

  // World Design migrations are offline and leave a pending checkpoint. If the
  // separately-managed Eidoverse process is already online, reconcile it now;
  // otherwise leave the checkpoint for direct remediation in the Eidoverse UI.
  // This is deterministic local projection only — never an AI provider call.
  import('./eidoverseWorld.js')
    .then(({ reconcilePendingEidoverseWorld }) => reconcilePendingEidoverseWorld())
    .then((result) => {
      if (result.reconciled) console.log('🌐 Reconciled pending Eidoverse World Design update');
    })
    .catch(err => console.error(`⚠️ Eidoverse World Design reconciliation deferred: ${err.message}`));

  // Initialize agent automation scheduler and action executor
  automationScheduler.init().catch(err => console.error(`❌ Agent scheduler init failed: ${err.message}`));
  // agentActionExecutor.init() is synchronous — guard with try/catch so a thrown
  // error logs cleanly instead of crashing the server at module load.
  try {
    agentActionExecutor.init();
  } catch (err) {
    console.error(`❌ agentActionExecutor init failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Inbox recovery is deferred until after initSyncLog() (see the ensureSelf chain
  // in runBootSequence) — it mutates inbox entries, which are now synced brain
  // records, so its updateInboxLog() calls append to sync_log.jsonl and MUST run
  // after the log's currentSeq is loaded, or they'd write low/duplicate sequence
  // numbers and corrupt peer cursors.
  recoverStuckAnalyses().catch(err => console.error(`❌ Writers Room recovery failed: ${err.message}`));
  recoverStuckAutoRuns().catch(err => console.error(`❌ Pipeline auto-run recovery failed: ${err.message}`));
  recoverStuckAutopilots().catch(err => console.error(`❌ Pipeline autopilot recovery failed: ${err.message}`));
  // A provider child cannot survive a server restart. Make interrupted
  // Three.js generations retryable; this is state recovery only, never a
  // cold-bootstrap provider call.
  recoverInterruptedThreejsModels().catch(err => console.error(`❌ Three.js model recovery failed: ${err.message}`));
  recoverInterruptedImageTo3dModels().catch(err => console.error(`❌ Image-to-3D model recovery failed: ${err.message}`));
  // Arm the managed-model-server idle reaper. Timer only — it reads timestamps
  // and may stop a PM2 process, and makes no AI provider call, so it is safe
  // under AGENTS.md's "No cold-bootstrap LLM calls". Off in practice until the
  // user sets an idle window (0 = never, the default).
  startIdleReaper();
  // Initialize brain scheduler for daily digests and weekly reviews
  startBrainScheduler();
  // Initialize activity-digest scheduler — OFF by default; drafts daily-log
  // auto-summaries from the Human Activity timeline only when the user enables it
  // (Settings → Daily Log → Activity Digest). Silent + no LLM calls until then.
  startActivityDigestScheduler();
  // Initialize twin-enrichment scheduler — LLM-free daily rollup of observed
  // taste + chronotype evidence from the Human Activity timeline (#2156). No
  // provider calls; the AI interpretation is a separate explicit-button action.
  startTwinEnrichmentScheduler();
  // Initialize brain→memory bridge (mirrors brain data into CoS memory for semantic search)
  initBrainMemoryBridge();
  // Load any on-disk POST drill cache into memory. Does NOT trigger LLM calls —
  // cache fill only happens on explicit user request (see meatspacePostRoutes.js).
  initDrillCache().catch(err => console.error(`❌ POST drill cache init failed: ${err.message}`));
  // Register the optional daily POST reminder (opt-in, off by default) if the
  // user has enabled it — deterministic cron nudge, no LLM calls.
  // catchUpMissedSlot: true so a reminder whose slot elapsed while the server
  // was down (or during a redeploy) still fires once we're back up, instead of
  // silently waiting for tomorrow's tick (#2015).
  registerPostReminderSchedule({ catchUpMissedSlot: true }).catch(err => console.error(`❌ POST reminder init failed: ${err.message}`));
  // Initialize backup scheduler for daily data backups
  startBackupScheduler().catch(err => console.error(`❌ Backup scheduler init failed: ${err.message}`));
  // Initialize Privacy Center opt-out recheck scheduler — OFF by default; only
  // re-runs the broker scan + opt-out pass when the user opts in via
  // Settings → Privacy (sanctioned scheduled-automation exception) (#2145).
  startPrivacyRecheckScheduler().catch(err => console.error(`❌ Privacy recheck scheduler init failed: ${err.message}`));
  // Quota-burn loop — ONE install-level loop that spends subscription quota that
  // would otherwise expire. OFF by default: the tick returns before touching a
  // provider unless the user enabled it on the Quota Burn page, where the
  // family, provider, model, and work are all named first (sanctioned
  // scheduled-automation exception).
  startQuotaBurnScheduler();
  // Initialize Series Autopilot scheduler — OFF by default; registers a cron per
  // series only when the user configured + enabled one via Settings → Series
  // Autopilot. Each scheduled run still passes through the cos autonomy gate +
  // daily budget (sanctioned scheduled-automation exception) (#2174).
  startSeriesAutopilotScheduler().catch(err => console.error(`❌ Series Autopilot scheduler init failed: ${err.message}`));
  // Autonomous Creation Engine (#2657) — arm a cron per enabled Creative
  // Commission. Boot only ARMS timers; nothing fires until a cadence elapses, and
  // each fire gates on creative autonomy `execute` + the daily cos budget (so an
  // `off`/`dry-run` install generates nothing). Sanctioned scheduled-automation.
  // The backfill is pure data movement (no LLM), idempotent, best-effort. The
  // scripts/migrations runner executes before the DB pool is up, so the data move
  // lives here (see the migration 194 registration stub); the table itself is
  // created by ensureSchema. Backfill-before-arm ordering lives in
  // bootstrapSequence.js.
  armCommissionScheduler({
    backfillCommissionFeedback: backfillAllCommissionFeedback,
    backfillProjectCommissionIds,
    startCommissionScheduler
  });
  // OpenWorld's historical snapshot scheduler is retired with its UI. The
  // legacy read/capture routes remain available for old clients, but Eidoverse
  // is now the only automatic world projection path.
  // Initialize iMessage sync scheduler — OFF by default; only polls chat.db when
  // the user opts in from the iMessage Settings drawer on Comms → Messages → iMessage
  // (needs macOS Full Disk Access) (#2151).
  startImessageScheduler().catch(err => console.error(`❌ iMessage sync scheduler init failed: ${err.message}`));
  // Initialize Signal sync scheduler — OFF by default; only reads the SQLCipher
  // chat DB (via the keychain-wrapped key) when the user opts in via
  // Settings → Signal (#2154).
  startSignalScheduler().catch(err => console.error(`❌ Signal sync scheduler init failed: ${err.message}`));
  // Initialize Spotify sync scheduler — OFF by default; only polls the
  // recently-played API when the user connects Spotify + opts in via
  // Settings → Spotify (#2152).
  startSpotifyScheduler().catch(err => console.error(`❌ Spotify sync scheduler init failed: ${err.message}`));
  // Initialize YouTube watch-history sync scheduler — OFF by default; only scrapes
  // the signed-in history page in the managed browser when the user opts in via
  // Settings → YouTube (#2153).
  startYoutubeScheduler().catch(err => console.error(`❌ YouTube sync scheduler init failed: ${err.message}`));
  // Periodically GC orphan zero-issue/zero-canon importer shells left by an
  // abandoned analyze (issue #727).
  startOrphanShellGc();
  // Periodically GC orphan staged init/reference upload images that pile up in
  // data/image-refs on every i2i/edit render and are never cleaned up (issue #1214).
  startImageRefsGc();
  // Periodically GC the Image Cleaner's GPU-clean temp working files (init/render/
  // mask/original) that land in data/image-clean-tmp and are never long-lived
  // (issue #2264). Age-gate only — nothing here is referenced after the fetch.
  startImageCleanTmpGc();
  // Warm the catalog user-type registry from the user-type store (Postgres as of
  // #1001; the settings.json slice under the escape hatch) before any catalog
  // request can land, so user-defined types validate + mint ids immediately on
  // boot. The store's PG backend self-runs ensureSchema + the one-time settings→DB
  // import, so this is safe even though it fires before the boot DB gate. No
  // settings:updated listener anymore: the registry's only writers are the
  // `/api/catalog/types` routes and the sync merge, both of which call
  // setUserCatalogTypes(next) directly — a settings save no longer touches types,
  // and a listener reading the now-absent settings key would wipe the registry.
  readUserTypeSlice()
    .then(list => setUserCatalogTypes(Array.isArray(list) ? list : []))
    .catch(err => console.error(`❌ Catalog user-type warm failed: ${err.message}`));
  // Initialize Telegram (manual bot or MCP bridge based on settings)
  getInitSettings().then(s => {
    if (s.telegram?.method === 'mcp-bridge') {
      telegramBridge.init().catch(err => console.error(`❌ TG Bridge init failed: ${err.message}`));
    } else {
      telegram.init().catch(err => console.error(`❌ Telegram init failed: ${err.message}`));
    }
  }).catch(err => console.error(`❌ Telegram settings read failed: ${err.message}`));
  // Reconcile voice stack (start portos-whisper if voice.enabled)
  getVoiceConfig().then(reconcileVoice).catch(err => console.error(`❌ Voice reconcile failed: ${err.message}`));
  // Re-arm any voice timers that survived a restart (independent of voice.enabled —
  // a pending reminder should still fire even if voice is currently off).
  initVoiceTimers().catch(err => console.error(`❌ Voice timer init failed: ${err.message}`));
  // Check for update completion marker from a previous update cycle. The full
  // read/validate/record/cleanup lifecycle lives in updateChecker.js.
  processUpdateMarker().catch(err => console.error(`❌ Update marker processing failed: ${err.message}`));

  // Clear stale updateInProgress if the server was killed mid-update
  clearStaleUpdateInProgress().catch(err => console.error(`❌ Stale update recovery failed: ${err.message}`));

  // Capture the commit this process booted at, so /api/update/status can detect
  // a bare `git pull` that advanced on-disk HEAD without restarting (issue #1779).
  // Best-effort — a tarball/non-git install just yields no boot commit.
  captureBootCommit().catch(err => console.error(`❌ Boot commit capture failed: ${err.message}`));

  // Start periodic update checker (checks GitHub releases every 30 min)
  startUpdateScheduler();

  // Restore any active loops from previous session
  restoreLoops().catch(err => console.error(`❌ Loop restore failed: ${err.message}`));
};

/**
 * Media-job-queue-dependent completion hooks. Every one of these files a
 * finished render onto its owning record even if the requesting client
 * unmounted mid-render, so they must be wired AFTER the queue has loaded its
 * persisted jobs (otherwise they'd miss `completed` events for reloaded jobs).
 */
const initMediaJobDependentHooks = () => {
  // LoRA training run records reconcile against the live queue (interrupted
  // runs → failed) and mirror queue-side cancels — must run after the queue
  // has loaded its persisted jobs.
  initLoraTraining().catch(err => console.error(`❌ loraTraining init failed: ${err.message}`));
  // Universe Builder needs the media job queue running before it can listen
  // for `completed` events — so initialize the hook here.
  initUniverseBuilderCollectionHook();
  // Sprite local-render hook (#4876) — stages a finished MiniMax H3 clip into
  // its animation run and files the outcome, for renders that outlive the
  // request that started them. Its boot pass also reconciles jobs that settled
  // while the server was down, which is the only thing that can rescue a
  // multi-hour render interrupted by a restart.
  initSpriteLocalAnimationHook();
  // Catalog image-attach hook — durably files a queued render onto its target
  // ingredient on completion, even if the editor page unmounted mid-render
  // (#1359).
  initCatalogImageAttachHook();
  // Writers-Room scene-image hook — durably files a queued storyboard render
  // onto its analysis snapshot + work collection on completion (#1363).
  initWritersRoomSceneImageHook();
  // FableLoom scene-image hook — durably files a queued scene render onto its
  // loom episode's node on completion, even if the editor unmounted mid-render.
  initFableLoomSceneImageHook();
  // FableLoom scene-video hook — durably files a queued local clip onto its
  // loom episode's node on completion, even if the editor unmounted.
  initFableLoomSceneVideoHook();
  // Music Video scene-image hook — durably files a queued reference-frame
  // render onto its project scene's `referenceImageId` on completion, even if
  // the director board unmounted mid-render (#1760 Phase 1b).
  initMusicVideoSceneImageHook();
  // Music Video scene-video hook — durably files a queued i2v scene clip onto
  // its project scene's `videoHistoryId` on completion (#1760 Phase 1).
  initMusicVideoSceneVideoHook();
  // Creative Director music-bed hook — durably files a queued first-pass
  // audio render onto its project's `musicBed` field on completion, even if
  // the requesting client unmounted mid-render (#1928).
  initCreativeDirectorMusicBedHook();
  // Music Studio audio jobs attach to their track after completion so the
  // library remains correct across a client remount or navigation.
  initMusicStudioHook();
  // Image-gen quota observation — the cloud image backends expose no quota API,
  // so the Usage page's Image Gen card is built from renders we watched succeed
  // or get refused. One bus subscriber, never per-provider edits.
  initImageGenQuotaHook();
  // Sprite reference-candidate hook — copies a completed reference/anchor
  // render into the sprite record's reference/candidates/ with a generation
  // sidecar (#2896).
  initSpriteReferenceImageHook();
  // Creative Director scene-frame hook — durably files a queued first-pass
  // reference-frame render onto its project scene's `sourceImageFile` on
  // completion, even if no client is watching (#1867).
  initCreativeDirectorSceneImageHook();
  // Creative Director render failures are actionable code defects; queue one
  // deduplicated internal repair task for every tagged CD media lane.
  initCreativeDirectorRenderFailureHook();
  // Pipeline filename hooks — stamp `filename` onto stage records on
  // media-job completion so the UI can still render them after the
  // 24h media-job archive TTL elapses.
  initComicPagesFilenameHook();
  initStoryboardsFilenameHook();
  initSeasonCoverFilenameHook();
  // Best-effort pre-materialize the MortalLoom iCloud store so the
  // dashboard's proactive-alerts poll (and other readers) don't trigger
  // on-demand downloads that surface as EAGAIN. `brctl download` only
  // materializes the file — it does not pin against future eviction, so
  // the retry-on-EAGAIN path inside the store is what guarantees the
  // hardening. Fire-and-forget — failures are logged.
  initMortalLoomStore().catch((err) => {
    console.warn(`⚠️ MortalLoom store init failed: ${err.message}`);
  });
};

/**
 * The database phase's dependencies. `runDatabasePhase` (bootstrapSequence.js)
 * owns the gate → migrate → warm → arm ordering; this supplies the real db.js,
 * the real migration scripts, and the real stores.
 *
 * Escape hatches for the health gate (dev/tests only, UNSUPPORTED for
 * production): `MEMORY_BACKEND=file` (explicit file backend) and `NODE_ENV=test`
 * (test suites boot without a database). Both downgrade "PostgreSQL is required"
 * from a fail-fast to a warning.
 *
 * Every migration/warm step is imported lazily, at the moment it runs, exactly
 * as before the extraction — nothing in this phase is pulled into the module
 * graph on a boot that never reaches it.
 */
const runDatabaseBootPhase = () => runDatabasePhase({
  gate: async () => {
    const { checkHealth, ensureSchema } = await import('../lib/db.js');
    const { dbReady } = await gateOnDatabase({
      checkHealth,
      ensureSchema,
      escapeHatch: process.env.MEMORY_BACKEND === 'file' || process.env.NODE_ENV === 'test'
    });
    // ensureSchema is threaded through to the migrations below so the phase
    // resolves the db.js module exactly once.
    return { dbReady, ensureSchema };
  },

  migrate: ({ dbReady, ensureSchema }) => runDbAndCatalogMigrations({
    dbReady,
    ensureSchema,
    // Versioned DB-migration runner (#1029): ordered schema-DELTA migrations
    // (renames / type changes / data transforms / embedding-dim changes) that
    // ensureSchema()'s additive IF NOT EXISTS gates can't express. Loading the
    // runner is a separate step from running it because only the latter is
    // fatal — a module that won't load falls to the group's log-and-continue.
    loadDbMigrationRunner: async () => (await import('../scripts/run-db-migrations.js')).runDbMigrations,
    migrateBibleToCatalog: async () => (await import('../scripts/migrateBibleToCatalog.js')).migrateBibleToCatalog(),
    // One-time data repair: rewrite legacy machine universe tags
    // (`from-universe`, `universe:<id>`) on backfilled rows into the friendly
    // universe NAME tag. Marker-gated in data/catalog-universe-tags.applied.json.
    repairUniverseTags: async () => (await import('../scripts/repairUniverseTags.js')).repairUniverseTags(),
    // Per-record catalog payload-shape migration — walks rows whose stored
    // payload.schemaVersion lags the registry-current and applies registered
    // upgraders. No-ops via marker once an install is at the high-water version.
    migrateCatalogPayload: async () => (await import('../scripts/migrateCatalogPayload.js')).migrateCatalogPayload(),
    // One-time canon↔catalog reconciliation: collapse any pre-existing
    // divergence between an embedded universe-canon entry and its catalog row
    // (they were copy-on-write mirrors before the bidirectional projection
    // landed). LWW on updatedAt; writes the winner to both sides. Marker-gated
    // in data/catalog-canon-reconcile.applied.json.
    reconcileCanonCatalog: async () => (await import('../scripts/reconcileCanonCatalog.js')).reconcileCanonCatalog(),
    // Media asset index (#1000): subscribe the generation-completed hooks +
    // reconcile the derived media_assets table against on-disk images/videos.
    // Bytes + sidecars + video-history.json stay authoritative; this builds a
    // queryable index over them. Idempotent, safe to run every boot.
    initMediaAssetIndex: async () => (await import('./mediaAssetIndex/index.js')).initMediaAssetIndex()
  }),

  warmStores: () => warmMandatoryStores({
    // Universe Builder PG warm (#1014): listIds() is the cheapest call that
    // forces backend selection + the migrateUniversesToDB import.
    warmUniverses: () => universeStore().listIds(),
    // Pipeline series + issues PG warm (#1015): same contract.
    warmSeries: () => seriesStore().listIds(),
    warmIssues: () => issueStore().listIds(),
    // Story Builder sessions PG warm (#1016): same contract.
    warmStoryBuilder: () => storyBuilderStore().listIds(),
    // Writers Room PG warm (#1017): listWorkIds() forces backend selection +
    // migrateWritersRoomToDB. Draft .md bodies stay on disk (file-primary);
    // only the metadata migrates.
    warmWritersRoom: () => writersRoomStore().listWorkIds(),
    // Authoritative catalog user-type warm (#1001): load the registry from the
    // catalog_user_types store (runs the one-time settings→DB import on first
    // access), so a normal install always serves with the registry warm even if
    // the early fire-and-forget warm raced a cold DB.
    warmCatalogUserTypes: async () => {
      const warmTypes = await readUserTypeSlice();
      setUserCatalogTypes(Array.isArray(warmTypes) ? warmTypes : []);
    },
    // Creative Director PG warm (#997): unlike the other stores, CD's file→DB
    // import is triggered lazily on first backend access; at boot the only other
    // trigger is a NOT-awaited fire-and-forget recoverInFlightProjects() in an
    // earlier step, so it can still be in flight here. listProjects() forces
    // selectBackend() → the (idempotent, marker-gated) import to completion,
    // which the prune below depends on.
    warmCreativeDirector: async () => (await import('./creativeDirector/local.js')).listProjects(),
    // Legacy artifact prune: removes the `.imported` / `.bak-NNN` recovery
    // copies the migrators parked aside, but ONLY when the live row count
    // matches the marker's recorded import (a wiped/restored DB keeps the
    // recovery files). Marker-gated in data/legacy-prune.applied.json.
    pruneLegacyFiles: async () => (await import('../scripts/pruneImportedLegacyFiles.js')).pruneImportedLegacyFiles()
  }),

  reconcileStackerNews: reconcileStackerNewsSchedulers
});

/** Log the canonical "where do I open this" banner and wire the HTTPS extras. */
const announceListening = ({ io, httpServer, localHttpServer, httpsEnabled, port }) => {
  // One canonical "where do I open this" banner — :5555 is always user-facing
  // (HTTP or HTTPS), :PORTOS_HTTP_PORT (default 5553) is the loopback HTTP
  // mirror that only spawns when HTTPS is active. See docs/PORTS.md.
  console.log(`🚀 PortOS listening on :${port} (${httpsEnabled ? 'https' : 'http'})`);
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
      .catch((err) => console.error(`❌ Build identity probe failed: ${err.message}`));
  }
  if (!httpsEnabled) {
    console.log(`   🌐 http://localhost:${port}`);
    console.log(`⚠️  HTTP only — getUserMedia (mic) won't work over Tailscale IP. Run "npm run setup:cert" to enable HTTPS.`);
    return;
  }
  const localHttpPort = Number(process.env.PORTOS_HTTP_PORT) || PORTS.API_LOCAL;
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
      console.warn(`⚠️  Loopback HTTP mirror on :${localHttpPort} failed: ${err.message} — http://localhost:${localHttpPort} won't work; use https://...:${port}`);
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
export const runBootSequence = ({ io, httpServer, localHttpServer, httpsEnabled, port, host, spawnerReady }) =>
  runPostRouteSequence({
    startBackgroundServices: () => startBackgroundServices({ spawnerReady }),

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
    initMediaJobQueue,
    initMediaJobDependentHooks,

    // Sharing: attach chokidar watchers to every registered share bucket so
    // incoming manifests from peers are picked up live. Backlog processing
    // (manifests that arrived while the server was offline) runs as part of
    // initSharing.
    initSharing: () => initSharing({ io }),

    // Resume any Creative Director projects that were mid-flight when the server
    // died. The queue reload above just reclassified their renders as 'failed
    // (interrupted by restart)'; this nudges the orchestrator so projects don't
    // sit frozen waiting for listeners that no longer exist.
    // recoverInFlightProjects resolves cdRecoveryDone on success. On any failure
    // path here, explicitly resolve it so cos.start's gate doesn't hit the 60s
    // timeout fallback for nothing.
    recoverCreativeDirectorProjects: () => recoverInFlightProjects().catch(async (e) => {
      console.log(`⚠️ CD boot recovery failed: ${e.message}`);
      const { markRecoveryDone } = await import('./creativeDirector/recovery.js');
      markRecoveryDone();
    }),

    runDatabasePhase: runDatabaseBootPhase,

    // One-time series cover-thumbnail backfill: derive `series.coverImage` (the
    // rendered volume/issue cover shown on the pipeline list) for series whose
    // covers rendered before the feature shipped. Runs after the series + issues
    // stores are warmed above so the derivation reads migrated records. Drives
    // the services, so it works on both the PG backend and the file escape hatch.
    // Marker-gated, so it runs at most once regardless. Loading it is a
    // separate step from running it: the sequence awaits the load (a script
    // that won't load is a real breakage) but never the backfill itself.
    loadSeriesCoverBackfill: async () => (await import('../scripts/backfillSeriesCoverImages.js')).backfillSeriesCoverImages,

    startListening: () => httpServer.listen(port, host, () => runPostListenSequence({
      announceListening: () => announceListening({ io, httpServer, localHttpServer, httpsEnabled, port }),
      // Process-level safety net, wired with the io instance so unhandled
      // failures also surface in the UI.
      setupProcessErrorHandlers: () => setupProcessErrorHandlers(io),
      backfillOriginInstanceId,
      startPolling,
      initSyncOrchestrator
    }))
  });

// Run an async close but resolve anyway after `ms` — so a close that never
// settles (e.g. a WebSocket-upgraded socket the server no longer tracks, or a
// leaked DB client) can't hang shutdown; process.exit() reclaims the resources at
// the OS level. `run(finish)` receives a settle-once callback: finish() /
// finish(successMsg) / finish(errMsg, true). The backstop is .unref()'d so it
// never keeps the event loop alive on its own.
const withGrace = (label, ms, run) => new Promise((resolve) => {
  let settled = false;
  const finish = (msg, isErr) => {
    if (settled) return;
    settled = true;
    if (msg) (isErr ? console.error : console.log)(msg);
    resolve();
  };
  run(finish);
  setTimeout(() => finish(`⚠️ ${label} close exceeded ${ms}ms — proceeding`, true), ms).unref?.();
});

// graceMs is deliberately short: closeAllConnections() force-drops every
// connection, so there is no graceful drain left to wait for — the only thing that
// can outlast it is a WebSocket-upgraded socket the server no longer tracks (and
// io.close()'s engine.close() already tore those down protocol-side; the OS reaps
// the TCP remnant on process.exit). So don't tax every restart waiting on it.
// ERR_SERVER_NOT_RUNNING means it was already closed (io.close() closes whichever
// server is its current this.httpServer) — success for us, not a failure.
const closeServer = (server, label, graceMs = 250) => withGrace(label, graceMs, (finish) => {
  if (!server) return finish();
  server.close((err) => {
    if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') finish(`⚠️ Error closing ${label}: ${err.message}`, true);
    else finish(`✅ ${label} closed`);
  });
  // Order matters: close() above stops accepting NEW connections; NOW force-drop
  // the existing long-lived ones (SSE + keep-alive). (Node 18.2+.)
  server.closeAllConnections?.();
});

// Hard ceiling on graceful shutdown: if Socket.IO/HTTP don't close within this
// window, force-exit so PM2 isn't left waiting on a hung process.
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10000;

/**
 * Wire SIGTERM/SIGINT to the graceful-shutdown state machine. Idempotent per
 * signal: once shutdown starts, later signals are ignored.
 */
export const registerShutdownHandlers = ({ io, httpServer, localHttpServer }) => {
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Latch the host-shutdown flag BEFORE anything can await. pm2's TreeKill
    // signals the whole descendant tree, so a server-owned agent PTY can exit
    // microseconds from now — and its exit handler must already know the PTY
    // died because PortOS is going down, not because the agent finished (#3202).
    markHostShuttingDown();
    // Disarm the idle reaper before anything awaits: a sweep that fires mid
    // -shutdown would `pm2 stop` a model server the user never asked to lose,
    // and PortOS is about to stop being the thing that could restart it.
    stopIdleReaper();
    // Diagnostic context for the shutdown trigger. ppid tells us whether the
    // signal came from PM2 (parent is the PM2 god process), a TTY (parent is
    // the user's shell), or some external orchestrator. pm_* env vars are set
    // by PM2 so their presence + a matching ppid is the smoking gun.
    const pid = process.pid;
    const ppid = process.ppid;
    const tty = process.stdin.isTTY ? 'tty' : 'no-tty';
    const pmId = process.env.pm_id ?? process.env.PM2_ID ?? '<not set>';
    const pmExecPath = process.env.pm_exec_path ?? '<not set>';
    console.log(`🛑 Received ${signal} - shutting down gracefully (pid=${pid} ppid=${ppid} ${tty} pm_id=${pmId})`);
    if (pmExecPath !== '<not set>') console.log(`   ↳ launched by PM2: pm_exec_path=${pmExecPath}`);

    const forceExitTimer = setTimeout(() => {
      console.error('⚠️ Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    // Don't let the safety timer itself keep the event loop alive — if every
    // other handle has closed we should exit immediately, not wait out the timer.
    forceExitTimer.unref?.();

    // Record which agents this process owned, so the NEXT boot's orphan sweep can
    // tell "PortOS was restarted out from under a healthy agent" apart from "the
    // agent's own process died" and skip the retry-budget/cooldown penalty for a
    // fault the agent didn't cause (#3202). Only `activeAgents` — the ones whose
    // child processes live in THIS process's tree — belong here; agents the CoS
    // runner owns survive this restart untouched and are re-adopted by
    // `syncRunnerAgents` on the next boot.
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
    const markerWritten = withGrace('Host-shutdown marker', 1500, (finish) =>
      writeHostShutdownMarker({ agentIds: [...activeAgents.keys()], signal })
        .then(() => finish(), (err) => finish(`⚠️ Host-shutdown marker failed: ${err.message}`, true)));

    // Terminate the Codex app-server child before the socket teardown below.
    // pm2's TreeKill would reap it anyway, but a direct SIGTERM keeps a manual
    // `kill` of the server from orphaning a Codex process holding the user's
    // sign-in, and it is a no-op when nothing was ever spawned.
    await withGrace('Codex app-server', 2000, (finish) =>
      stopCodexAppServer().then(
        () => finish(),
        (err) => finish(`⚠️ Codex app-server stop failed: ${err.message}`, true),
      ));

    // Drop existing long-lived sockets (SSE + keep-alive) up front so the closes
    // below don't wait on connections that never end on their own.
    try { httpServer.closeAllConnections?.(); } catch (e) { console.error(`⚠️ closeAllConnections(http): ${e.message}`); }
    try { localHttpServer?.closeAllConnections?.(); } catch (e) { console.error(`⚠️ closeAllConnections(mirror): ${e.message}`); }

    // socket.io's io.close() closes engine.io AND its current this.httpServer — and
    // every io.attach() reassigns this.httpServer (socket.io index.js:303), so with
    // HTTPS on (io.attach(localHttpServer) at boot) io.close() closes the *mirror*,
    // not the primary :5555 server. The historical bug was calling close() a second
    // time on that already-closed server: Node registers the callback as a one-time
    // 'close' listener for an event that already fired, so it never runs and shutdown
    // hangs forever — the real cause of the reconcile "stopping apps" hang.
    await withGrace('Socket.IO', 3000, (finish) =>
      io.close((err) => finish(err ? `⚠️ Error closing Socket.IO: ${err.message}` : '✅ Socket.IO closed', !!err)));
    // Close BOTH servers explicitly. Whichever one io.close() already closed resolves
    // immediately (ERR_SERVER_NOT_RUNNING → treated as success by closeServer), and
    // the bounded backstop in closeServer guarantees neither can hang shutdown even
    // if a future socket.io version changes which server it owns.
    await Promise.all([
      closeServer(httpServer, 'HTTP server'),
      closeServer(localHttpServer, 'Local HTTP mirror')
    ]);

    const { close } = await import('../lib/db.js');
    if (typeof close === 'function') {
      // Bound the DB pool close: pool.end() waits for every checked-out client to
      // be released, so one hung/leaked connection (e.g. a LISTEN channel) would
      // otherwise stall shutdown until the force-exit timer.
      await withGrace('DB pool', 3000, (finish) =>
        close().then(() => finish('✅ DB pool closed'), (err) => finish(`⚠️ DB pool close failed: ${err.message}`, true)));
    } else {
      console.warn('ℹ️ DB pool close not available; skipping DB shutdown');
    }

    await markerWritten;
    clearTimeout(forceExitTimer);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};
