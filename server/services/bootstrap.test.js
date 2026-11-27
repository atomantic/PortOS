import { recordingOperatorIo } from '../test/recordingOperatorIo.js';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CATEGORIES } from '../lib/aiToolkit/errorDetection.js';
import { errorEvents } from '../lib/errorHandler.js';
import { __createManualClock, createEventLoopLagProbe } from '../lib/eventLoopLagProbe.js';
import { isHostShuttingDown, resetHostShutdownFlagForTests } from '../lib/hostShutdown.js';
import { activeAgents, dispatchingAgentIds, dropRunnerAgent, trackRunnerAgent } from './agent/agentState.js';
import { bootstrapServices, registerShutdownHandlers, runBootSequence } from './bootstrap.js';
import { resetSystemActivityNotifyForTests } from './systemActivityNotify.js';

// Replace leaf effects only. Both bootstrap modules, signal handling, and HTTP
// drain logic run as shipped, with no writes, child processes, or network I/O.
const { asyncNoop, noop, steps, providerCalls, collectionStore } = vi.hoisted(() => {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    asyncNoop,
    noop,
    collectionStore: () => ({ listIds: asyncNoop, listWorkIds: asyncNoop }),
    steps: {
      applyMigrations: vi.fn(asyncNoop),
      initializeDrafts: vi.fn(asyncNoop),
      createToolkit: vi.fn(),
      loadUsage: vi.fn(asyncNoop),
      initSpawner: vi.fn(asyncNoop),
      initCos: vi.fn(asyncNoop),
      initAutoFixer: vi.fn(),
      initLocalProvider: vi.fn(asyncNoop),
      openCredentialSession: vi.fn(),
      ensureSelf: vi.fn(asyncNoop),
      initSyncLog: vi.fn(asyncNoop),
      recoverClones: vi.fn(asyncNoop),
      initMediaQueue: vi.fn(asyncNoop),
      initImageQuotaHook: vi.fn(),
      resumeMediaCompletions: vi.fn(),
      initSharing: vi.fn(asyncNoop),
      checkHealth: vi.fn(async () => ({ connected: true, hasSchema: true, hasCatalogSchema: true })),
      migrateDb: vi.fn(asyncNoop),
      pruneLegacyFiles: vi.fn(asyncNoop),
      initProviderGraph: vi.fn(asyncNoop),
      bindPeerExecutionIo: vi.fn(),
      setupProcessErrors: vi.fn(),
      backfillOrigin: vi.fn(asyncNoop),
      reconcileAssetIndex: vi.fn(asyncNoop),
      recoverInterruptedRuns: vi.fn(async () => ({ recovered: 0 })),
      relayBrain: vi.fn(asyncNoop),
      startPolling: vi.fn(),
      initSyncOrchestrator: vi.fn(),
      startBrainScheduler: vi.fn(),
      startHostedSessions: vi.fn(),
      stopHostedSessions: vi.fn(),
      stopHarnessRecovery: vi.fn(),
      stopUpdateRecovery: vi.fn(),
      writeMarker: vi.fn(asyncNoop),
      stopTailcatForwards: vi.fn(asyncNoop),
      stopModelHost: vi.fn(asyncNoop),
      stopJevSidecar: vi.fn(),
      drainJevSidecarStops: vi.fn(asyncNoop),
      stopMediaCapture: vi.fn(),
      drainMediaCaptureStops: vi.fn(asyncNoop),
      signalDetachedGroups: vi.fn(),
      quiesceMedia: vi.fn(),
      quiesceScheduled: vi.fn(),
      drainScheduled: vi.fn(asyncNoop),
      flushIdeaLoom: vi.fn(asyncNoop),
      flushCatalogFiling: vi.fn(asyncNoop),
      flushMedia: vi.fn(async () => ({ ok: true })),
      quiesceSharing: vi.fn(),
      drainPeerSync: vi.fn(asyncNoop),
      shutdownSharing: vi.fn(),
      flushUsage: vi.fn(asyncNoop),
      flushSettingsLedger: vi.fn(asyncNoop),
      stopUsageBackfill: vi.fn(asyncNoop),
      closeDb: vi.fn(asyncNoop),
    },
    providerCalls: {
      runStagedLLM: vi.fn(asyncNoop),
      runInlineLLM: vi.fn(asyncNoop),
      runStageScopedInlineLLM: vi.fn(asyncNoop),
      runPromptThroughProvider: vi.fn(asyncNoop),
      createRun: vi.fn(asyncNoop),
      executeApiRun: vi.fn(asyncNoop),
      executeCliRun: vi.fn(asyncNoop),
      executeTuiRun: vi.fn(asyncNoop),
    },
  };
});

vi.mock('../../scripts/run-migrations.js', () => ({ runMigrations: steps.applyMigrations }));
vi.mock('../lib/errorHandler.js', async (original) => ({
  ...await original(), setupProcessErrorHandlers: steps.setupProcessErrors,
}));
vi.mock('../lib/aiToolkit/index.js', () => ({ createAIToolkit: steps.createToolkit }));
vi.mock('../lib/collectionStore.js', () => ({ verifyCollectionVersions: asyncNoop }));
vi.mock('../lib/conflictJournal.js', () => ({ conflictJournalStore: collectionStore }));
vi.mock('../lib/managedDaemon.js', () => ({ startIdleReaper: noop, stopIdleReaper: noop }));
vi.mock('../lib/npmGlobalBin.js', () => ({ adoptNpmGlobalBinDir: asyncNoop }));
vi.mock('../lib/hostShutdown.js', async (original) => ({
  ...await original(), writeHostShutdownMarker: steps.writeMarker,
}));
vi.mock('../lib/credentialBootstrap.js', () => ({ signalDetachedGroups: steps.signalDetachedGroups }));
vi.mock('../lib/buildIdentity.js', () => ({
  getBuildIdentity: asyncNoop, getCachedBuildIdentity: () => ({ shortCommit: 'abcdef0' }), formatBuildIdentity: () => 'abcdef0',
}));
vi.mock('../lib/db.js', () => ({ checkHealth: steps.checkHealth, ensureSchema: asyncNoop, close: steps.closeDb }));
vi.mock('../lib/pgFileFacade.js', () => ({ isFileBackend: () => false }));
vi.mock('../lib/portosEnv.js', () => ({ readPortosEnvValue: () => undefined }));
vi.mock('../lib/detachedSpawn.js', () => ({ sweepQuiescentWriters: async () => ({ retired: 0 }) }));

