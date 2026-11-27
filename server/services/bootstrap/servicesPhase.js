/** Prepare toolkit and runner services before routes mount, then recover background services at startup. */

import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { emitToOperatorsOn } from '../socketIo.js';
import { bindMaintenanceIo } from '../maintenanceControl.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { noteReadinessChanged } from '../readinessSignal.js';
import { isSmokeBoot } from '../../lib/runtimeEnv.js';
import { readPortosEnvValue } from '../../lib/portosEnv.js';
import { join } from 'path';
import { withRuntimeFileTurn } from '../../lib/runtimeFilePublication.js';
import { redactStoredPrivacyPrompt, trackPrivateRunOutput } from '../../lib/privacyPrompt.js';
import { asyncHandler, ServerError, errorEvents } from '../../lib/errorHandler.js';
import { ERROR_CATEGORIES } from '../../lib/aiToolkit/errorDetection.js';
import { createAIToolkit } from '../../lib/aiToolkit/index.js';
import { attachLlmActivityHooks } from '../systemActivityNotify.js';
import { adoptNpmGlobalBinDir } from '../../lib/npmGlobalBin.js';
import { isHostShuttingDown } from '../../lib/hostShutdown.js';
import { setUserCatalogTypes } from '../../lib/catalog/catalogTypes.js';
import { runPreRouteSequence, initCosAfterSpawner, gateStepsForSmokeBoot } from '../bootstrapSequence.js';
import { bindLocalLlmIo, ensureBackendProvider, getBackend as getLocalLlmBackend } from '../localLlm.js';
import { ensureRunning as ensureOllamaRunning } from '../ollamaManager.js';
import { ensureProviderReadyForExecution } from '../provider/providerExecutionReadiness.js';
import { recordSession } from '../usage.js';
import { recordCompletedRunUsage } from '../usageReconciler.js';
import { setAIToolkit as setProvidersToolkit } from '../provider/providers.js';
import { setAIToolkit as setProviderStatusToolkit } from '../provider/providerStatus.js';
import { setAIToolkit as setRunnerToolkit, executeCliRun as executeCliRunFixed, serializeRunDeletion } from '../runner.js';
import { reconcileDeadOwnerReservations } from '../deadOwnerReservations.js';
import { startHarnessActionRecovery } from '../harnessActionRecovery.js';
import { setAIToolkit as setPromptsToolkit } from '../promptService.js';
import { executeTuiRun as executeTuiRunFixed } from '../tuiPromptRunner.js';
import { initAutoFixer } from '../autoFixer.js';
import { initTaskLearning } from '../taskLearning.js';
import { initSpawner } from '../subAgentSpawner.js';
import * as cos from '../cos/cos.js';
import * as automationScheduler from '../automationScheduler.js';
import * as agentActionExecutor from '../agent/agentActionExecutor.js';
import * as telegram from '../telegram.js';
import * as telegramBridge from '../telegramBridge.js';
import { getSettings as getInitSettings } from '../settings.js';
import { readUserTypes as readUserTypeSlice } from '../catalogUserTypes/store.js';
import { getVoiceConfig } from '../voice/config.js';
import { reconcile as reconcileVoice } from '../voice/bootstrap.js';
import { initVoiceTimers } from '../voice/timers.js';
import { onProvidersSaved as onProvidersSavedForGraph } from '../provider/providerGraph.js';
import { reportRetiredModelPins } from '../modelPinAuditNotifier.js';
import { startUpdateScheduler, clearStaleUpdateInProgress, processUpdateMarker } from '../updateChecker.js';
import { captureBootCommit } from '../installState.js';
import { restoreLoops } from '../loops.js';
import { recoverStuckAnalyses } from '../writersRoom/analysisSnapshots.js';
import { recoverStuckGeneratingStages, recoverStuckAutoRuns, recoverStuckAutopilots } from '../pipeline/recovery.js';
import { requireMusicVideoRecovery } from '../bootHookRegistry.js';
import { recoverInterruptedBlenderModels, recoverInterruptedImageTo3dModels, recoverInterruptedThreejsModels } from '../modelRecovery.js';
import { initSpriteLocalAnimationHook } from '../sprites/localAnimationJobHook.js';
import { initMortalLoomStore } from '../mortalLoomStore.js';
import { initCatalogUniverseFiling } from '../catalog/catalogUniverseFiling.js';
import { startHostedSessionSweep } from '../fableLoom/hostedSession.js';
import { initImageGenQuotaHook } from '../imageGenQuota.js';
import { prerequisitesMetForRouting } from '../provider/providerPrerequisites.js';
import { peekFallbackChain } from '../../lib/provider/providerFallbackChainCache.js';
import { initFallbackChain } from '../provider/providerFallbackChain.js';
import { localCachedModelIds } from '../localCachedModels.js';
import { logFailureWithStack as logBootstrapFailure } from '../../lib/failureLogging.js';
import { isInstanceFeatureEnabled } from '../instanceFeatures.js';
import { preRouteStorageSteps } from './storagePhase.js';
import { startBackgroundSchedulers } from './schedulersPhase.js';

