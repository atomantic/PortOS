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
 * Ordering inside each phase is load-bearing and documented inline — read the
 * comments before reordering anything.
 *
 * NOTE (CLAUDE.md "No cold-bootstrap LLM calls"): nothing in this file may
 * queue an AI provider call. Boot only loads on-disk state and ARMS schedulers;
 * every scheduler here is off by default or user-configured.
 */
import { join } from 'path';
import { estimateTokens, estimateTokensFromChars } from '../lib/contextBudget.js';
import { resolveInstallRoot } from '../lib/dataRoot.js';
import { PORTS } from '../lib/ports.js';
import { getSelfHost } from '../lib/peerSelfHost.js';
import { setupProcessErrorHandlers, asyncHandler, ServerError, errorEvents } from '../lib/errorHandler.js';
import { ERROR_CATEGORIES } from '../lib/aiToolkit/errorDetection.js';
import { createAIToolkit } from '../lib/aiToolkit/index.js';
import { verifyCollectionVersions } from '../lib/collectionStore.js';
import { conflictJournalStore } from '../lib/conflictJournal.js';
import { setUserCatalogTypes } from '../lib/catalogTypes.js';
import { runMigrations } from '../../scripts/run-migrations.js';

import { ensureBackendProvider, getBackend as getLocalLlmBackend } from './localLlm.js';
import { ensureProviderReady as ensureOllamaProviderReady, ensureRunning as ensureOllamaRunning } from './ollamaManager.js';
import { recordSession, recordMessages } from './usage.js';
import { setAIToolkit as setProvidersToolkit } from './providers.js';
import { setAIToolkit as setRunnerToolkit, executeCliRun as executeCliRunFixed } from './runner.js';
import { setAIToolkit as setPromptsToolkit } from './promptService.js';
import { executeTuiRun as executeTuiRunFixed } from '../lib/tuiPromptRunner.js';
import { initAutoFixer } from './autoFixer.js';
import { initTaskLearning } from './taskLearning.js';
import { initSpawner } from './subAgentSpawner.js';
import { initCertRenewer } from './certRenewer.js';