vi.mock('./maintenanceControl.js', () => ({ bindMaintenanceIo: noop }));
vi.mock('./localLlm.js', () => ({
  bindLocalLlmIo: noop, ensureBackendProvider: steps.initLocalProvider, getBackend: () => 'ollama',
}));
vi.mock('./ollamaManager.js', () => ({ ensureRunning: asyncNoop }));
vi.mock('./provider/providerExecutionReadiness.js', () => ({ ensureProviderReadyForExecution: asyncNoop }));
vi.mock('./provider/credentialPoolRuntime.js', () => ({ openCredentialSession: steps.openCredentialSession }));
vi.mock('./usage.js', () => ({ loadUsage: steps.loadUsage, recordSession: asyncNoop, flushPendingUsageWrites: steps.flushUsage }));
vi.mock('./usageBackfill.js', () => ({ stopHistoricalUsageBackfill: steps.stopUsageBackfill }));
vi.mock('./usageReconciler.js', () => ({ recordCompletedRunUsage: asyncNoop }));
vi.mock('./provider/providers.js', () => ({ setAIToolkit: noop }));
vi.mock('./provider/providerStatus.js', () => ({ setAIToolkit: noop }));
vi.mock('./runner.js', () => ({
  setAIToolkit: noop, serializeRunDeletion: fn => fn,
  createRun: providerCalls.createRun, executeApiRun: providerCalls.executeApiRun, executeCliRun: providerCalls.executeCliRun,
}));
vi.mock('./tuiPromptRunner.js', () => ({ executeTuiRun: providerCalls.executeTuiRun }));
vi.mock('./stageRunner.js', () => ({
  runStagedLLM: providerCalls.runStagedLLM, runInlineLLM: providerCalls.runInlineLLM,
  runStageScopedInlineLLM: providerCalls.runStageScopedInlineLLM,
}));
vi.mock('./promptRunner.js', () => ({ runPromptThroughProvider: providerCalls.runPromptThroughProvider }));
vi.mock('./promptService.js', () => ({ setAIToolkit: noop }));
vi.mock('./autoFixer.js', () => ({ initAutoFixer: steps.initAutoFixer }));
vi.mock('./taskLearning.js', () => ({ initTaskLearning: noop }));
vi.mock('./subAgentSpawner.js', () => ({ initSpawner: steps.initSpawner }));
vi.mock('./certRenewer.js', () => ({ initCertRenewer: noop }));
vi.mock('./cos/cos.js', () => ({ init: steps.initCos }));
vi.mock('./cos/cosState.js', () => ({ markCosAgentMigrationsSettled: noop }));
vi.mock('./deadOwnerReservations.js', () => ({ reconcileDeadOwnerReservations: noop }));
vi.mock('./harnessActionRecovery.js', () => ({ startHarnessActionRecovery: noop, stopHarnessActionRecovery: steps.stopHarnessRecovery }));
vi.mock('./automaticUpdateReservationRecovery.js', () => ({
  startAutomaticUpdateReservationRecovery: noop, stopAutomaticUpdateReservationRecovery: steps.stopUpdateRecovery,
}));
vi.mock('./bootHooks.js', async () => {
  const { registerMediaJobTerminalHooks, registerMusicVideoRecovery } = await import('./bootHookRegistry.js');
  return {
    registerBootHooks() {
      registerMediaJobTerminalHooks([]);
      registerMusicVideoRecovery({ recoverRenders: asyncNoop, recoverExcerpts: asyncNoop });
    },
  };
});
vi.mock('./agent/agentKey.js', () => ({ initAgentKey: asyncNoop }));
vi.mock('./eidoverseRuntime.js', () => ({ reconcileEidoverseRuntime: async () => ({ running: false }) }));
vi.mock('./dockerContainment.js', () => ({ reconcileDockerContainment: asyncNoop }));
vi.mock('./instanceFeatures.js', () => ({ isInstanceFeatureEnabled: async () => false }));
vi.mock('./codeAnimation/execution.js', () => ({ rearmCodeAnimationExecution: asyncNoop }));
vi.mock('./automationScheduler.js', () => ({ init: asyncNoop }));
vi.mock('./agent/agentActionExecutor.js', () => ({ init: noop }));
vi.mock('./eventScheduler.js', () => ({ quiesce: steps.quiesceScheduled, drain: steps.drainScheduled }));
vi.mock('./settings.js', () => ({ getSettings: async () => ({}), flushSettingsLedger: steps.flushSettingsLedger }));
vi.mock('./jev.js', () => ({
  stopJevSidecar: steps.stopJevSidecar, drainJevSidecarStops: steps.drainJevSidecarStops,
}));
vi.mock('./mediaService.js', () => ({
  default: { stopAll: steps.stopMediaCapture, drainCaptureStops: steps.drainMediaCaptureStops },
}));
vi.mock('./catalogUserTypes/store.js', () => ({ readUserTypes: async () => [] }));
vi.mock('./telegram.js', () => ({ init: asyncNoop }));
vi.mock('./telegramBridge.js', () => ({ init: asyncNoop }));
vi.mock('./voice/config.js', () => ({ getVoiceConfig: async () => ({}) }));
vi.mock('./voice/bootstrap.js', () => ({ reconcile: asyncNoop }));
vi.mock('./voice/timers.js', () => ({ initVoiceTimers: asyncNoop }));
vi.mock('./backupScheduler.js', () => ({ startBackupScheduler: asyncNoop }));
vi.mock('./autoUpdateScheduler.js', () => ({ startAutoUpdateScheduler: asyncNoop }));
vi.mock('./privacyRecheckScheduler.js', () => ({ startPrivacyRecheckScheduler: asyncNoop }));
vi.mock('./quotaBurnRunner.js', () => ({ startQuotaBurnScheduler: noop }));
vi.mock('./maintenanceRun.js', () => ({ startMaintenanceRunScheduler: noop }));
vi.mock('./githubNotificationResolveTask.js', () => ({ startNotificationResolveListener: noop }));
vi.mock('./seriesAutopilotScheduler.js', () => ({ startSeriesAutopilotScheduler: asyncNoop }));
vi.mock('./creativeCommissions/scheduler.js', () => ({ startCommissionScheduler: asyncNoop }));
vi.mock('./beeper/beeperScheduler.js', () => ({ startBeeperScheduler: asyncNoop }));
vi.mock('./beeper/beeperSocket.js', () => ({ startBeeperSocket: asyncNoop, stopBeeperSocket: noop }));
vi.mock('./beeper/beeperOutbox.js', () => ({ reconcileOutboxOnBoot: asyncNoop }));
vi.mock('./eidoverseControllerRuntime.js', () => ({ startEidoverseControllerSupervisor: asyncNoop }));
vi.mock('./imessageScheduler.js', () => ({ startImessageScheduler: asyncNoop }));
vi.mock('./signalScheduler.js', () => ({ startSignalScheduler: asyncNoop }));
vi.mock('./spotifyScheduler.js', () => ({ startSpotifyScheduler: asyncNoop }));
vi.mock('./youtubeScheduler.js', () => ({ startYoutubeScheduler: asyncNoop }));
vi.mock('./stackerNewsScheduler.js', () => ({ reconcileStackerNewsSchedulers: asyncNoop }));
vi.mock('./activityDigestScheduler.js', () => ({ startActivityDigestScheduler: noop }));
vi.mock('./twinEnrichmentScheduler.js', () => ({ startTwinEnrichmentScheduler: noop }));
vi.mock('./updateChecker.js', () => ({
  startUpdateScheduler: noop, clearStaleUpdateInProgress: asyncNoop, processUpdateMarker: asyncNoop,
}));
vi.mock('./installState.js', () => ({ captureBootCommit: asyncNoop }));
vi.mock('./loops.js', () => ({ restoreLoops: asyncNoop }));
vi.mock('./importerOrphanGc.js', () => ({ startOrphanShellGc: noop }));
vi.mock('./imageRefsGc.js', () => ({ startImageRefsGc: noop }));
vi.mock('./imageCleanTmpGc.js', () => ({ startImageCleanTmpGc: noop }));
vi.mock('./orphanedPartialGc.js', () => ({ startOrphanedPartialGc: noop }));
vi.mock('./beeper/beeperAttachmentGc.js', () => ({ startBeeperAttachmentGc: noop }));
vi.mock('./tribePurge.js', () => ({ startTribePurge: noop }));
vi.mock('./screenshotsGc.js', () => ({ startScreenshotsGc: noop }));
vi.mock('./brainMemoryBridge.js', () => ({ initBridge: noop, replayPersistedResync: asyncNoop }));
vi.mock('./idealoomAutoSync.js', () => ({ flushAutoSync: steps.flushIdeaLoom }));
vi.mock('./meatspace/meatspacePostDrillCache.js', () => ({ initDrillCache: asyncNoop }));
vi.mock('./meatspace/meatspacePostReminder.js', () => ({ registerPostReminderSchedule: asyncNoop }));
vi.mock('./autobiographyReminder.js', () => ({ registerAutobiographyReminderSchedule: asyncNoop }));
vi.mock('./brain.js', () => ({ recoverInterruptedRepoClones: steps.recoverClones, recoverStuckClassifications: asyncNoop }));
vi.mock('./writersRoom/analysisSnapshots.js', () => ({ recoverStuckAnalyses: asyncNoop }));
vi.mock('./pipeline/recovery.js', () => ({
  recoverStuckGeneratingStages: asyncNoop, recoverStuckAutoRuns: asyncNoop, recoverStuckAutopilots: asyncNoop,
}));
vi.mock('./creativeDirector/recovery.js', () => ({ recoverInFlightProjects: asyncNoop }));
vi.mock('./creativeDirector/local.js', () => ({ listProjects: asyncNoop }));
vi.mock('./modelRecovery.js', () => ({
  recoverInterruptedBlenderModels: asyncNoop, recoverInterruptedImageTo3dModels: asyncNoop, recoverInterruptedThreejsModels: asyncNoop,
}));
vi.mock('./instances.js', () => ({ startPolling: steps.startPolling, getPeers: async () => [] }));
vi.mock('./instanceIdentity.js', () => ({ ensureSelf: steps.ensureSelf }));
vi.mock('./brainSyncLog.js', () => ({ initSyncLog: steps.initSyncLog }));
vi.mock('./brainStorage.js', () => ({ backfillOriginInstanceId: steps.backfillOrigin, brainCollectionStores: () => [] }));
vi.mock('./brainReconcile.js', () => ({ relayUnloggedRecords: steps.relayBrain }));
vi.mock('./mediaJobQueue/index.js', () => ({
  initMediaJobQueue: steps.initMediaQueue, resumeMediaJobCompletions: steps.resumeMediaCompletions,
  flushMediaJobQueue: steps.flushMedia, quiesceMediaJobQueue: steps.quiesceMedia,
}));
vi.mock('./sprites/localAnimationJobHook.js', () => ({ initSpriteLocalAnimationHook: noop }));
vi.mock('./sharing/index.js', () => ({
  initSharing: steps.initSharing, quiesceSharingForExit: steps.quiesceSharing,
  drainPeerSyncOperations: steps.drainPeerSync, shutdownSharing: steps.shutdownSharing,
}));
vi.mock('./mortalLoomStore.js', () => ({ initMortalLoomStore: asyncNoop }));
vi.mock('./catalog/catalogUniverseFiling.js', () => ({ initCatalogUniverseFiling: noop, flushCatalogUniverseFiling: steps.flushCatalogFiling }));
vi.mock('./fableLoom/hostedSession.js', () => ({ startHostedSessionSweep: steps.startHostedSessions, stopHostedSessionSweep: steps.stopHostedSessions }));
vi.mock('./imageGenQuota.js', () => ({ initImageGenQuotaHook: steps.initImageQuotaHook }));
vi.mock('./universeBuilder.js', () => ({ universeStore: collectionStore }));
vi.mock('./pipeline/series.js', () => ({ seriesStore: collectionStore }));
vi.mock('./pipeline/issues.js', () => ({ issueStore: collectionStore }));
vi.mock('./storyBuilder.js', () => ({ storyBuilderStore: collectionStore }));
vi.mock('./writersRoom/store.js', () => ({ writersRoomStore: collectionStore }));
vi.mock('./mediaCollections.js', () => ({ mediaCollectionStore: collectionStore }));
vi.mock('./rapidReaderLibrary.js', () => ({ rapidReaderLibraryStore: {} }));
vi.mock('./creativeCommissions/store.js', () => ({ commissionStore: collectionStore, backfillAllCommissionFeedback: asyncNoop }));
vi.mock('./creativeCommissions/projectControl.js', () => ({ backfillProjectCommissionIds: asyncNoop }));
vi.mock('./layeredIntelligenceOutcomes.js', () => ({ outcomesStore: collectionStore }));
vi.mock('./games/store.js', () => ({}));
vi.mock('./fableLoom/store.js', () => ({}));
vi.mock('./provider/providerPrerequisites.js', () => ({ prerequisitesMetForRouting: () => true }));
vi.mock('./provider/providerFallbackChain.js', () => ({ initFallbackChain: asyncNoop }));
vi.mock('./provider/providerGraph.js', () => ({ onProvidersSaved: asyncNoop, initProviderGraph: steps.initProviderGraph }));
vi.mock('./modelPinAuditNotifier.js', () => ({ reportRetiredModelPins: asyncNoop }));
vi.mock('./localCachedModels.js', () => ({ localCachedModelIds: () => null }));
vi.mock('./codexAppServer.js', () => ({ stopCodexAppServer: asyncNoop }));
vi.mock('./messageDrafts.js', () => ({ initializeMessageDrafts: steps.initializeDrafts }));
vi.mock('./imageGen/imageRecords.js', () => ({ initImageOriginStamping: asyncNoop }));
vi.mock('./externalMediaCollection.js', () => ({ backfillExternalMediaCollection: asyncNoop }));
vi.mock('./storyboards/make.js', () => ({ recoverInterruptedStoryboardNodes: asyncNoop }));
vi.mock('./harnessEnablement.js', () => ({ reconcileHarnessEnablement: asyncNoop }));
vi.mock('./peerExecutionRuntime.js', () => ({ bindPeerExecutionIo: steps.bindPeerExecutionIo, initializePeerExecution: asyncNoop }));
vi.mock('./interruptedRunRecovery.js', () => ({ recoverInterruptedRuns: steps.recoverInterruptedRuns }));
vi.mock('./tailcatPeer.js', () => ({ restoreForwards: asyncNoop, stopAllForwards: steps.stopTailcatForwards }));
vi.mock('./tailcatServe.js', () => ({ restoreServe: asyncNoop, stopServeProcess: asyncNoop }));
vi.mock('./tailcatIngress.js', () => ({ stopTailcatIngress: asyncNoop }));
vi.mock('./fleetLlmHost.js', () => ({ stopFleetLlmHost: steps.stopModelHost }));
vi.mock('./syncOrchestrator.js', () => ({ initSyncOrchestrator: steps.initSyncOrchestrator }));
vi.mock('./mediaRemoteDelete.js', () => ({ initMediaRemoteDelete: asyncNoop }));
vi.mock('./mediaHolders.js', () => ({ initMediaHolders: asyncNoop }));
vi.mock('./brainScheduler.js', () => ({ startBrainScheduler: steps.startBrainScheduler }));
vi.mock('./mediaAssetIndex/index.js', () => ({ initMediaAssetIndex: asyncNoop, reconcileMediaAssetIndexAtBoot: steps.reconcileAssetIndex }));
vi.mock('../scripts/run-db-migrations.js', () => ({ runDbMigrations: steps.migrateDb }));
vi.mock('../scripts/migrateBibleToCatalog.js', () => ({ migrateBibleToCatalog: asyncNoop }));
vi.mock('../scripts/repairUniverseTags.js', () => ({ repairUniverseTags: asyncNoop }));
vi.mock('../scripts/migrateCatalogPayload.js', () => ({ migrateCatalogPayload: asyncNoop }));
vi.mock('../scripts/reconcileCanonCatalog.js', () => ({ reconcileCanonCatalog: asyncNoop }));
vi.mock('../scripts/pruneImportedLegacyFiles.js', () => ({ pruneImportedLegacyFiles: steps.pruneLegacyFiles }));
vi.mock('../scripts/backfillSeriesCoverImages.js', () => ({ backfillSeriesCoverImages: asyncNoop }));