/**
 * Pre-route boot. Everything a route handler may depend on being ready the
 * moment the first request lands: applied data migrations, a constructed AI
 * Toolkit (routes are built from it), and the spawner/autofixer/task-learning
 * background workers.
 *
 * Returns `{ aiToolkit, spawnerReady }` — `aiToolkit` feeds the toolkit-backed
 * route factories in index.js, `spawnerReady` gates CoS init in
 * the post-route boot sequence.
 */
export const bootstrapServices = async ({ io, dataDir, dataReferenceDir, serverDir }, {
  exit = (code) => process.exit(code)
} = {}) => {
  // First: the CoS daemon, media queue and git cleanup route all call through
  // these. Loaded lazily so the registrar's loaders stay off the boot closure.
  (await import('../bootHooks.js')).registerBootHooks();
  bindMaintenanceIo(io);
  bindLocalLlmIo(io);
  // Lifecycle hooks shared between AI Toolkit and PortOS runner shim
  const aiToolkitHooks = attachLlmActivityHooks({
    trackRunOutput: (path, prompt) => trackPrivateRunOutput(path, prompt, withRuntimeFileTurn),
    ensureProviderReady: (provider) => ensureProviderReadyForExecution(provider),
    // Same-service key rotation before the provider bench + fallback chain
    // (#17384). Deferred: the graph store loads only when a run reaches it.
    openCredentialSession: (provider, model) => import('../provider/credentialPoolRuntime.js')
      .then(({ openCredentialSession }) => openCredentialSession(provider, model)),
    onRunCreated: (metadata) => {
      recordSession(metadata.providerId, metadata.providerName, metadata.model).catch(err => {
        logBootstrapFailure('❌ Failed to record usage session', err);
      });
    },
    onRunCompleted: (metadata, output) => {
      // Reads the provider CLI's own transcript for real token counts (including
      // the prompt-cache tiers that dominate cost), falling back to the
      // prompt-length/stdout estimate when none is found. Owns its own error
      // handling — a usage-accounting failure must not fail the run.
      return recordCompletedRunUsage(metadata, output);
    },
    onRunFailed: (metadata, error) => {
      const errorMessage = error?.message ?? String(error);
      // A content/safety refusal is a known, self-explanatory outcome — not a
      // provider fault. Emit a distinct code + warning severity so (a) the
      // autofixer skips it (it only spawns investigation tasks for
      // AI_PROVIDER_EXECUTION_FAILED) and (b) the client shows a calm "model
      // declined, stopped" notice instead of a red error toast. Automatic retry
      // and provider fallback are disabled.
      const isBudget = metadata.errorAnalysis?.category === ERROR_CATEGORIES.RUNTIME_BUDGET_EXHAUSTED;
      const isOutputLimit = metadata.errorAnalysis?.category === ERROR_CATEGORIES.OUTPUT_LIMIT;
      const isRefusal = metadata.errorAnalysis?.category === ERROR_CATEGORIES.CONTENT_REFUSAL;
      const isImageUnsupported = metadata.errorAnalysis?.category === ERROR_CATEGORIES.IMAGE_UNSUPPORTED;
      const hasKnownCause = isBudget || isOutputLimit || isRefusal || isImageUnsupported;
      errorEvents.emit('error', {
        code: isBudget ? 'AI_RUNTIME_BUDGET_EXHAUSTED' : isOutputLimit ? 'AI_OUTPUT_LIMIT_EXCEEDED' : isRefusal ? 'AI_PROVIDER_CONTENT_REFUSED'
          : isImageUnsupported ? 'AI_PROVIDER_IMAGE_UNSUPPORTED' : 'AI_PROVIDER_EXECUTION_FAILED',
        message: isBudget || isOutputLimit ? errorMessage : isRefusal
          ? `${metadata.providerName} declined this prompt on content/safety grounds — stopped without automatic retry or provider fallback.`
          : isImageUnsupported ? errorMessage
          : `AI provider ${metadata.providerName} execution failed: ${errorMessage}`,
        severity: hasKnownCause ? 'warning' : 'error',
        canAutoFix: !hasKnownCause,
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
          timeoutBound: metadata.timeoutBound,
          timeoutOrigin: metadata.timeoutOrigin,
          runtimeBudgetMs: metadata.runtimeBudgetMs,
          // Note: promptPreview and outputTail intentionally omitted to avoid leaking sensitive data
        }
      });
    }
  });

  // The ORDER these run in is `runPreRouteSequence`'s contract (see
  // bootstrapSequence.js); this object is only the "what".
  //
  // Under the boot smoke (#8343) the steps that would start local-LLM backends,
  // the auto-fixer, or the CoS spawner (runner connection + agent recovery) are
  // no-ops — see SMOKE_BOOT_DISABLED_STEPS.
  const smokeBoot = isSmokeBoot();
  if (smokeBoot) console.log('🧪 Smoke boot: startup jobs, agent recovery, and external integrations are disabled');
  return runPreRouteSequence(gateStepsForSmokeBoot({
    ...preRouteStorageSteps({ serverDir, dataDir, smokeBoot, exit }),

    createToolkit: () => createAIToolkit({
      dataDir,
      providersFile: 'providers.json',
      runsDir: 'runs',
      promptsDir: 'prompts',
      screenshotsDir: join(dataDir, 'screenshots'),
      sampleProvidersFile: join(dataReferenceDir, 'providers.json'),
      emit: (event, ...args) => emitToOperatorsOn(io, event, ...args),
      asyncHandler,
      withAssetPublication: withBackupAssetPublication,
      redactStoredPrompt: redactStoredPrivacyPrompt,
      withRunAdmission: handler => (req, res) => maintenance.run('manual-run', 'Runs', () => handler(req, res)),
      // Inject PortOS's ServerError so toolkit route errors normalize into the
      // canonical `{ error, code, timestamp, context? }` envelope (issue #1084).
      ServerError,
      hooks: aiToolkitHooks,
      // Keep the provider connection graph reconciled with any write to
      // providers.json — an old client's PATCH, a model refresh, a delete.
      // Injected rather than imported by the toolkit, which stays
      // self-contained. A no-op until the database phase enables the graph.
      //
      // The same write is also the moment a catalog refresh retires a model a
      // stored pin names, so it re-runs the derive-on-read pin audit and logs
      // the pins that NEWLY went stale (#7328). allSettled, not all: neither
      // consumer may skip or fail the other.
      onProvidersSaved: () => Promise.allSettled([
        // Covers direct toolkit route writes as well as service-shim callers.
        noteReadinessChanged(),
        onProvidersSavedForGraph(),
        reportRetiredModelPins(),
      ]),
      // Keep the fallback chain off providers whose CLI is not installed on
      // this host (#4611), so a run falls through to the next candidate instead
      // of dying at spawn time. Sync by contract: it reads the runtime probe's
      // cache and never blocks.
      prerequisitesMet: prerequisitesMetForRouting,
      // The user's single ordered fallback list (Models > Fallbacks); a cache
      // read, so it is sync as the toolkit requires.
      getFallbackChain: peekFallbackChain,
      // MTPLX and Slotstream each serve one checkpoint per process and report
      // only that one, so a refresh could never surface a newly downloaded
      // checkpoint — and for Slotstream it pruned the record's other shipped ids.
      // This lets the refresh merge in what is actually on disk; it answers
      // `null` for every other provider, reads a local cache rather than calling
      // a model, and imports each runtime's cache reader lazily so neither subtree
      // reaches the boot closure (see `services/localCachedModels.js`).
      cachedModelIds: localCachedModelIds,
      // A composite id (`harness.method@service[+bootstrap]`, #7564) names no
      // stored record: the toolkit hands it here, and the host materializes it
      // from the harness registry, the service instance and settings. Imported
      // lazily so the graph store's subtree stays off the boot closure until a
      // composite is actually asked for.
      resolveCompositeProvider: async (id) => (await import('../compositeProviders.js')).resolveCompositeProvider(id)
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
    warmProviders: async (aiToolkit) => {
      // Prime the sync fallback-list cache from settings.json (disk only).
      await initFallbackChain().catch((err) => logBootstrapFailure('⚠️ Failed to load provider fallback list', err));
      return aiToolkit.services.providers.getAllProviders();
    },

    // Ensure the provider paired with the active local-LLM backend (LLM_BACKEND in
    // .env, chosen at setup time) is enabled, so a fresh install can use Ollama /
    // LM Studio for runs without hand-toggling it in the Providers UI. Starting
    // the Ollama server is not a provider CALL — nothing is inferred until the
    // user asks for it.
    ensureLocalLlmBackend: () => {
      if (readPortosEnvValue('PORTOS_FLEET_LLM_ENABLED') === '1') return;
      const activeLocalLlmBackend = getLocalLlmBackend();
      ensureBackendProvider(activeLocalLlmBackend).catch((err) =>
        logBootstrapFailure('⚠️ Failed to enable local LLM backend provider', err));
      if (activeLocalLlmBackend === 'ollama') {
        ensureOllamaRunning({ preferPersistent: true }).catch((err) =>
          logBootstrapFailure('⚠️ Failed to start Ollama for active local LLM backend', err));
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
      const executeApi = aiToolkit.services.runner.executeApiRun.bind(aiToolkit.services.runner);
      aiToolkit.services.runner.executeApiRun = options => {
        const permit = maintenance.admit('api-run', options.runId, { continuation: true });
        return permit.run(() => executeApi({ ...options,
          onPersistenceFailure: () => permit.markUnsettled(),
          onSettled: () => permit.finish(),
        })).catch(err => { permit.markUnsettled(); throw err; });
      };
      // Interrupted-run recovery finalizes records while DELETE /api/runs/:id is
      // served; a delete shares finalizeRunRecord's per-run turn.
      aiToolkit.services.runner.deleteRun = serializeRunDeletion(aiToolkit.services.runner.deleteRun.bind(aiToolkit.services.runner));
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
  }, 'preRoute', smokeBoot));
};

/**
 * Fire-and-forget service inits + scheduler arming. None of these block the
 * server from listening; each logs its own failure and the boot continues.
 */
export const startBackgroundServices = ({ spawnerReady, io, httpsEnabled, port }, {
  armHostedSessions = startHostedSessionSweep
} = {}) => {
  // A crashed process leaks settled reservations that finish() never reached.
  // Stamp uncertain publications before later boot steps read the journal.
  // Sync and non-throwing; CoS may be off. Smoke boot skips this whole function.
  reconcileDeadOwnerReservations();
  // Detached-launch writer records a restart stranded would otherwise block the
  // database cutover preflight; sweep the proven-quiescent ones. File I/O and
  // `ps` only, no provider calls.
  import('../../lib/detachedSpawn.js')
    .then(({ sweepQuiescentWriters }) => sweepQuiescentWriters())
    .then(({ retired, skipped }) => console.log(skipped
      ? `⏭️ Detached writer sweep skipped (${skipped})`
      : `🧹 Detached writer sweep retired ${retired} quiescent record(s)`))
    .catch((err) => logBootstrapFailure('❌ Detached writer sweep failed', err));
  startHarnessActionRecovery();

  // Keep the opt-in agent API key file current (Settings > Security). A no-op
  // beyond one settings read while the key is off. Disabled under smoke boot
  // with the rest of this function, so a smoke run never writes to $HOME.
  import('../agent/agentKey.js')
    .then(({ initAgentKey }) => initAgentKey({ httpsEnabled, port }))
    .catch((err) => logBootstrapFailure('❌ Agent API key init failed', err));

  // Put npm's global bin directory on PATH before anything spawns a provider
  // CLI. npm's prefix need not be the directory the host's Node installer put
  // on PATH, and a CLI installed there is invisible to the bare-name spawn a
  // TUI provider uses until it is adopted. One `npm prefix -g` child, never an
  // AI provider call — safe under AGENTS.md's no-cold-bootstrap rule, on the
  // same footing as the `--version` probes providerPrerequisites.js already
  // runs. The CoS runner is a separate process and adopts it separately.
  adoptNpmGlobalBinDir().catch((err) => logBootstrapFailure('❌ npm global bin adoption failed', err));

  // Explicit call (not a module-level side effect) so test imports of cos.js
  // don't spin up its event listeners and timers. The spawner gate itself lives
  // in bootstrapSequence.js.
  initCosAfterSpawner({ spawnerReady, initCos: () => cos.init(), isStopping: isHostShuttingDown });

  // Restore only an installed, opted-in world, then its bridge, resident
  // presence, and pending design. No install, download, or AI provider call.
  // startBackgroundServices is disabled during smoke boot.
  import('../eidoverseRuntime.js')
    .then(({ reconcileEidoverseRuntime }) => reconcileEidoverseRuntime())
    .then((result) => {
      if (result.running) console.log('🌐 Eidoverse runtime and resident presence restored');
    })
    .catch(err => logBootstrapFailure('⚠️ Eidoverse startup deferred', err));

  // Docker containment (#12844): sweep containers/volumes a crash or restart
  // left behind — only when the user turned the feature on, so a fresh install
  // makes no Docker call at boot.
  import('../dockerContainment.js')
    .then(async ({ reconcileDockerContainment }) => {
      if (await isInstanceFeatureEnabled('docker-containment')) await reconcileDockerContainment({ enabled: true, reason: 'boot' });
    })
    .catch(err => logBootstrapFailure('⚠️ Docker containment boot reconcile deferred', err));

  // Blender execution: re-run the saved configuration's own check when it last
  // passed and has not changed, so the lane is ready without a manual check
  // after every restart. PortOS's synthetic probe scripts and fixed test scene
  // only (no project code, no provider call); an install that never passed a
  // check starts no process here.
  import('../codeAnimation/execution.js')
    .then(({ rearmCodeAnimationExecution }) => rearmCodeAnimationExecution())
    .catch(err => logBootstrapFailure('❌ Blender execution re-check failed', err));

  // Initialize agent automation scheduler and action executor
  automationScheduler.init().catch(err => logBootstrapFailure('❌ Agent scheduler init failed', err));
  // agentActionExecutor.init() is synchronous — guard with try/catch so a thrown
  // error logs cleanly instead of crashing the server at module load.
  try {
    agentActionExecutor.init();
  } catch (err) {
    logBootstrapFailure('❌ agentActionExecutor init failed', err);
  }

  // Inbox recovery is deferred until after initSyncLog() (see the ensureSelf chain
  // in runBootSequence) — it mutates inbox entries, which are now synced brain
  // records, so its updateInboxLog() calls append to sync_log.jsonl and MUST run
  // after the log's currentSeq is loaded, or they'd write low/duplicate sequence
  // numbers and corrupt peer cursors.
  recoverStuckAnalyses().catch(err => logBootstrapFailure('❌ Writers Room recovery failed', err));
  recoverStuckGeneratingStages().catch(err => logBootstrapFailure('❌ Pipeline text-stage recovery failed', err));
  recoverStuckAutoRuns().catch(err => logBootstrapFailure('❌ Pipeline auto-run recovery failed', err));
  recoverStuckAutopilots().catch(err => logBootstrapFailure('❌ Pipeline autopilot recovery failed', err));
  // Registered in registerBootHooks() above. The render pipeline is not a static boot import (#17692).
  const musicVideoRecovery = requireMusicVideoRecovery();
  musicVideoRecovery.recoverRenders().catch(err => logBootstrapFailure('❌ Music Video recovery failed', err));
  musicVideoRecovery.recoverExcerpts().catch(err => logBootstrapFailure('❌ Music Video excerpt recovery failed', err));
  // A provider child cannot survive a server restart. Make interrupted
  // Three.js generations retryable; this is state recovery only, never a
  // cold-bootstrap provider call.
  recoverInterruptedThreejsModels().catch(err => logBootstrapFailure('❌ Three.js model recovery failed', err));
  recoverInterruptedImageTo3dModels().catch(err => logBootstrapFailure('❌ Image-to-3D model recovery failed', err));
  recoverInterruptedBlenderModels().catch(err => logBootstrapFailure('❌ Blender model recovery failed', err));
  startBackgroundSchedulers({ io, armHostedSessions });
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
    .catch(err => logBootstrapFailure('❌ Catalog user-type warm failed', err));
  // Initialize Telegram (manual bot or MCP bridge based on settings)
  getInitSettings().then(s => {
    if (s.telegram?.method === 'mcp-bridge') {
      telegramBridge.init().catch(err => logBootstrapFailure('❌ TG Bridge init failed', err));
    } else {
      telegram.init().catch(err => logBootstrapFailure('❌ Telegram init failed', err));
    }
  }).catch(err => logBootstrapFailure('❌ Telegram settings read failed', err));
  // Reconcile voice stack (start portos-whisper if voice.enabled)
  getVoiceConfig().then(cfg => reconcileVoice(cfg, { allowSetup: false })).catch(err => logBootstrapFailure('❌ Voice reconcile failed', err));
  // Re-arm any voice timers that survived a restart (independent of voice.enabled —
  // a pending reminder should still fire even if voice is currently off).
  initVoiceTimers().catch(err => logBootstrapFailure('❌ Voice timer init failed', err));
  // Check for update completion marker from a previous update cycle. The full
  // read/validate/record/cleanup lifecycle lives in updateChecker.js.
  processUpdateMarker().catch(err => logBootstrapFailure('❌ Update marker processing failed', err));

  // Clear stale updateInProgress if the server was killed mid-update
  clearStaleUpdateInProgress().catch(err => logBootstrapFailure('❌ Stale update recovery failed', err));

  // Capture the commit this process booted at, so /api/update/status can detect
  // a bare `git pull` that advanced on-disk HEAD without restarting (issue #1779).
  // Best-effort — a tarball/non-git install just yields no boot commit.
  captureBootCommit().catch(err => logBootstrapFailure('❌ Boot commit capture failed', err));

  // Start periodic update checker (checks GitHub releases every 30 min)
  startUpdateScheduler();

  // Restore any active loops from previous session
  restoreLoops().catch(err => logBootstrapFailure('❌ Loop restore failed', err));

  // One-time disk scan (no provider calls): file downloads already on this
  // machine into the shared "External" media collection.
  import('../externalMediaCollection.js')
    .then(m => m.backfillExternalMediaCollection())
    .catch(err => logBootstrapFailure('❌ External collection backfill failed', err));
};

/** Wire startup observers once the media queue has restored its persisted jobs. */
export const initMediaJobDependentHooks = () => {
  // These operate on the restored archive, catalog events and generator quota
  // events respectively. None can wait for a tagged media-queue completion.
  initSpriteLocalAnimationHook();
  initCatalogUniverseFiling();
  initImageGenQuotaHook();
  // Best-effort pre-materialize the MortalLoom iCloud store so the
  // dashboard's proactive-alerts poll (and other readers) don't trigger
  // on-demand downloads that surface as EAGAIN. `brctl download` only
  // materializes the file — it does not pin against future eviction, so
  // the retry-on-EAGAIN path inside the store is what guarantees the
  // hardening. Fire-and-forget — failures are logged.
  initMortalLoomStore().catch((err) => {
    logBootstrapFailure('⚠️ MortalLoom store init failed', err, console.warn);
  });
};