import * as cos from './cos.js';
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
import { startSeriesAutopilotScheduler } from './seriesAutopilotScheduler.js';
import { startCommissionScheduler } from './creativeCommissions/scheduler.js';
import { startCitySnapshotScheduler } from './citySnapshotScheduler.js';
import { startImessageScheduler } from './imessageScheduler.js';
import { startSignalScheduler } from './signalScheduler.js';
import { startSpotifyScheduler } from './spotifyScheduler.js';
import { startYoutubeScheduler } from './youtubeScheduler.js';
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
import { recoverStuckClassifications } from './brain.js';
import { recoverStuckAnalyses } from './writersRoom/evaluator.js';
import { recoverStuckAutoRuns } from './pipeline/autoRunner.js';
import { recoverStuckAutopilots } from './pipeline/seriesAutopilot.js';
import { recoverInFlightProjects } from './creativeDirector/recovery.js';
import { recoverInterruptedModels as recoverInterruptedThreejsModels } from './threejsModels/index.js';
import { ensureSelf, startPolling } from './instances.js';
import { initSyncLog } from './brainSyncLog.js';
import { backfillOriginInstanceId, brainCollectionStores } from './brainStorage.js';
import { initSyncOrchestrator } from './syncOrchestrator.js';
import { initMediaJobQueue } from './mediaJobQueue/index.js';
import { initLoraTraining } from './loraTraining/index.js';
import { initSharing } from './sharing/index.js';
import { initMortalLoomStore } from './mortalLoomStore.js';
import { initUniverseBuilderCollectionHook } from './universeBuilderCollectionHook.js';
import { initCatalogImageAttachHook } from './catalogImageAttachHook.js';
import { initWritersRoomSceneImageHook } from './writersRoomSceneImageHook.js';
import { initMusicVideoSceneImageHook } from './musicVideoSceneImageHook.js';
import { initMusicVideoSceneVideoHook } from './musicVideoSceneVideoHook.js';
import { initCreativeDirectorMusicBedHook } from './creativeDirectorMusicBedHook.js';
import { initSpriteReferenceImageHook } from './spriteReferenceImageHook.js';
import { initSpriteWalkVideoHook } from './spriteWalkVideoHook.js';
import { initCreativeDirectorSceneImageHook } from './creativeDirectorSceneImageHook.js';
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
import { commissionStore, backfillAllCommissionFeedback } from './creativeCommissions/store.js';
import { outcomesStore as liOutcomesStore } from './layeredIntelligenceOutcomes.js';

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
  await runMigrations({ rootDir: resolveInstallRoot(join(serverDir, '..')) }).catch(err => {
    // Log the full stack (or stringified err for non-Error throws) so failures
    // during boot are diagnosable without rerunning under a debugger.
    console.error(`❌ Migration run failed at startup: ${err?.stack ?? err}`);
  });

  // Verify every registered collection's on-disk type-level schemaVersion
  // matches what the code expects. Mismatches mean a migration didn't run (or
  // the user rolled the code back below a forward-only migration) — log loudly
  // but DO NOT crash the server. PortOS is single-user (CLAUDE.md "Security
  // Model"); a hard exit on startup is worse than a noisy log the user can act
  // on. Returns per-store statuses for downstream telemetry; we discard them.
  await verifyCollectionVersions([universeStore(), seriesStore(), issueStore(), conflictJournalStore(), storyBuilderStore(), mediaCollectionStore(), loraDatasetStore, liOutcomesStore(), commissionStore(), ...brainCollectionStores()]).catch(err => {
    console.error(`❌ Collection version check failed at startup: ${err?.stack ?? err}`);
  });

  // Lifecycle hooks shared between AI Toolkit and PortOS runner shim
  const aiToolkitHooks = {
    ensureProviderReady: (provider) => ensureOllamaProviderReady(provider),
    onRunCreated: (metadata) => {
      recordSession(metadata.providerId, metadata.providerName, metadata.model).catch(err => {
        console.error(`❌ Failed to record usage session: ${err.message}`);
      });
    },
    onRunCompleted: (metadata, output) => {
      const estimatedTokens = estimateTokens(output);
      const inputTokens = estimateTokensFromChars(metadata.promptLength);
      recordMessages(metadata.providerId, metadata.model, 1, estimatedTokens, inputTokens).catch(err => {
        console.error(`❌ Failed to record usage: ${err.message}`);
      });
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

  // Initialize AI Toolkit with PortOS configuration and hooks
  const aiToolkit = createAIToolkit({
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
    hooks: aiToolkitHooks
  });

  // Initialize compatibility shims for services that import from old service files
  setProvidersToolkit(aiToolkit);
  setRunnerToolkit(aiToolkit, { dataDir, hooks: aiToolkitHooks });
  setPromptsToolkit(aiToolkit);

  // Warm the providers file at startup so the codex-sentinel migration runs
  // before any inbound request can hit the providers cache. Awaited so the
  // migration write completes deterministically before request handlers
  // start consulting providers state.
  await aiToolkit.services.providers.getAllProviders().catch(err => {
    console.error(`❌ Failed to load providers at startup: ${err.message}`);
  });

  // Ensure the provider paired with the active local-LLM backend (LLM_BACKEND in
  // .env, chosen at setup time) is enabled, so a fresh install can use Ollama /
  // LM Studio for runs without hand-toggling it in the Providers UI.
  const activeLocalLlmBackend = getLocalLlmBackend();
  ensureBackendProvider(activeLocalLlmBackend).catch((err) =>
    console.error(`⚠️ Failed to enable local LLM backend provider: ${err.message}`));
  if (activeLocalLlmBackend === 'ollama') {
    ensureOllamaRunning({ preferPersistent: true }).catch((err) =>
      console.error(`⚠️ Failed to start Ollama for active local LLM backend: ${err.message}`));
  }

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
  aiToolkit.services.runner.setCliRunner(executeCliRunFixed);
  aiToolkit.services.runner.setTuiRunner(executeTuiRunFixed);
  console.log('🔧 Registered PortOS CLI + TUI runners via aiToolkit runner extension points');

  // Note: prompts service is initialized automatically by createAIToolkit()

  // Initialize auto-fixer for error recovery
  initAutoFixer();

  // Initialize task learning system to track agent completions
  initTaskLearning();

  // Initialize the CoS agent spawner (event wiring + orphan cleanup) explicitly,
  // now that the runner patch + task learning are ready. Capture the promise so
  // CoS auto-start can wait for the spawner's `task:ready` listener before it
  // emits (see cos.init below). The `.catch` resolves the chain even on failure,
  // so a spawner init error never blocks CoS init.
  const spawnerReady = initSpawner().catch(err => {
    console.error(`❌ Failed to initialize spawner: ${err.message}`);
  });

  return { aiToolkit, spawnerReady };
};

/**
 * Fire-and-forget service inits + scheduler arming. None of these block the
 * server from listening; each logs its own failure and the boot continues.
 */
const startBackgroundServices = ({ spawnerReady }) => {
  // Explicit call (not a module-level side effect) so test imports of cos.js
  // don't spin up its event listeners and timers. Gated on the spawner being
  // ready: CoS auto-start (alwaysOn) can emit `task:ready` for pending tasks
  // during init, which would be dropped if the spawner hadn't yet registered its
  // listener — so wait for `spawnerReady` before kicking off CoS init.
  spawnerReady
    .then(() => cos.init())
    .catch(err => console.error(`❌ CoS init failed: ${err.message}`));

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
  // Initialize Series Autopilot scheduler — OFF by default; registers a cron per
  // series only when the user configured + enabled one via Settings → Series
  // Autopilot. Each scheduled run still passes through the cos autonomy gate +
  // daily budget (sanctioned scheduled-automation exception) (#2174).
  startSeriesAutopilotScheduler().catch(err => console.error(`❌ Series Autopilot scheduler init failed: ${err.message}`));
  // Autonomous Creation Engine (#2657) — arm a cron per enabled Creative
  // Commission. Boot only ARMS timers; nothing fires until a cadence elapses, and
  // each fire gates on creative autonomy `execute` + the daily cos budget (so an
  // `off`/`dry-run` install generates nothing). Sanctioned scheduled-automation.
  // Split any legacy INLINE commission feedback into the federated commissionFeedback
  // store (#2686) BEFORE arming the scheduler, so a fire reads the federated view.
  // Pure data movement (no LLM), idempotent, best-effort. The scripts/migrations
  // runner executes before the DB pool is up, so the data move lives here (see the
  // migration 194 registration stub); the table itself is created by ensureSchema.
  backfillAllCommissionFeedback().catch(err => console.error(`❌ Commission feedback backfill failed: ${err.message}`));
  startCommissionScheduler().catch(err => console.error(`❌ Creative Commission scheduler init failed: ${err.message}`));
  // Initialize CyberCity snapshot scheduler — records periodic city-state frames
  // for the historical timeline scrubber (issue #877).
  startCitySnapshotScheduler().catch(err => console.error(`❌ City snapshot scheduler init failed: ${err.message}`));
  // Initialize iMessage sync scheduler — OFF by default; only polls chat.db when
  // the user opts in via Settings → iMessage (needs macOS Full Disk Access) (#2151).
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
  // Catalog image-attach hook — durably files a queued render onto its target
  // ingredient on completion, even if the editor page unmounted mid-render
  // (#1359).
  initCatalogImageAttachHook();
  // Writers-Room scene-image hook — durably files a queued storyboard render
  // onto its analysis snapshot + work collection on completion (#1363).
  initWritersRoomSceneImageHook();
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
  // Sprite reference-candidate hook — copies a completed reference/anchor
  // render into the sprite record's reference/candidates/ with a generation
  // sidecar (#2896).
  initSpriteReferenceImageHook();
  initSpriteWalkVideoHook();
  // Creative Director scene-frame hook — durably files a queued first-pass
  // reference-frame render onto its project scene's `sourceImageFile` on
  // completion, even if no client is watching (#1867).
  initCreativeDirectorSceneImageHook();
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
 * Verify PostgreSQL is reachable + at the current schema, upgrading it if it
 * merely lags. Returns `{ dbReady }`.
 *
 * PostgreSQL is a mandatory dependency. If the DB is unusable and we're NOT in
 * a sanctioned escape-hatch/test mode this is a fatal misconfiguration: the
 * creative catalog has no file-backed equivalent, so booting "successfully"
 * would silently serve a broken install. Fail fast with an actionable message.
 *
 * Escape hatches (dev/tests only, UNSUPPORTED for production):
 *   - MEMORY_BACKEND=file  (explicit file backend)
 *   - NODE_ENV=test        (test suites boot without a database)
 */
const gateOnDatabase = async () => {
  const dbEscapeHatch =
    process.env.MEMORY_BACKEND === 'file' || process.env.NODE_ENV === 'test';
  const { checkHealth, ensureSchema } = await import('../lib/db.js');
  let health = await checkHealth();
  // An EXISTING install can be reachable but lag the current schema — e.g.
  // `memories` exists but a newer column (`sync_sequence`) is missing, which
  // is exactly what checkHealth() requires for hasSchema. ensureSchema() is
  // idempotent and exists to bring such installs up to date, so when the DB
  // is connected but reports incomplete schema, run the upgrade and re-probe
  // BEFORE declaring the install unbootable. A truly uninitialized DB (base
  // tables absent) makes ensureSchema() throw — we catch, log, and fall
  // through to the fail-fast below. (try/catch is appropriate here: this runs
  // outside the request lifecycle, so an uncaught throw would crash boot.)
  if (health.connected && (!health.hasSchema || !health.hasCatalogSchema)) {
    try {
      await ensureSchema();
      health = await checkHealth();
    } catch (err) {
      console.error(`🗄️  Schema upgrade on boot failed: ${err.message}`);
    }
  }
  // Both the memory schema AND the creative-catalog schema are required —
  // the catalog has no file-backed equivalent. ensureSchema() creates the
  // catalog tables idempotently, but if that DDL fails (e.g. the role can't
  // CREATE) the swallowed error in the migration block below would otherwise
  // let the server boot with the catalog missing. Gate boot on both.
  const dbReady = health.connected && health.hasSchema && health.hasCatalogSchema;
  if (!dbEscapeHatch && !dbReady) {
    const reason = health.connected ? 'required schema missing' : `unreachable (${health.error || 'connection failed'})`;
    console.error(`❌ PostgreSQL is required but ${reason} — refusing to start.`);
    console.error('   Set up the database with: npm run setup:db');
    console.error('   Dev/test only: set PGMODE=file in .env to boot without PostgreSQL (unsupported for production).');
    process.exit(1);
  }
  if (dbEscapeHatch && !dbReady) {
    console.warn(`⚠️  PostgreSQL unavailable (${health.error || 'no schema'}) — booting via escape hatch; catalog/DB features are disabled.`);
  }
  return { dbReady, ensureSchema };
};

/**
 * DB schema + catalog/media migrations. Best-effort as a group (a transient
 * hiccup mid-walk shouldn't crash an otherwise-healthy boot; the route surface
 * tolerates an empty catalog and the user can re-trigger via the admin
 * endpoint) EXCEPT the versioned DB-migration runner, which is fatal.
 */
const runDbAndCatalogMigrations = async (dbReady, ensureSchema) => {
  try {
    // Two early exits guard the migrations below: (1) the fail-fast
    // process.exit(1) in gateOnDatabase when the DB is required but missing,
    // and (2) this return when on the escape hatch with no healthy DB —
    // ensureSchema and the migrations would throw otherwise.
    if (!dbReady) {
      return;
    }
    await ensureSchema();
    // Versioned DB-migration runner (#1029): apply ordered schema-DELTA
    // migrations (renames / type changes / data transforms / embedding-dim
    // changes) that ensureSchema()'s additive IF NOT EXISTS gates can't
    // express. Runs AFTER ensureSchema() (base schema + schema_migrations
    // tracking table present) and AFTER the DB-ready gate, but BEFORE any
    // store warm or httpServer.listen — so a half-applied delta can't race a
    // request. Skipped under the file backend by the !dbReady early return
    // above. A FAILED migration is FATAL: each migration runs in a transaction
    // so a failure rolls back (NOT marked applied), but we must NOT let boot
    // continue — a partially-migrated install serving requests is worse than a
    // hard stop. So this gets its own try/catch (not the generic catalog one
    // below, which only logs and continues) that exits the process loudly.
    // This is a process boundary, so the explicit try/catch is sanctioned.
    const { runDbMigrations } = await import('../scripts/run-db-migrations.js');
    try {
      await runDbMigrations();
    } catch (err) {
      console.error(`❌ DB migration failed at boot — refusing to start: ${err?.stack ?? err.message}`);
      process.exit(1);
    }
    const { migrateBibleToCatalog } = await import('../scripts/migrateBibleToCatalog.js');
    await migrateBibleToCatalog();
    // One-time data repair: rewrite legacy machine universe tags
    // (`from-universe`, `universe:<id>`) on backfilled rows into the friendly
    // universe NAME tag. Runs after the backfill so promoted rows exist;
    // marker-gated in data/catalog-universe-tags.applied.json.
    const { repairUniverseTags } = await import('../scripts/repairUniverseTags.js');
    await repairUniverseTags();
    // Per-record catalog payload-shape migration — walks rows whose stored
    // payload.schemaVersion lags the registry-current and applies registered
    // upgraders. No-ops via marker once an install is at the high-water
    // version, so this is free on steady-state boots.
    const { migrateCatalogPayload } = await import('../scripts/migrateCatalogPayload.js');
    await migrateCatalogPayload();
    // One-time canon↔catalog reconciliation: collapse any pre-existing
    // divergence between an embedded universe-canon entry and its catalog
    // row (they were copy-on-write mirrors before the bidirectional
    // projection landed). LWW on updatedAt; writes the winner to both sides.
    // Runs LAST so promoted rows exist and are at current payload-shape
    // version; marker-gated in data/catalog-canon-reconcile.applied.json.
    const { reconcileCanonCatalog } = await import('../scripts/reconcileCanonCatalog.js');
    await reconcileCanonCatalog();
    // Media asset index (#1000): subscribe the generation-completed hooks +
    // reconcile the derived media_assets table against on-disk images/videos.
    // Bytes + sidecars + video-history.json stay authoritative; this builds a
    // queryable index over them. Idempotent, safe to run every boot.
    const { initMediaAssetIndex } = await import('./mediaAssetIndex/index.js');
    await initMediaAssetIndex();
  } catch (err) {
    console.error(`🪄 catalog migrations failed at boot: ${err.message}`);
  }
};

/**
 * Mandatory PostgreSQL store warmups (#1014–1017, #1001, #997) + legacy prune.
 * Each touch forces backend selection and runs a one-time, marker-gated file→DB
 * import that MUST complete before httpServer.listen — so the first request/sync
 * sees fully-migrated records, never a half-applied import racing a request.
 * Unlike the best-effort catalog migrations (which log-and-continue), a failure
 * here is FATAL: a store that couldn't select its backend or finish its import
 * would serve unmigrated/empty data, which is worse than a hard stop. So this
 * gets its own try/catch (a process boundary, like runDbMigrations) that exits
 * loudly instead of swallowing the error and booting a partially-migrated
 * install.
 */
const warmMandatoryStores = async () => {
  try {
    // Universe Builder PG warm (#1014): listIds() is the cheapest call that
    // forces backend selection + the migrateUniversesToDB import.
    await universeStore().listIds();
    // Pipeline series + issues PG warm (#1015): same contract. Series first
    // (issues soft-ref it for universe resolution / lists).
    await seriesStore().listIds();
    await issueStore().listIds();
    // Story Builder sessions PG warm (#1016): same contract. Universe +
    // series warmed first (sessions soft-ref both for staleness recompute).
    await storyBuilderStore().listIds();
    // Writers Room PG warm (#1017): listWorkIds() forces backend selection +
    // migrateWritersRoomToDB. Draft .md bodies stay on disk (file-primary);
    // only the metadata migrates.
    await writersRoomStore().listWorkIds();
    // Authoritative catalog user-type warm (#1001): load the registry from
    // the catalog_user_types store (runs the one-time settings→DB import on
    // first access), so a normal install always serves with the registry
    // warm even if the early fire-and-forget warm raced a cold DB.
    const warmTypes = await readUserTypeSlice();
    setUserCatalogTypes(Array.isArray(warmTypes) ? warmTypes : []);
    // Creative Director PG warm (#997): unlike the other stores, CD's file→DB
    // import is triggered lazily on first backend access; at boot the only
    // other trigger is a NOT-awaited fire-and-forget recoverInFlightProjects()
    // in an earlier step, so it can still be in flight here. The prune below
    // stamps a single completion marker once no domain is blocked, so it must
    // not run while CD's import (and its
    // creative-director-projects.migrated.json marker) is unfinished, or CD's
    // .imported file would never be pruned. listProjects() forces
    // selectBackend() → the (idempotent, marker-gated) import to completion.
    const { listProjects: warmCdProjects } = await import('./creativeDirector/local.js');
    await warmCdProjects();
    // Legacy artifact prune: runs LAST, after every file→DB warm above has
    // imported + stamped its marker, so both the migration markers AND the
    // authoritative DB rows exist. Removes the `.imported` / `.bak-NNN`
    // recovery copies the migrators parked aside, but ONLY when the live row
    // count matches the marker's recorded import (a wiped/restored DB keeps
    // the recovery files). Marker-gated in data/legacy-prune.applied.json.
    const { pruneImportedLegacyFiles } = await import('../scripts/pruneImportedLegacyFiles.js');
    await pruneImportedLegacyFiles();
  } catch (err) {
    console.error(`❌ Mandatory store warmup failed at boot — refusing to start: ${err?.stack ?? err.message}`);
    process.exit(1);
  }
};

/** Log the canonical "where do I open this" banner and wire the HTTPS extras. */
const announceListening = ({ io, httpServer, localHttpServer, httpsEnabled, port }) => {
  // One canonical "where do I open this" banner — :5555 is always user-facing
  // (HTTP or HTTPS), :PORTOS_HTTP_PORT (default 5553) is the loopback HTTP
  // mirror that only spawns when HTTPS is active. See docs/PORTS.md.
  console.log(`🚀 PortOS listening on :${port} (${httpsEnabled ? 'https' : 'http'})`);
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
 * boot chain that ends in `httpServer.listen()`. Returns the chain's promise so
 * a caller can await it; index.js intentionally does not (boot proceeds in the
 * background and any fatal step exits the process itself).
 */
export const runBootSequence = ({ io, httpServer, localHttpServer, httpsEnabled, port, host, spawnerReady }) => {
  startBackgroundServices({ spawnerReady });

  // Initialize instance identity + sync log before accepting requests to prevent
  // race conditions where brain mutations arrive before the sync log is ready
  return ensureSelf()
    .then(() => initSyncLog())
    .then(() => {
      // Recover inbox entries stuck in 'classifying' from a previous crash. Runs
      // AFTER initSyncLog() because updateInboxLog() now appends to the brain sync
      // log — running it before currentSeq is loaded would mint colliding seqs and
      // corrupt peer cursors. Fire-and-forget; failures are logged.
      recoverStuckClassifications().catch(err => console.error(`❌ Brain recovery failed: ${err.message}`));
    })
    // initMediaJobQueue is awaited here so that data/ exists and the worker loop
    // is running before /api/video-gen or /api/image-gen can enqueue (otherwise
    // persist() can race with ensureDir).
    .then(() => initMediaJobQueue())
    .then(() => initMediaJobDependentHooks())
    .then(() => {
      // Sharing: attach chokidar watchers to every registered share bucket so
      // incoming manifests from peers are picked up live. Backlog processing
      // (manifests that arrived while the server was offline) runs as part of
      // initSharing. Fire-and-forget — a failed bucket shouldn't block boot.
      initSharing({ io }).catch((err) => {
        console.error(`❌ Sharing init failed: ${err.message}`);
      });
    })
    .then(() => {
      // Fire-and-forget — resume any Creative Director projects that were mid-
      // flight when the server died. The queue reload above just reclassified
      // their renders as 'failed (interrupted by restart)'; this nudges the
      // orchestrator so projects don't sit frozen waiting for listeners that
      // no longer exist. Doesn't block startup.
      // recoverInFlightProjects resolves cdRecoveryDone on success. On any
      // failure path here, explicitly resolve it so cos.start's gate doesn't
      // hit the 60s timeout fallback for nothing.
      recoverInFlightProjects().catch(async (e) => {
        console.log(`⚠️ CD boot recovery failed: ${e.message}`);
        const { markRecoveryDone } = await import('./creativeDirector/recovery.js');
        markRecoveryDone();
      });
    })
    .then(async () => {
      const { dbReady, ensureSchema } = await gateOnDatabase();
      await runDbAndCatalogMigrations(dbReady, ensureSchema);
      // Skipped when not dbReady (escape hatch), matching the migrations above.
      if (dbReady) await warmMandatoryStores();
    })
    .then(async () => {
      // One-time series cover-thumbnail backfill: derive `series.coverImage` (the
      // rendered volume/issue cover shown on the pipeline list) for series whose
      // covers rendered before the feature shipped. Runs after the series + issues
      // stores are warmed above so the derivation reads migrated records. Drives
      // the services, so it works on both the PG backend and the file escape hatch.
      // FIRE-AND-FORGET (not awaited): a cosmetic thumbnail backfill must never
      // delay the server accepting requests, and it's marker-gated so it runs at
      // most once regardless.
      const { backfillSeriesCoverImages } = await import('../scripts/backfillSeriesCoverImages.js');
      backfillSeriesCoverImages().catch((err) => {
        console.error(`❌ series cover backfill failed at boot: ${err?.message ?? err}`);
      });
    })
    .then(() => {
      // Start server only after sync log + media job queue are initialized.
      // initMediaJobQueue failure is fatal: the queue owns persistence + SSE
      // + temp-file cleanup for /api/video-gen and local /api/image-gen, and
      // accepting requests with a half-init queue silently corrupts state
      // (persist() throws, SSE streams degrade). Catch + crash via the
      // outer .catch(...process.exit) below.
      httpServer.listen(port, host, () => {
        announceListening({ io, httpServer, localHttpServer, httpsEnabled, port });

        // Set up process error handlers with io instance
        setupProcessErrorHandlers(io);

        // Backfill origin tags and start peer polling + sync (non-blocking)
        backfillOriginInstanceId()
          .then(() => {
            startPolling();
            initSyncOrchestrator();
          })
          .catch(err => console.error(`❌ Post-startup init failed: ${err.message}`));
      });
    })
    .catch(err => {
      console.error(`❌ Instance init failed: ${err.message}`);
      process.exit(1);
    });
};

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

    clearTimeout(forceExitTimer);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};