const paths = {
  dataDir: '/fixture/data', dataReferenceDir: '/fixture/data.reference', serverDir: '/fixture/server',
};

const createToolkit = () => ({
  services: {
    providers: { getAllProviders: vi.fn(async () => []) },
    runner: {
      ...providerCalls, deleteRun: vi.fn(), setCliRunner: vi.fn(), setTuiRunner: vi.fn(),
    },
  },
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('PORTOS_SMOKE_BOOT', '0');
  vi.spyOn(console, 'log').mockImplementation(noop);
  vi.spyOn(console, 'warn').mockImplementation(noop);
  vi.spyOn(console, 'error').mockImplementation(noop);
  steps.createToolkit.mockImplementation(createToolkit);
});

afterEach(async () => {
  await vi.dynamicImportSettled();
  resetSystemActivityNotifyForTests();
  resetHostShutdownFlagForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('pre-route bootstrap', () => {
  it.skipIf(process.platform === 'win32')('tightens both legacy secret stores during pre-route boot', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'portos-bootstrap-permissions-'));
    const files = ['settings.json', 'managed-visitor-credentials.json'].map(file => join(dataDir, file));
    try {
      for (const file of files) {
        await writeFile(file, '{}');
        await chmod(file, 0o644);
      }

      const { spawnerReady } = await bootstrapServices({ ...paths, dataDir, io: {} });
      await spawnerReady;
      for (const file of files) {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(await readFile(file, 'utf8')).toBe('{}');
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses to create the toolkit when smoke migrations fail', async () => {
    vi.stubEnv('PORTOS_SMOKE_BOOT', '1');
    steps.applyMigrations.mockRejectedValueOnce(new Error('fixture migration failed'));
    const exited = Promise.withResolvers();
    // A real process exit never returns to the boot sequence.
    const exit = vi.fn((code) => {
      exited.resolve(code);
      return new Promise(noop);
    });

    const starting = bootstrapServices({ ...paths, io: {} }, { exit });
    await expect(Promise.race([starting, exited.promise])).resolves.toBe(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('fixture migration failed'));
    expect(steps.initializeDrafts).not.toHaveBeenCalled();
    expect(steps.loadUsage).not.toHaveBeenCalled();
    expect(steps.createToolkit).not.toHaveBeenCalled();
  });

  it('logs a normal migration failure and still warms providers and registers runners', async () => {
    steps.applyMigrations.mockRejectedValueOnce(new Error('fixture migration failed'));
    const exit = vi.fn();
    const { aiToolkit, spawnerReady } = await bootstrapServices({ ...paths, io: {} }, { exit });
    await spawnerReady;

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Migration run failed at startup'));
    expect(exit).not.toHaveBeenCalled();
    expect(steps.initializeDrafts).not.toHaveBeenCalled();
    expect(steps.applyMigrations).toHaveBeenCalledBefore(steps.loadUsage);
    expect(steps.loadUsage).toHaveBeenCalledBefore(steps.createToolkit);
    expect(aiToolkit.services.providers.getAllProviders).toHaveBeenCalledOnce();
    expect(aiToolkit.services.runner.setCliRunner).toHaveBeenCalledExactlyOnceWith(providerCalls.executeCliRun);
    expect(aiToolkit.services.runner.setTuiRunner).toHaveBeenCalledExactlyOnceWith(providerCalls.executeTuiRun);
    expect(aiToolkit.services.runner.setTuiRunner).toHaveBeenCalledBefore(steps.initSpawner);
  });

  it.each([
    [ERROR_CATEGORIES.RUNTIME_BUDGET_EXHAUSTED, 'AI_RUNTIME_BUDGET_EXHAUSTED', 'Run failed'],
    [ERROR_CATEGORIES.OUTPUT_LIMIT, 'AI_OUTPUT_LIMIT_EXCEEDED', 'Run failed'],
    [ERROR_CATEGORIES.CONTENT_REFUSAL, 'AI_PROVIDER_CONTENT_REFUSED',
      'Example CLI declined this prompt on content/safety grounds — stopped without automatic retry or provider fallback.'],
    [ERROR_CATEGORIES.IMAGE_UNSUPPORTED, 'AI_PROVIDER_IMAGE_UNSUPPORTED', 'Run failed'],
    [undefined, 'AI_PROVIDER_EXECUTION_FAILED', 'AI provider Example CLI execution failed: Run failed'],
  ])('classifies toolkit failures with category %s', async (category, code, message) => {
    await bootstrapServices({ ...paths, io: {} });
    const [{ hooks }] = steps.createToolkit.mock.calls[0];
    const observed = vi.fn();
    const metadata = {
      id: 'run-example', providerName: 'Example CLI', providerId: 'example-cli', model: 'example-model',
      errorAnalysis: category && { category }, timeoutBound: 'absolute', timeoutOrigin: 'caller-budget',
      runtimeBudgetMs: 120000, promptPreview: 'private prompt', outputTail: 'private output',
    };
    errorEvents.once('error', observed);
    try {
      hooks.onRunFailed(metadata, new Error('Run failed'));
      expect(observed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        code, message, severity: category ? 'warning' : 'error', canAutoFix: !category,
        context: expect.objectContaining({
          runId: metadata.id, providerId: metadata.providerId, model: metadata.model,
          errorDetails: 'Run failed', errorAnalysis: metadata.errorAnalysis, timeoutOrigin: 'caller-budget', runtimeBudgetMs: 120000,
        }),
      }));
      const [{ context }] = observed.mock.calls[0];
      expect(context).not.toHaveProperty('promptPreview');
      expect(context).not.toHaveProperty('outputTail');
    } finally {
      errorEvents.off('error', observed);
    }
  });

  it('opens a credential session only on demand and forwards its provider, model, and result', async () => {
    const io = recordingOperatorIo();
    const provider = { id: 'example-cli' };
    const session = { close: vi.fn() };
    steps.openCredentialSession.mockResolvedValueOnce(session);
    await bootstrapServices({ ...paths, io });
    const [{ emit, hooks }] = steps.createToolkit.mock.calls[0];

    expect(steps.openCredentialSession).not.toHaveBeenCalled();
    emit('provider:status:changed', { providerId: provider.id });
    expect(io.emit).toHaveBeenCalledExactlyOnceWith('provider:status:changed', { providerId: provider.id });
    await expect(hooks.openCredentialSession(provider, 'example-model')).resolves.toBe(session);
    expect(steps.openCredentialSession).toHaveBeenCalledExactlyOnceWith(provider, 'example-model');
  });
});

