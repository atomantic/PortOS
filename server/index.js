import express from 'express';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PATHS } from './lib/fileUtils.js';
import { PORTS } from './lib/ports.js';
import { existsSync } from 'fs';
import { readFile, unlink } from 'fs/promises';
import { createTailscaleServers } from '../lib/tailscale-https.js';
import { certPaths } from '../lib/certPaths.js';
import { getSelfHost } from './lib/peerSelfHost.js';
import { getBuildId, getStampedIndexHtml } from './lib/buildId.js';

import alertsRoutes from './routes/alerts.js';
import appleHealthRoutes from './routes/appleHealth.js';
import avatarRoutes from './routes/avatar.js';
import systemHealthRoutes from './routes/systemHealth.js';
import capabilitiesRoutes from './routes/capabilities.js';
import appsRoutes from './routes/apps.js';
import referenceReposRoutes from './routes/referenceRepos.js';
import portsRoutes from './routes/ports.js';
import networkExposureRoutes from './routes/networkExposure.js';
import logsRoutes from './routes/logs.js';
import detectRoutes from './routes/detect.js';
import scaffoldRoutes from './routes/scaffold.js';
import historyRoutes from './routes/history.js';
import commandsRoutes from './routes/commands.js';
import gitRoutes from './routes/git.js';
import usageRoutes from './routes/usage.js';
import screenshotsRoutes from './routes/screenshots.js';
import attachmentsRoutes from './routes/attachments.js';
import clientErrorsRoutes from './routes/clientErrors.js';
import uploadsRoutes from './routes/uploads.js';
import imageCleanRoutes from './routes/imageClean.js';
import agentsRoutes from './routes/agents.js';
import agentPersonalitiesRoutes from './routes/agentPersonalities.js';
import platformAccountsRoutes from './routes/platformAccounts.js';
import automationSchedulesRoutes from './routes/automationSchedules.js';
import agentActivityRoutes from './routes/agentActivity.js';
import agentToolsRoutes from './routes/agentTools.js';
import cosRoutes from './routes/cos.js';
import featureAgentsRoutes from './routes/featureAgents.js';
import feedsRoutes from './routes/feeds.js';
import gsdRoutes from './routes/gsd.js';
import catalogRoutes from './routes/catalog.js';
import memoryRoutes from './routes/memory.js';
import notificationsRoutes from './routes/notifications.js';
import standardizeRoutes from './routes/standardize.js';
import brainRoutes from './routes/brain.js';
import brainImportRoutes from './routes/brainImport.js';
import notesRoutes from './routes/notes.js';
import mediaRoutes from './routes/media.js';
import calendarRoutes from './routes/calendar.js';
import messagesRoutes from './routes/messages.js';
import genomeRoutes from './routes/genome.js';
import digitalTwinRoutes from './routes/digital-twin.js';
import socialAccountsRoutes from './routes/socialAccounts.js';
import lmstudioRoutes from './routes/lmstudio.js';
import voiceRoutes from './routes/voice.js';
import { getVoiceConfig } from './services/voice/config.js';
import { reconcile as reconcileVoice } from './services/voice/bootstrap.js';
import { initVoiceTimers } from './services/voice/timers.js';
import browserRoutes from './routes/browser.js';
import moltworldToolsRoutes from './routes/moltworldTools.js';
import moltworldWsRoutes from './routes/moltworldWs.js';
import insightsRoutes from './routes/insights.js';
import datadogRoutes from './routes/datadog.js';
import dataManagerRoutes from './routes/dataManager.js';
import jiraRoutes from './routes/jira.js';
import autobiographyRoutes from './routes/autobiography.js';
import backupRoutes from './routes/backup.js';
import databaseRoutes from './routes/database.js';
import localLlmRoutes from './routes/localLlm.js';
import codeReviewRoutes from './routes/codeReview.js';
import { ensureBackendProvider, getBackend as getLocalLlmBackend } from './services/localLlm.js';
import { ensureProviderReady as ensureOllamaProviderReady, ensureRunning as ensureOllamaRunning } from './services/ollamaManager.js';
import searchRoutes from './routes/search.js';
import paletteRoutes from './routes/palette.js';
import dashboardLayoutsRoutes from './routes/dashboardLayouts.js';
import mediaCollectionsRoutes from './routes/mediaCollections.js';
import mediaAnnotationsRoutes from './routes/mediaAnnotations.js';
import dataSyncRoutes from './routes/dataSync.js';
import identityRoutes from './routes/identity.js';
import instancesRoutes from './routes/instances.js';
import meatspaceRoutes from './routes/meatspace.js';
import mortallomRoutes from './routes/mortalloom.js';
import { initMortalLoomStore } from './services/mortalLoomStore.js';
import reviewRoutes from './routes/review.js';
import githubRoutes from './routes/github.js';
import settingsRoutes from './routes/settings.js';
import telegramRoutes from './routes/telegram.js';
import updateRoutes from './routes/update.js';
import loopsRoutes from './routes/loops.js';
import characterRoutes from './routes/character.js';
import toolsRoutes from './routes/tools.js';
import imageGenRoutes from './routes/imageGen.js';
import videoGenRoutes from './routes/videoGen.js';
import videoTimelineRoutes from './routes/videoTimeline.js';
import mediaJobsRoutes from './routes/mediaJobs.js';
import creativeDirectorRoutes from './routes/creativeDirector.js';
import writersRoomRoutes from './routes/writersRoom.js';
import universeBuilderRoutes from './routes/universeBuilder.js';
import conflictJournalRoutes from './routes/conflictJournal.js';
import { initUniverseBuilderCollectionHook } from './services/universeBuilderCollectionHook.js';
import { initComicPagesFilenameHook } from './services/pipeline/comicPagesFilenameHook.js';
import { initStoryboardsFilenameHook } from './services/pipeline/storyboardsFilenameHook.js';
import { initSeasonCoverFilenameHook } from './services/pipeline/seasonCoverFilenameHook.js';
import pipelineRoutes from './routes/pipeline.js';
import importerRoutes from './routes/importer.js';
import storyBuilderRoutes from './routes/storyBuilder.js';
import { initMediaJobQueue } from './services/mediaJobQueue/index.js';
import { recoverInFlightProjects } from './services/creativeDirector/recovery.js';
import imageVideoModelsRoutes from './routes/imageVideoModels.js';
import lorasRoutes from './routes/loras.js';
import sdapiRoutes from './routes/sdapi.js';
import openclawRoutes from './routes/openclaw.js';
import sharingRoutes from './routes/sharing.js';
import peerSyncRoutes from './routes/peerSync.js';
import { initSharing } from './services/sharing/index.js';
import askRoutes from './routes/ask.js';
import { ensureSelf, startPolling } from './services/instances.js';
import { initSyncLog } from './services/brainSyncLog.js';
import { backfillOriginInstanceId } from './services/brainStorage.js';
import { initSyncOrchestrator } from './services/syncOrchestrator.js';
import { initSocket } from './services/socket.js';
import { errorMiddleware, setupProcessErrorHandlers, asyncHandler } from './lib/errorHandler.js';
import { initAutoFixer } from './services/autoFixer.js';
import { initCertRenewer } from './services/certRenewer.js';
import { setHttpsEnabledAtBoot } from './lib/httpsState.js';
import { initTaskLearning } from './services/taskLearning.js';
import { recordSession, recordMessages } from './services/usage.js';
import { errorEvents } from './lib/errorHandler.js';
import { initSpawner } from './services/subAgentSpawner.js';
import * as automationScheduler from './services/automationScheduler.js';
import * as agentActionExecutor from './services/agentActionExecutor.js';
import * as cos from './services/cos.js';
import { startBackupScheduler } from './services/backupScheduler.js';
import * as telegram from './services/telegram.js';
import * as telegramBridge from './services/telegramBridge.js';
import { getSettings as getInitSettings, settingsEvents } from './services/settings.js';
import { setUserCatalogTypes } from './lib/catalogTypes.js';
import { startUpdateScheduler, recordUpdateResult, clearStaleUpdateInProgress, getCurrentVersion } from './services/updateChecker.js';
import { restoreLoops } from './services/loops.js';
import { startBrainScheduler } from './services/brainScheduler.js';
import { recoverStuckClassifications } from './services/brain.js';
import { recoverStuckAnalyses } from './services/writersRoom/evaluator.js';
import { recoverStuckAutoRuns } from './services/pipeline/autoRunner.js';
import { initBridge as initBrainMemoryBridge } from './services/brainMemoryBridge.js';
import { initDrillCache } from './services/meatspacePostDrillCache.js';
import { createAIToolkit } from './lib/aiToolkit/index.js';
import { runMigrations } from '../scripts/run-migrations.js';
import { verifyCollectionVersions } from './lib/collectionStore.js';
import { conflictJournalStore } from './lib/conflictJournal.js';
import { universeStore } from './services/universeBuilder.js';
import { seriesStore } from './services/pipeline/series.js';
import { issueStore } from './services/pipeline/issues.js';
import { storyBuilderStore } from './services/storyBuilder.js';
import { mediaCollectionStore } from './services/mediaCollections.js';
import { createPortOSProviderRoutes } from './routes/providers.js';
import { createPortOSRunsRoutes } from './routes/runs.js';
import { createPortOSPromptsRoutes } from './routes/prompts.js';
import { setAIToolkit as setProvidersToolkit } from './services/providers.js';
import { setAIToolkit as setRunnerToolkit } from './services/runner.js';
import { setAIToolkit as setPromptsToolkit } from './services/promptService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5555;
const HOST = process.env.HOST || '0.0.0.0';