describe('boot wiring', () => {
  it.each([false, true])('runs the boot phases without dispatching a provider call (smoke=%s)', async (smokeBoot) => {
    vi.stubEnv('PORTOS_SMOKE_BOOT', smokeBoot ? '1' : '0');
    const spawner = Promise.withResolvers();
    steps.initSpawner.mockReturnValueOnce(spawner.promise);
    const io = {};
    const onFatal = vi.fn();
    const { aiToolkit, spawnerReady } = await bootstrapServices({ ...paths, io });
    const httpServer = {
      address: () => ({ port: 12345 }),
      listen: vi.fn(),
    };

    await runBootSequence({ io, httpServer, port: 0, host: '127.0.0.1', spawnerReady }, { onFatal });
    expect(onFatal).not.toHaveBeenCalled();
    expect(httpServer.listen).toHaveBeenCalledExactlyOnceWith(0, '127.0.0.1', expect.any(Function));
    expect(steps.setupProcessErrors).not.toHaveBeenCalled();
    await httpServer.listen.mock.calls[0][2]();
    expect(steps.initCos).not.toHaveBeenCalled();
    spawner.resolve();
    await spawnerReady;
    await vi.dynamicImportSettled();

    expect(steps.applyMigrations).toHaveBeenCalledBefore(steps.initializeDrafts);
    expect(steps.ensureSelf).toHaveBeenCalledBefore(steps.initSyncLog);
    expect(steps.initMediaQueue).toHaveBeenCalledExactlyOnceWith({
      deferCompletionRecovery: true, prepareTerminalHooks: expect.any(Function),
    });
    expect(steps.initMediaQueue).toHaveBeenCalledBefore(steps.initImageQuotaHook);
    expect(steps.initImageQuotaHook).toHaveBeenCalledBefore(steps.resumeMediaCompletions);
    expect(steps.checkHealth).toHaveBeenCalledBefore(steps.migrateDb);
    expect(steps.migrateDb).toHaveBeenCalledBefore(steps.pruneLegacyFiles);
    expect(steps.pruneLegacyFiles).toHaveBeenCalledBefore(steps.initProviderGraph);
    expect(steps.initProviderGraph).toHaveBeenCalledBefore(httpServer.listen);
    expect(steps.bindPeerExecutionIo).toHaveBeenCalledExactlyOnceWith(io);
    expect(httpServer.listen).toHaveBeenCalledBefore(steps.setupProcessErrors);
    expect(steps.setupProcessErrors).toHaveBeenCalledExactlyOnceWith(io);
    expect(steps.setupProcessErrors).toHaveBeenCalledBefore(steps.backfillOrigin);
    const gated = [
      steps.initLocalProvider, steps.initAutoFixer, steps.initSpawner, steps.initCos, steps.startHostedSessions,
      steps.recoverClones, steps.initSharing, steps.relayBrain, steps.startPolling, steps.initSyncOrchestrator, steps.startBrainScheduler,
    ];
    if (smokeBoot) {
      for (const step of gated) expect(step).not.toHaveBeenCalled();
    } else {
      for (const step of gated) expect(step).toHaveBeenCalledOnce();
      expect(steps.startHostedSessions).toHaveBeenCalledExactlyOnceWith({ io });
      expect(steps.initSharing).toHaveBeenCalledExactlyOnceWith({ io });
      expect(steps.backfillOrigin).toHaveBeenCalledBefore(steps.startPolling);
    }

    expect(aiToolkit.services.providers.getAllProviders).toHaveBeenCalledOnce();
    for (const call of [...Object.values(providerCalls), steps.openCredentialSession]) expect(call).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports a fatal pre-listen failure through the injected boot dependencies', async () => {
    const io = {};
    const httpServer = { listen: vi.fn() };
    const { spawnerReady } = await bootstrapServices({ ...paths, io });
    const armHostedSessions = vi.fn();
    const onFatal = vi.fn();
    steps.ensureSelf.mockRejectedValueOnce(new Error('fixture identity failure'));

    await runBootSequence({ io, httpServer, spawnerReady }, { onFatal, backgroundDependencies: { armHostedSessions } });

    expect(armHostedSessions).toHaveBeenCalledExactlyOnceWith({ io });
    expect(steps.startHostedSessions).not.toHaveBeenCalled();
    expect(onFatal).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('fixture identity failure'));
    expect(httpServer.listen).not.toHaveBeenCalled();
  });
});

const createServer = () => Object.assign(new EventEmitter(), {
  close: vi.fn(done => done()),
  closeAllConnections: vi.fn(),
});

const registerTestShutdown = ({
  httpServer = createServer(), localHttpServer = createServer(), io = { close: vi.fn(done => done()) }, createLagProbe,
} = {}) => {
  const hostProcess = Object.assign(new EventEmitter(), { exit: vi.fn(), env: {}, stdin: {}, pid: 1, ppid: 2 });
  registerShutdownHandlers({ io, httpServer, localHttpServer }, { hostProcess, createLagProbe });
  expect(hostProcess.listenerCount('SIGTERM')).toBe(1);
  expect(hostProcess.listenerCount('SIGINT')).toBe(1);
  return {
    httpServer, localHttpServer, io, exit: hostProcess.exit,
    signal: (signal = 'SIGTERM') => hostProcess.listeners(signal)[0](),
  };
};

const hold = (step) => {
  const entered = Promise.withResolvers();
  const pending = Promise.withResolvers();
  step.mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  return { entered: entered.promise, release: pending.resolve };
};

const slowShutdownLogs = () => console.log.mock.calls.map(([line]) => line)
  .filter(line => line.startsWith('🐢 Graceful shutdown slow'));

describe('signal-driven shutdown', () => {
  beforeEach(() => vi.useFakeTimers());

  it('latches immediately, snapshots owned agents, and disarms background work before any await', async () => {
    const forwards = hold(steps.stopTailcatForwards);
    const marker = hold(steps.writeMarker);
    const db = hold(steps.closeDb);
    const { signal, exit, httpServer, localHttpServer } = registerTestShutdown();
    expect(isHostShuttingDown()).toBe(false);
    activeAgents.set('active-agent', {});
    dispatchingAgentIds.add('initializing-agent');
    trackRunnerAgent('adopted-agent', {});
    try {
      const stopping = signal();
      expect(isHostShuttingDown()).toBe(true);
      expect(httpServer.close).toHaveBeenCalledOnce();
      expect(localHttpServer.close).toHaveBeenCalledOnce();
      expect(steps.quiesceMedia).toHaveBeenCalledOnce();
      expect(steps.quiesceScheduled).toHaveBeenCalledBefore(steps.drainScheduled);
      expect(steps.stopUsageBackfill).toHaveBeenCalledOnce();
      expect(steps.writeMarker).toHaveBeenCalledExactlyOnceWith({
        agentIds: ['active-agent', 'initializing-agent'], signal: 'SIGTERM',
      });
      for (const stop of [steps.stopHostedSessions, steps.stopHarnessRecovery, steps.stopUpdateRecovery]) {
        expect(stop).toHaveBeenCalledOnce();
      }
      await signal('SIGINT');
      expect(steps.writeMarker).toHaveBeenCalledOnce();
      await forwards.entered;
      forwards.release();
      await db.entered;
      expect(exit).not.toHaveBeenCalled();
      expect(steps.signalDetachedGroups).toHaveBeenCalledExactlyOnceWith('SIGTERM', expect.any(Function));
      expect(steps.signalDetachedGroups).toHaveBeenCalledBefore(httpServer.closeAllConnections);
      db.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).not.toHaveBeenCalled();
      marker.release();
      await stopping;
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
      activeAgents.delete('active-agent');
      dispatchingAgentIds.delete('initializing-agent');
      dropRunnerAgent('adopted-agent');
    }
  });

  it('forces exit at ten seconds even if the first teardown is stalled', async () => {
    const forwards = hold(steps.stopTailcatForwards);
    const clock = __createManualClock();
    const { signal, exit } = registerTestShutdown({ createLagProbe: () => createEventLoopLagProbe({ clock }) });
    const stopping = signal('SIGINT');
    try {
      await forwards.entered;
      clock.advance(9999);
      await vi.advanceTimersByTimeAsync(9999);
      expect(exit).not.toHaveBeenCalled();
      clock.advance(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(console.error).toHaveBeenCalledWith('⚠️ Graceful shutdown timed out, forcing exit');
      expect(console.log).toHaveBeenCalledBefore(exit);
      expect(slowShutdownLogs()).toEqual([expect.stringMatching(/totalMs=10000 slowestStep=tailcat /)]);
      expect(steps.writeMarker).toHaveBeenCalledWith({ agentIds: [], signal: 'SIGINT' });
    } finally {
      forwards.release();
      await stopping;
    }
  });

  it('keeps established requests alive through the drain window and bounds both HTTP closes', async () => {
    const { httpServer, localHttpServer, io, signal, exit } = registerTestShutdown();
    const dropped = { headersSent: false, getHeader: () => undefined, shouldKeepAlive: true };
    httpServer.emit('request', {}, Object.assign(new EventEmitter(), dropped));
    const completed = Object.assign(new EventEmitter(), dropped);
    localHttpServer.emit('request', {}, completed);

    let finishLate;
    httpServer.close.mockImplementationOnce(done => done()).mockImplementationOnce(done => { finishLate = done; });
    localHttpServer.close.mockImplementationOnce(done => done())
      .mockImplementationOnce(done => done({ code: 'ERR_SERVER_NOT_RUNNING' }));
    const forwards = hold(steps.stopTailcatForwards);
    const stopping = signal();
    try {
      await forwards.entered;
      forwards.release();
      await vi.dynamicImportSettled();
      expect(io.close).toHaveBeenCalledOnce();
      expect(httpServer.closeAllConnections).not.toHaveBeenCalled();
      expect(localHttpServer.closeAllConnections).not.toHaveBeenCalled();
      expect(completed.shouldKeepAlive).toBe(false);
      completed.emit('close');

      await vi.advanceTimersByTimeAsync(4999);
      expect(httpServer.closeAllConnections).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(httpServer.closeAllConnections).toHaveBeenCalledOnce();
      expect(httpServer.close).toHaveBeenCalledBefore(httpServer.closeAllConnections);
      expect(localHttpServer.closeAllConnections).toHaveBeenCalledOnce();
      expect(console.log).toHaveBeenCalledWith('⏱️ 1 request(s) still running after the 5000ms drain — closing them');
      expect(console.log).toHaveBeenCalledWith('✅ Local HTTP mirror closed');
      await vi.advanceTimersByTimeAsync(999);
      expect(steps.closeDb).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(console.log).toHaveBeenCalledWith('⏱️ HTTP server close exceeded 1000ms — proceeding');
      finishLate(new Error('late close failure'));
      expect(console.error).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
      forwards.release();
    }
  });

  it('continues after an HTTP close error and preserves the failure in diagnostic logs', async () => {
    const { signal, exit, httpServer } = registerTestShutdown();
    httpServer.close.mockImplementationOnce(done => done())
      .mockImplementationOnce(done => done(new Error('fixture close failed')));
    await signal();
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      '⚠️ Error closing HTTP server: fixture close failed', expect.stringContaining('Error: fixture close failed'),
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('signals owned capture and sidecar children before HTTP teardown and waits for escalation before exit', async () => {
    const sidecar = hold(steps.drainJevSidecarStops);
    const capture = hold(steps.drainMediaCaptureStops);
    const { signal, exit, io, httpServer } = registerTestShutdown();
    const stopping = signal();

    await Promise.all([sidecar.entered, capture.entered]);
    expect(steps.stopJevSidecar).toHaveBeenCalledBefore(io.close);
    expect(steps.stopMediaCapture).toHaveBeenCalledBefore(httpServer.closeAllConnections);
    expect(steps.closeDb).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    sidecar.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled();
    capture.release();
    await stopping;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each(['flushed', 'timed out'])('keeps the DB open until the settings ledger has %s', async (outcome) => {
    const settings = hold(steps.flushSettingsLedger);
    const { signal, exit, httpServer, localHttpServer } = registerTestShutdown();
    const stopping = signal();

    await settings.entered;
    expect(httpServer.closeAllConnections).toHaveBeenCalledBefore(steps.flushSettingsLedger);
    expect(localHttpServer.closeAllConnections).toHaveBeenCalledBefore(steps.flushSettingsLedger);
    await vi.advanceTimersByTimeAsync(1999);
    expect(steps.closeDb).not.toHaveBeenCalled();
    if (outcome === 'flushed') settings.release();
    else await vi.advanceTimersByTimeAsync(1);
    await stopping;
    settings.release();
    expect(steps.closeDb).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('drains scheduled events, catalog filing, and usage backfill before flushing usage and closing the DB', async () => {
    const scheduled = hold(steps.drainScheduled);
    const catalog = hold(steps.flushCatalogFiling);
    const usage = hold(steps.flushUsage);
    const backfill = hold(steps.stopUsageBackfill);
    const ideaLoom = hold(steps.flushIdeaLoom);
    const media = hold(steps.flushMedia);
    const peerSync = hold(steps.drainPeerSync);
    const { signal, exit, httpServer } = registerTestShutdown();
    const stopping = signal();

    await peerSync.entered;
    for (const flush of [steps.flushIdeaLoom, steps.flushCatalogFiling, steps.flushMedia]) {
      expect(flush).toHaveBeenCalledOnce();
      expect(httpServer.closeAllConnections).toHaveBeenCalledBefore(flush);
    }
    expect(steps.flushMedia).toHaveBeenCalledBefore(steps.quiesceSharing);
    expect(steps.writeMarker).toHaveBeenCalledBefore(steps.quiesceSharing);
    expect(steps.quiesceSharing).toHaveBeenCalledBefore(steps.drainPeerSync);
    expect(steps.shutdownSharing).not.toHaveBeenCalled();
    expect(steps.closeDb).not.toHaveBeenCalled();
    peerSync.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(steps.flushUsage).not.toHaveBeenCalled();
    scheduled.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(steps.flushUsage).not.toHaveBeenCalled();
    catalog.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(steps.flushUsage).not.toHaveBeenCalled();
    backfill.release();
    await usage.entered;
    expect(steps.closeDb).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    usage.release();
    await vi.dynamicImportSettled();
    expect(steps.closeDb).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    media.release({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled();
    ideaLoom.release();
    await stopping;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(slowShutdownLogs()).toEqual([]);
  });

  it('fits a stalled peer, request, HTTP close, and DB pool within the hard deadline', async () => {
    const clock = __createManualClock();
    const { signal, exit, httpServer } = registerTestShutdown({ createLagProbe: () => createEventLoopLagProbe({ clock }) });
    httpServer.emit('request', {}, Object.assign(new EventEmitter(), { getHeader: () => undefined }));
    httpServer.close.mockImplementationOnce(done => done()).mockImplementationOnce(noop);
    const modelHost = hold(steps.stopModelHost);
    const peerSync = hold(steps.drainPeerSync);
    const ideaLoom = hold(steps.flushIdeaLoom);
    const scheduled = hold(steps.drainScheduled);
    const db = hold(steps.closeDb);
    const stopping = signal();

    await modelHost.entered;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.dynamicImportSettled();
    expect(steps.signalDetachedGroups).toHaveBeenCalledOnce();
    expect(steps.closeDb).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    await peerSync.entered;
    expect(steps.flushMedia).toHaveBeenCalledOnce();
    expect(steps.flushIdeaLoom).toHaveBeenCalledOnce();
    expect(steps.closeDb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(steps.closeDb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await db.entered;
    await vi.advanceTimersByTimeAsync(2499);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    modelHost.release();
    peerSync.release();
    db.release();
    ideaLoom.release();
    scheduled.release();
  });

  it('bounds the catalog and IdeaLoom flushes while preserving their different DB ordering', async () => {
    const catalog = hold(steps.flushCatalogFiling);
    const ideaLoom = hold(steps.flushIdeaLoom);
    const { signal, exit } = registerTestShutdown();
    const stopping = signal();
    await catalog.entered;
    expect(steps.flushIdeaLoom).toHaveBeenCalledBefore(steps.flushCatalogFiling);
    await vi.advanceTimersByTimeAsync(2499);
    expect(steps.closeDb).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(steps.closeDb).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    catalog.release();
    ideaLoom.release();
  });

  it('attributes a slow graceful exit to the phase that blocked the event loop', async () => {
    const clock = __createManualClock();
    const peerSync = hold(steps.drainPeerSync);
    const { signal, exit } = registerTestShutdown({ createLagProbe: () => createEventLoopLagProbe({ clock }) });
    const stopping = signal();
    await peerSync.entered;
    clock.advance(100);
    clock.stall(6000);
    clock.advance(100);
    peerSync.release();
    await stopping;

    expect(slowShutdownLogs()).toEqual([
      expect.stringMatching(/^🐢 Graceful shutdown slow totalMs=6200 slowestStep=peerSync .*peerSyncMs=6200 peerSyncLagMs=5900 .*markerSettledMs=0 .*mediaFlushSettledMs=0/),
    ]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