// Delegates HTTPS / HTTP-mirror wiring to lib/tailscale-https.js — see there.
const { dir: CERT_DIR } = certPaths(PATHS.data);
const { server: httpServer, mirror: localHttpServer, httpsEnabled } =
  createTailscaleServers(app, { certDir: CERT_DIR });
const scheme = httpsEnabled ? 'https' : 'http';
setHttpsEnabledAtBoot(httpsEnabled);

// Socket.IO with relative path support for Tailscale
const io = new Server(httpServer, {
  cors: {
    origin: true, // Allow any origin (local network only)
    credentials: true
  },
  path: '/socket.io'
});

// Initialize socket handlers
initSocket(io);

// Build absolute paths - use centralized PATHS for data, __dirname for non-data paths
const DATA_DIR = PATHS.data;
const DATA_REFERENCE_DIR = join(__dirname, '..', 'data.reference');

// Apply pending data migrations BEFORE the AI toolkit reads stage-config.json
// and providers.json. Without this, a plain pull-and-restart (no update.sh)
// leaves new prompt stages and other shipped data changes unregistered —
// existing installs hit "Stage X not found" until the user manually runs
// `npm run migrations` or `npm run update`. Idempotent and cheap when the
// applied-list is already current.
await runMigrations({ rootDir: join(__dirname, '..') }).catch(err => {
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
await verifyCollectionVersions([universeStore(), seriesStore(), issueStore(), conflictJournalStore(), storyBuilderStore(), mediaCollectionStore()]).catch(err => {
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
    const estimatedTokens = Math.ceil(output.length / 4);
    recordMessages(metadata.providerId, metadata.model, 1, estimatedTokens).catch(err => {
      console.error(`❌ Failed to record usage: ${err.message}`);
    });
  },
  onRunFailed: (metadata, error, output) => {
    const errorMessage = error?.message ?? String(error);
    errorEvents.emit('error', {
      code: 'AI_PROVIDER_EXECUTION_FAILED',
      message: `AI provider ${metadata.providerName} execution failed: ${errorMessage}`,
      severity: 'error',
      canAutoFix: true,
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
  dataDir: DATA_DIR,
  providersFile: 'providers.json',
  runsDir: 'runs',
  promptsDir: 'prompts',
  screenshotsDir: join(DATA_DIR, 'screenshots'),
  sampleProvidersFile: join(DATA_REFERENCE_DIR, 'providers.json'),
  io,
  asyncHandler,
  hooks: aiToolkitHooks
});

// Initialize compatibility shims for services that import from old service files
setProvidersToolkit(aiToolkit);
setRunnerToolkit(aiToolkit, { dataDir: DATA_DIR, hooks: aiToolkitHooks });
setPromptsToolkit(aiToolkit);

// Warm the providers file at startup so the codex-sentinel migration runs
// before any inbound request can hit the providers cache. Awaited so the
// migration write completes deterministically before request handlers
// start consulting providers state.
try {
  await aiToolkit.services.providers.getAllProviders();
} catch (err) {
  console.error(`❌ Failed to load providers at startup: ${err.message}`);
}

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

// Swap the toolkit's generic executeCliRun for PortOS's variant that adds
// CLI-provider-specific args building (Codex `exec -`, Antigravity `agy --print`,
// Claude Code `-p -`). The toolkit's in-tree implementation is also safe
// (no shell, prompt via stdin) — the PortOS variant exists for the per-CLI
// invocation conventions, not for security.
import { executeCliRun as executeCliRunFixed } from './services/runner.js';
import { executeTuiRun as executeTuiRunFixed } from './lib/tuiPromptRunner.js';
aiToolkit.services.runner.executeCliRun = executeCliRunFixed;
// Attach the TUI executor so POST /api/runs with a TUI provider dispatches
// here instead of erroring. The toolkit's runs router checks for
// `runnerService.executeTuiRun` and 400s otherwise — without this patch,
// runs UI would be unable to start TUI runs even though the staged-LLM path
// (promptRunner.js) already routes TUI internally.
aiToolkit.services.runner.executeTuiRun = executeTuiRunFixed;
// Also patch stopRun + isRunActive so they consult `_portosActiveRuns`
// (where the PortOS CLI variant tracks child processes), not just the
// toolkit's internal `activeRuns` map. Without this, the runs router
// would report live CLI runs as inactive and refuse to stop them.
const originalStopRun = aiToolkit.services.runner.stopRun.bind(aiToolkit.services.runner);
aiToolkit.services.runner.stopRun = async (runId) => {
  const portosActive = aiToolkit.services.runner._portosActiveRuns?.get(runId);
  if (portosActive) {
    if (portosActive.kill) portosActive.kill('SIGTERM');
    aiToolkit.services.runner._portosActiveRuns.delete(runId);
    return true;
  }
  return originalStopRun(runId);
};
const originalIsRunActive = aiToolkit.services.runner.isRunActive.bind(aiToolkit.services.runner);
aiToolkit.services.runner.isRunActive = (runId) => {
  if (aiToolkit.services.runner._portosActiveRuns?.has(runId)) return true;
  return originalIsRunActive(runId);
};
// Patch deleteRun so that deleting an in-flight PortOS CLI run also kills the
// child process before removing the on-disk directory. Without this patch,
// deleteRun only checks the toolkit's internal `activeRuns` map (which is
// empty for PortOS CLI runs) and silently leaves a zombie child process running.
const originalDeleteRun = aiToolkit.services.runner.deleteRun.bind(aiToolkit.services.runner);
aiToolkit.services.runner.deleteRun = async function (runId, ...args) {
  if (this._portosActiveRuns?.has?.(runId)) {
    await this.stopRun(runId);
  }
  return originalDeleteRun.call(this, runId, ...args);
};
console.log('🔧 Patched aiToolkit runner.executeCliRun + stopRun + isRunActive + deleteRun with PortOS CLI variants');

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

// Middleware - allow any origin for Tailscale access
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Body limit is set slightly above the 50MB combined base64 cap enforced by sendMessageSchema
// so the Zod validation (not the body parser) is the binding constraint for attachment payloads.
app.use(express.json({ limit: '55mb' }));
app.use(express.urlencoded({ limit: '55mb', extended: true }));

// Make io available to routes
app.set('io', io);

// API Routes
app.use('/api/alerts', alertsRoutes);
app.use('/api/avatar', avatarRoutes);
app.use('/api/system', systemHealthRoutes);
app.use('/api/capabilities', capabilitiesRoutes);
app.use('/api/apps', appsRoutes);
app.use('/api/apps/:appId/reference-repos', referenceReposRoutes);
app.use('/api/ports', portsRoutes);
app.use('/api/network-exposure', networkExposureRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/detect', detectRoutes);
app.use('/api/scaffold', scaffoldRoutes);

// AI Toolkit routes with PortOS extensions
app.use('/api/providers', createPortOSProviderRoutes(aiToolkit));
app.use('/api/runs', createPortOSRunsRoutes(aiToolkit));
app.use('/api/prompts', createPortOSPromptsRoutes(aiToolkit));

app.use('/api/history', historyRoutes);
app.use('/api/commands', commandsRoutes);
app.use('/api/git', gitRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/screenshots', screenshotsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/palette', paletteRoutes);
app.use('/api/dashboard/layouts', dashboardLayoutsRoutes);
app.use('/api/media/collections', mediaCollectionsRoutes);
app.use('/api/media/annotations', mediaAnnotationsRoutes);
app.use('/api/attachments', attachmentsRoutes);
app.use('/api/client-errors', clientErrorsRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/database', databaseRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/image-clean', imageCleanRoutes);
// Agent Personalities feature routes (must be before /api/agents to avoid route conflicts)
app.use('/api/agents/personalities', agentPersonalitiesRoutes);
app.use('/api/agents/accounts', platformAccountsRoutes);
app.use('/api/agents/schedules', automationSchedulesRoutes);
app.use('/api/agents/activity', agentActivityRoutes);
app.use('/api/agents/tools/moltworld/ws', moltworldWsRoutes);
app.use('/api/agents/tools/moltworld', moltworldToolsRoutes);
app.use('/api/agents/tools', agentToolsRoutes);
// Existing running agents routes (process management)
app.use('/api/agents', agentsRoutes);
app.use('/api/cos/gsd', gsdRoutes);
app.use('/api/cos', cosRoutes);
app.use('/api/feature-agents', featureAgentsRoutes);
app.use('/api/feeds', feedsRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/standardize', standardizeRoutes);
app.use('/api/brain/import', brainImportRoutes);
app.use('/api/brain', brainRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/digital-twin/social-accounts', socialAccountsRoutes);
app.use('/api/meatspace/genome', genomeRoutes);
app.use('/api/digital-twin/identity', identityRoutes);
app.use('/api/digital-twin/autobiography', autobiographyRoutes);
app.use('/api/digital-twin', digitalTwinRoutes);
app.use('/api/lmstudio', lmstudioRoutes);
app.use('/api/local-llm', localLlmRoutes);
app.use('/api/code-review', codeReviewRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/browser', browserRoutes);
app.use('/api/data', dataManagerRoutes);
app.use('/api/datadog', datadogRoutes);
app.use('/api/jira', jiraRoutes);
app.use('/api/health', appleHealthRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/instances', instancesRoutes);
app.use('/api/sync', dataSyncRoutes);
app.use('/api/meatspace', meatspaceRoutes);
app.use('/api/mortalloom', mortallomRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/update', updateRoutes);
app.use('/api/loops', loopsRoutes);
app.use('/api/character', characterRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/image-gen', imageGenRoutes);
app.use('/api/video-gen', videoGenRoutes);
app.use('/api/video-timeline', videoTimelineRoutes);
app.use('/api/media-jobs', mediaJobsRoutes);
app.use('/api/creative-director', creativeDirectorRoutes);
app.use('/api/writers-room', writersRoomRoutes);
app.use('/api/universe-builder', universeBuilderRoutes);
app.use('/api/pipeline', pipelineRoutes);
app.use('/api/conflict-journal', conflictJournalRoutes);
app.use('/api/importer', importerRoutes);
app.use('/api/story-builder', storyBuilderRoutes);
app.use('/api/image-video/models', imageVideoModelsRoutes);
app.use('/api/loras', lorasRoutes);
// AUTOMATIC1111-compatible surface for tailnet clients — gated by
// settings.imageGen.expose.a1111 so it returns 403 unless the user opted in.
app.use('/sdapi/v1', sdapiRoutes);
app.use('/api/openclaw', openclawRoutes);
app.use('/api/sharing', sharingRoutes);
app.use('/api/peer-sync', peerSyncRoutes);
app.use('/api/ask', askRoutes);

// initMediaJobQueue is awaited as part of the startup chain below so that
// data/ exists and the worker loop is running before /api/video-gen or
// /api/image-gen can enqueue (otherwise persist() can race with ensureDir).

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

// Recover any inbox entries stuck in 'classifying' from a previous crash/restart
recoverStuckClassifications().catch(err => console.error(`❌ Brain recovery failed: ${err.message}`));
recoverStuckAnalyses().catch(err => console.error(`❌ Writers Room recovery failed: ${err.message}`));
recoverStuckAutoRuns().catch(err => console.error(`❌ Pipeline auto-run recovery failed: ${err.message}`));
// Initialize brain scheduler for daily digests and weekly reviews
startBrainScheduler();
// Initialize brain→memory bridge (mirrors brain data into CoS memory for semantic search)
initBrainMemoryBridge();
// Pre-fill POST drill cache in background
initDrillCache().catch(err => console.error(`❌ POST drill cache init failed: ${err.message}`));
// Initialize backup scheduler for daily data backups
startBackupScheduler().catch(err => console.error(`❌ Backup scheduler init failed: ${err.message}`));
// Warm the catalog user-type registry from settings before any catalog request
// can land, so user-defined types validate + mint ids immediately on boot.
// Refresh on every settings write (the Settings → Catalog tab persists through
// updateSettings, which emits this event) so the in-process registry tracks
// edits without a restart.
getInitSettings()
  .then(s => setUserCatalogTypes(s.catalogUserTypes || []))
  .catch(err => console.error(`❌ Catalog user-type warm failed: ${err.message}`));
settingsEvents.on('settings:updated', (s) => {
  try { setUserCatalogTypes(s?.catalogUserTypes || []); }
  catch (err) { console.error(`❌ Catalog user-type refresh failed: ${err.message}`); }
});
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
// Check for update completion marker from a previous update cycle
const updateMarkerPath = join(PATHS.data, 'update-complete.json');
const removeMarker = () => unlink(updateMarkerPath).catch(e => {
  if (e?.code !== 'ENOENT') console.error(`❌ Failed to remove update marker: ${e.message}`);
});

(async () => {
  let raw;
  try { raw = await readFile(updateMarkerPath, 'utf-8'); }
  catch (err) {
    if (err?.code === 'ENOENT') return; // No marker = no recent update
    console.error(`❌ Failed to read update marker: ${err?.message ?? err}`);
    return removeMarker();
  }

  let marker;
  try { marker = JSON.parse(raw); }
  catch (err) {
    console.error(`❌ Corrupted update marker (invalid JSON): ${err?.message ?? err}`);
    return removeMarker();
  }

  if (!marker.version || !marker.completedAt) {
    console.error(`❌ Update marker missing required fields (version: ${marker.version}, completedAt: ${marker.completedAt})`);
    return removeMarker();
  }

  const runningVersion = await getCurrentVersion();
  if (marker.version !== runningVersion) {
    console.error(`❌ Update marker version (${marker.version}) doesn't match running version (${runningVersion}) — recording as failed`);
    await recordUpdateResult({ version: marker.version, success: false, completedAt: marker.completedAt, log: `Version mismatch: expected ${marker.version}, running ${runningVersion}` })
      .catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
    return removeMarker();
  }

  console.log(`✅ Update to v${marker.version} completed at ${marker.completedAt}`);
  await recordUpdateResult({ version: marker.version, success: true, completedAt: marker.completedAt, log: '' })
    .catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
  return removeMarker();
})().catch(err => console.error(`❌ Update marker processing failed: ${err.message}`));

// Clear stale updateInProgress if the server was killed mid-update
clearStaleUpdateInProgress().catch(err => console.error(`❌ Stale update recovery failed: ${err.message}`));

// Start periodic update checker (checks GitHub releases every 30 min)
startUpdateScheduler();

// Restore any active loops from previous session
restoreLoops().catch(err => console.error(`❌ Loop restore failed: ${err.message}`));

// Asset static mounts. `acceptRanges: true` is the serve-static default
// already, but we set it explicitly because the federated peer-sync receiver
// (services/sharing/peerSync.js) background-pulls missing assets from these
// URLs and relies on HTTP Range to resume partial downloads over flaky
// Tailnet links — losing range support here would silently force every
// retry to restart from byte 0 on a multi-MB PNG / video. Same posture for
// every kind below (image, image-ref, video, video-thumbnail).
const ASSET_STATIC_OPTS = { acceptRanges: true };
app.use('/data/images', express.static(PATHS.images, ASSET_STATIC_OPTS));
// Reference images (multi-ref upload inputs + generated character reference
// sheets) — served read-only so the UI can render thumbnails by URL.
app.use('/data/image-refs', express.static(PATHS.imageRefs, ASSET_STATIC_OPTS));
// Serve generated videos + thumbnails so the Media UI and tailnet clients
// can pull them by URL without going through an explicit download route.
app.use('/data/videos', express.static(PATHS.videos, ASSET_STATIC_OPTS));
app.use('/data/video-thumbnails', express.static(PATHS.videoThumbnails, ASSET_STATIC_OPTS));
// Voice-over WAVs rendered by the pipeline audio stage — the AudioStage UI
// pulls them inline via <audio src="/data/audio/<filename>">.
app.use('/data/audio', express.static(PATHS.audio));
// Background-music tracks (uploaded today, generated locally tomorrow). The
// AudioStage music picker plays them inline via <audio src="/data/music/...">.
app.use('/data/music', express.static(PATHS.music));

// Serve built client UI (production mode — no Vite dev server needed)
const CLIENT_DIST = join(__dirname, '..', 'client', 'dist');
if (existsSync(CLIENT_DIST)) {
  // `index: false` keeps express.static from short-circuiting `/` (and any
  // bare directory) with the raw index.html — that path needs to flow through
  // the splat handler below so the meta-tag injection runs.
  app.use(express.static(CLIENT_DIST, { index: false }));
  // SPA fallback: serve index.html for page navigations only
  // Skip asset requests (.js, .css, etc.) so stale chunk requests get a proper 404
  // instead of index.html with text/html MIME type. We serve the stamped HTML
  // string (with <meta name="portos-build-id"> injected) instead of sendFile
  // so the bundled JS can read its own build id at boot. Re-read per request —
  // a `npm run build` between server start and the request rewrites index.html
  // with new chunk filenames; a stale snapshot would tell the browser to load
  // chunks that no longer exist on disk.
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.match(/\.\w+$/) && !req.path.endsWith('.html')) {
      return next();
    }
    // index.html embeds the current build's hashed asset filenames. After a
    // rebuild + restart, a browser still holding a cached copy would point at
    // chunks that no longer exist on disk (the `index-CwBEDqDF.css` class of
    // 404). `no-cache` lets the browser keep the file but forces an etag
    // revalidation on every navigation, so a fresh build is picked up on the
    // very next request without a hard refresh.
    res.set('Cache-Control', 'no-cache');
    const stampedIndexHtml = getStampedIndexHtml();
    if (stampedIndexHtml) {
      res.type('html').send(stampedIndexHtml);
    } else {
      res.sendFile(join(CLIENT_DIST, 'index.html'));
    }
  });
  console.log(`📦 Serving built UI from client/dist (build ${getBuildId()})`);
}

// 404 handler (API routes that didn't match)
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND'
  });
});

// Error middleware (must be last)
app.use(errorMiddleware);

// Initialize instance identity + sync log before accepting requests to prevent
// race conditions where brain mutations arrive before the sync log is ready
ensureSelf()
  .then(() => initSyncLog())
  .then(() => initMediaJobQueue())
  .then(() => {
    // Universe Builder needs the media job queue running before it can listen
    // for `completed` events — so initialize the hook here.
    initUniverseBuilderCollectionHook();
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
  })
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
      const { markRecoveryDone } = await import('./services/creativeDirector/recovery.js');
      markRecoveryDone();
    });
  })
  .then(async () => {
    // Catalog backfill: promote universe canon (characters/places/objects)
    // into the Postgres ingredients catalog. Idempotent — marker in
    // data/catalog-backfill.applied.json gates the walk after the first run.
    // Fire-and-forget so a DB hiccup doesn't block server boot — the route
    // surface tolerates an empty catalog and the user can re-trigger via
    // the admin endpoint.
    try {
      const { ensureSchema } = await import('./lib/db.js');
      await ensureSchema();
      const { migrateBibleToCatalog } = await import('./scripts/migrateBibleToCatalog.js');
      await migrateBibleToCatalog();
      // One-time data repair: rewrite legacy machine universe tags
      // (`from-universe`, `universe:<id>`) on backfilled rows into the friendly
      // universe NAME tag. Runs after the backfill so promoted rows exist;
      // marker-gated in data/catalog-universe-tags.applied.json.
      const { repairUniverseTags } = await import('./scripts/repairUniverseTags.js');
      await repairUniverseTags();
      // Per-record catalog payload-shape migration — walks rows whose stored
      // payload.schemaVersion lags the registry-current and applies registered
      // upgraders. No-ops via marker once an install is at the high-water
      // version, so this is free on steady-state boots.
      const { migrateCatalogPayload } = await import('./scripts/migrateCatalogPayload.js');
      await migrateCatalogPayload();
      // One-time canon↔catalog reconciliation: collapse any pre-existing
      // divergence between an embedded universe-canon entry and its catalog
      // row (they were copy-on-write mirrors before the bidirectional
      // projection landed). LWW on updatedAt; writes the winner to both sides.
      // Runs LAST so promoted rows exist and are at current payload-shape
      // version; marker-gated in data/catalog-canon-reconcile.applied.json.
      const { reconcileCanonCatalog } = await import('./scripts/reconcileCanonCatalog.js');
      await reconcileCanonCatalog();
    } catch (err) {
      console.error(`🪄 catalog migrations failed at boot: ${err.message}`);
    }
  })
  .then(() => {
    // Start server only after sync log + media job queue are initialized.
    // initMediaJobQueue failure is fatal: the queue owns persistence + SSE
    // + temp-file cleanup for /api/video-gen and local /api/image-gen, and
    // accepting requests with a half-init queue silently corrupts state
    // (persist() throws, SSE streams degrade). Catch + crash via the
    // outer .catch(...process.exit) below.
    httpServer.listen(PORT, HOST, () => {
      // One canonical "where do I open this" banner — :5555 is always user-facing
      // (HTTP or HTTPS), :PORTOS_HTTP_PORT (default 5553) is the loopback HTTP
      // mirror that only spawns when HTTPS is active. See docs/PORTS.md.
      console.log(`🚀 PortOS listening on :${PORT} (${scheme})`);
      if (httpsEnabled) {
        const selfHost = getSelfHost();
        if (selfHost) console.log(`   ✅ https://${selfHost}:${PORT} (trusted via Tailscale)`);
        console.log(`   🔐 https://<tailscale-ip>:${PORT} (cert warning unless using the hostname above)`);
        initCertRenewer(httpServer);
        const localHttpPort = Number(process.env.PORTOS_HTTP_PORT) || PORTS.API_LOCAL;
        if (localHttpServer) {
          io.attach(localHttpServer);
          localHttpServer.listen(localHttpPort, '127.0.0.1', () => {
            console.log(`   🔓 http://localhost:${localHttpPort} (loopback HTTP mirror, no cert warnings)`);
          });
          localHttpServer.on('error', (err) => {
            console.warn(`⚠️  Loopback HTTP mirror on :${localHttpPort} failed: ${err.message} — HTTPS still active`);
          });
        }
      } else {
        console.log(`   🌐 http://localhost:${PORT}`);
        console.log(`⚠️  HTTP only — getUserMedia (mic) won't work over Tailscale IP. Run "npm run setup:cert" to enable HTTPS.`);
      }

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

const closeServer = (server, label) => new Promise((resolve) => {
  if (!server) return resolve();
  server.close((err) => {
    if (err) console.error(`⚠️ Error closing ${label}: ${err.message}`);
    else console.log(`✅ ${label} closed`);
    resolve();
  });
});

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
  }, 10000);

  await new Promise((resolve) => {
    io.close((err) => {
      if (err) console.error(`⚠️ Error closing Socket.IO: ${err.message}`);
      else console.log('✅ Socket.IO server closed');
      resolve();
    });
  });
  await closeServer(httpServer, 'HTTP server');
  await closeServer(localHttpServer, 'Local HTTP server');

  const { close } = await import('./lib/db.js');
  if (typeof close === 'function') {
    await close();
    console.log('✅ DB pool closed');
  } else {
    console.warn('ℹ️ DB pool close not available; skipping DB shutdown');
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
