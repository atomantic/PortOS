import express from 'express';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PATHS } from './lib/fileUtils.js';
import { resolveInstallRoot } from './lib/dataRoot.js';
import { PORTS } from './lib/ports.js';
import { estimateTokens } from './lib/contextBudget.js';
import { existsSync } from 'fs';
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
import workspaceContextsRoutes from './routes/workspaceContexts.js';
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
import tribeRoutes from './routes/tribe.js';
import timelineRoutes from './routes/timeline.js';
import imessageRoutes from './routes/imessage.js';
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
import voicePublicRoutes from './routes/voicePublic.js';
import apiDocsRoutes from './routes/apiDocs.js';
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
import legacyExportRoutes from './routes/legacyExport.js';
import cityRoutes from './routes/cityRoutes.js';
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
import mediaSketchesRoutes from './routes/mediaSketches.js';
import dataSyncRoutes from './routes/dataSync.js';
import identityRoutes from './routes/identity.js';
import instancesRoutes from './routes/instances.js';
import meatspaceRoutes from './routes/meatspace.js';
import mortallomRoutes from './routes/mortalloom.js';
import { initMortalLoomStore } from './services/mortalLoomStore.js';
import reviewRoutes from './routes/review.js';
import githubRoutes from './routes/github.js';
import settingsRoutes from './routes/settings.js';
import authRoutes from './routes/auth.js';
import { authGate, socketAuthGate } from './lib/authGate.js';
import telegramRoutes from './routes/telegram.js';
import updateRoutes from './routes/update.js';
import loopsRoutes from './routes/loops.js';
import characterRoutes from './routes/character.js';
import toolsRoutes from './routes/tools.js';
import imageGenRoutes from './routes/imageGen.js';
import videoGenRoutes from './routes/videoGen.js';
import videoDownloadRoutes from './routes/videoDownload.js';
import videoTimelineRoutes from './routes/videoTimeline.js';
import mediaJobsRoutes from './routes/mediaJobs.js';
import creativeDirectorRoutes from './routes/creativeDirector.js';
import musicVideoRoutes from './routes/musicVideo.js';
import moodBoardRoutes from './routes/moodBoard.js';
import privacyRoutes from './routes/privacy.js';
import writersRoomRoutes from './routes/writersRoom.js';
import universeBuilderRoutes from './routes/universeBuilder.js';
import authorsRoutes from './routes/authors.js';
import artistsRoutes from './routes/artists.js';
import albumsRoutes from './routes/albums.js';
import tracksRoutes from './routes/tracks.js';
import musicRoutes from './routes/music.js';
import conflictJournalRoutes from './routes/conflictJournal.js';
import { initUniverseBuilderCollectionHook } from './services/universeBuilderCollectionHook.js';
import { initCatalogImageAttachHook } from './services/catalogImageAttachHook.js';
import { initWritersRoomSceneImageHook } from './services/writersRoomSceneImageHook.js';
import { initMusicVideoSceneImageHook } from './services/musicVideoSceneImageHook.js';
import { initMusicVideoSceneVideoHook } from './services/musicVideoSceneVideoHook.js';
import { initCreativeDirectorMusicBedHook } from './services/creativeDirectorMusicBedHook.js';
import { initCreativeDirectorSceneImageHook } from './services/creativeDirectorSceneImageHook.js';
import { initComicPagesFilenameHook } from './services/pipeline/comicPagesFilenameHook.js';
import { initStoryboardsFilenameHook } from './services/pipeline/storyboardsFilenameHook.js';
import { initSeasonCoverFilenameHook } from './services/pipeline/seasonCoverFilenameHook.js';
import pipelineRoutes from './routes/pipeline/index.js';
import importerRoutes from './routes/importer.js';
import storyBuilderRoutes from './routes/storyBuilder.js';
import { initMediaJobQueue } from './services/mediaJobQueue/index.js';
import { recoverInFlightProjects } from './services/creativeDirector/recovery.js';
import imageVideoModelsRoutes from './routes/imageVideoModels.js';
import lorasRoutes from './routes/loras.js';
import loraDatasetsRoutes from './routes/loraDatasets.js';
import loraTrainingRoutes from './routes/loraTraining.js';
import { loraDatasetStore } from './services/loraDatasets.js';
import { initLoraTraining } from './services/loraTraining/index.js';
import sdapiRoutes from './routes/sdapi.js';
import openclawRoutes from './routes/openclaw.js';
import sharingRoutes from './routes/sharing.js';
import roundsRoutes from './routes/rounds.js';
import peerSyncRoutes from './routes/peerSync.js';
import { initSharing } from './services/sharing/index.js';
import askRoutes from './routes/ask.js';
import { ensureSelf, startPolling } from './services/instances.js';
import { initSyncLog } from './services/brainSyncLog.js';
import { backfillOriginInstanceId } from './services/brainStorage.js';
import { initSyncOrchestrator } from './services/syncOrchestrator.js';
import { initSocket } from './services/socket.js';
import { errorMiddleware, setupProcessErrorHandlers, asyncHandler, ServerError } from './lib/errorHandler.js';
import { initAutoFixer } from './services/autoFixer.js';
import { initCertRenewer } from './services/certRenewer.js';
import { setHttpsEnabledAtBoot } from './lib/httpsState.js';
import { initTaskLearning } from './services/taskLearning.js';
import { recordSession, recordMessages } from './services/usage.js';
import { errorEvents } from './lib/errorHandler.js';
import { ERROR_CATEGORIES } from './lib/aiToolkit/errorDetection.js';
import { initSpawner } from './services/subAgentSpawner.js';
import * as automationScheduler from './services/automationScheduler.js';
import * as agentActionExecutor from './services/agentActionExecutor.js';
import * as cos from './services/cos.js';
import { startBackupScheduler } from './services/backupScheduler.js';
import { startCitySnapshotScheduler } from './services/citySnapshotScheduler.js';
import { startImessageScheduler } from './services/imessageScheduler.js';
import * as telegram from './services/telegram.js';
import * as telegramBridge from './services/telegramBridge.js';
import { getSettings as getInitSettings } from './services/settings.js';
import { setUserCatalogTypes } from './lib/catalogTypes.js';
import { readUserTypes as readUserTypeSlice } from './services/catalogUserTypes/store.js';
import { startUpdateScheduler, clearStaleUpdateInProgress, processUpdateMarker } from './services/updateChecker.js';
import { captureBootCommit } from './services/installState.js';
import { restoreLoops } from './services/loops.js';
import { startBrainScheduler } from './services/brainScheduler.js';
import { recoverStuckClassifications } from './services/brain.js';
import { recoverStuckAnalyses } from './services/writersRoom/evaluator.js';
import { recoverStuckAutoRuns } from './services/pipeline/autoRunner.js';
import { recoverStuckAutopilots } from './services/pipeline/seriesAutopilot.js';
import { startOrphanShellGc } from './services/importerOrphanGc.js';
import { startImageRefsGc } from './services/imageRefsGc.js';
import { initBridge as initBrainMemoryBridge } from './services/brainMemoryBridge.js';
import { initDrillCache } from './services/meatspacePostDrillCache.js';
import { registerPostReminderSchedule } from './services/meatspacePostReminder.js';
import { createAIToolkit } from './lib/aiToolkit/index.js';
import { runMigrations } from '../scripts/run-migrations.js';
import { verifyCollectionVersions } from './lib/collectionStore.js';
import { conflictJournalStore } from './lib/conflictJournal.js';
import { universeStore } from './services/universeBuilder.js';
import { seriesStore } from './services/pipeline/series.js';
import { issueStore } from './services/pipeline/issues.js';
import { storyBuilderStore } from './services/storyBuilder.js';
import { writersRoomStore } from './services/writersRoom/store.js';
import { wrWorksDir } from './services/writersRoom/_shared.js';
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

// Auth gate for Socket.IO — when settings.secrets.auth.enabled is true the
// handshake must carry a valid token cookie or Authorization: Bearer header
// (set by POST /api/auth/login). No-op when auth is off.
io.use(socketAuthGate);

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
// Prefer PORTOS_DATA_ROOT (set at real launch in ecosystem.config.cjs) over the
// import.meta.url-derived path so a server booted from inside a CoS agent
// worktree still resolves to the real install; runMigrations also skips a
// worktree-rooted path as a backstop (#1947).
await runMigrations({ rootDir: resolveInstallRoot(join(__dirname, '..')) }).catch(err => {
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
await verifyCollectionVersions([universeStore(), seriesStore(), issueStore(), conflictJournalStore(), storyBuilderStore(), mediaCollectionStore(), loraDatasetStore]).catch(err => {
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
    recordMessages(metadata.providerId, metadata.model, 1, estimatedTokens).catch(err => {
      console.error(`❌ Failed to record usage: ${err.message}`);
    });
  },
  onRunFailed: (metadata, error, output) => {
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
  dataDir: DATA_DIR,
  providersFile: 'providers.json',
  runsDir: 'runs',
  promptsDir: 'prompts',
  screenshotsDir: join(DATA_DIR, 'screenshots'),
  sampleProvidersFile: join(DATA_REFERENCE_DIR, 'providers.json'),
  io,
  asyncHandler,
  // Inject PortOS's ServerError so toolkit route errors normalize into the
  // canonical `{ error, code, timestamp, context? }` envelope (issue #1084).
  ServerError,
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
import { executeCliRun as executeCliRunFixed } from './services/runner.js';
import { executeTuiRun as executeTuiRunFixed } from './lib/tuiPromptRunner.js';
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
// Make io available to routes
app.set('io', io);

// Auth gate runs BEFORE the body parsers so unauthenticated requests to
// gated routes are rejected from the headers alone, without forcing the
// server to read and parse a 55 MB JSON body first (DoS surface).
// Public routes (login, status, health) still need a parsed body / no body,
// and they flow through to the parsers below normally. When
// settings.secrets.auth.enabled is true the gate returns 401 for everything
// except the small public set in lib/authGate.js (auth status/whoami/login/
// logout + /api/system/health). No-op when auth is off.
app.use(authGate);

// Body limit is set slightly above the 50MB combined base64 cap enforced by sendMessageSchema
// so the Zod validation (not the body parser) is the binding constraint for attachment payloads.
app.use(express.json({ limit: '55mb' }));
app.use(express.urlencoded({ limit: '55mb', extended: true }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/avatar', avatarRoutes);
app.use('/api/system', systemHealthRoutes);
app.use('/api/capabilities', capabilitiesRoutes);
app.use('/api/apps', appsRoutes);
app.use('/api/workspace-contexts', workspaceContextsRoutes);
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
app.use('/api/media/sketches', mediaSketchesRoutes);
app.use('/api/attachments', attachmentsRoutes);
app.use('/api/client-errors', clientErrorsRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/legacy-export', legacyExportRoutes);
app.use('/api/city', cityRoutes);
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
app.use('/api/tribe', tribeRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/imessage', imessageRoutes);
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
// Public, externally-callable TTS surface. Mounted BEFORE the main voice
// router for readability; Express matches the more specific `/api/voice/public`
// regardless of order since `voiceRoutes` defines no `/public/*` paths. This
// mount is the only voice surface `authGate` will re-open when exposed — the
// main `/api/voice` router (config/whisper/etc.) stays fully gated.
app.use('/api/voice/public', voicePublicRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/api-docs', apiDocsRoutes);
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
app.use('/api/devtools/video-download', videoDownloadRoutes);
app.use('/api/video-timeline', videoTimelineRoutes);
app.use('/api/media-jobs', mediaJobsRoutes);
app.use('/api/creative-director', creativeDirectorRoutes);
app.use('/api/music-video', musicVideoRoutes);
app.use('/api/mood-boards', moodBoardRoutes);
app.use('/api/privacy', privacyRoutes);
app.use('/api/writers-room', writersRoomRoutes);
app.use('/api/universe-builder', universeBuilderRoutes);
app.use('/api/authors', authorsRoutes);
app.use('/api/artists', artistsRoutes);
app.use('/api/albums', albumsRoutes);
app.use('/api/tracks', tracksRoutes);
app.use('/api/music', musicRoutes);
app.use('/api/pipeline', pipelineRoutes);
app.use('/api/conflict-journal', conflictJournalRoutes);
app.use('/api/importer', importerRoutes);
app.use('/api/story-builder', storyBuilderRoutes);
app.use('/api/image-video/models', imageVideoModelsRoutes);
app.use('/api/loras', lorasRoutes);
app.use('/api/lora-datasets', loraDatasetsRoutes);
app.use('/api/lora-training', loraTrainingRoutes);
// AUTOMATIC1111-compatible surface for tailnet clients — gated by
// settings.imageGen.expose.a1111 so it returns 403 unless the user opted in.
app.use('/sdapi/v1', sdapiRoutes);
app.use('/api/openclaw', openclawRoutes);
app.use('/api/sharing', sharingRoutes);
app.use('/api/rounds', roundsRoutes);
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

// Inbox recovery is deferred until after initSyncLog() (see the ensureSelf chain
// below) — it mutates inbox entries, which are now synced brain records, so its
// updateInboxLog() calls append to sync_log.jsonl and MUST run after the log's
// currentSeq is loaded, or they'd write low/duplicate sequence numbers and
// corrupt peer cursors.
recoverStuckAnalyses().catch(err => console.error(`❌ Writers Room recovery failed: ${err.message}`));
recoverStuckAutoRuns().catch(err => console.error(`❌ Pipeline auto-run recovery failed: ${err.message}`));
recoverStuckAutopilots().catch(err => console.error(`❌ Pipeline autopilot recovery failed: ${err.message}`));
// Initialize brain scheduler for daily digests and weekly reviews
startBrainScheduler();
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
// Initialize CyberCity snapshot scheduler — records periodic city-state frames
// for the historical timeline scrubber (issue #877).
startCitySnapshotScheduler().catch(err => console.error(`❌ City snapshot scheduler init failed: ${err.message}`));
// Initialize iMessage sync scheduler — OFF by default; only polls chat.db when
// the user opts in via Settings → iMessage (needs macOS Full Disk Access) (#2151).
startImessageScheduler().catch(err => console.error(`❌ iMessage sync scheduler init failed: ${err.message}`));
// Periodically GC orphan zero-issue/zero-canon importer shells left by an
// abandoned analyze (issue #727).
startOrphanShellGc();
// Periodically GC orphan staged init/reference upload images that pile up in
// data/image-refs on every i2i/edit render and are never cleaned up (issue #1214).
startImageRefsGc();
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
// LoRA training dataset images (lora-datasets/<id>/images/*.png).
app.use('/data/lora-datasets', express.static(PATHS.loraDatasets, ASSET_STATIC_OPTS));
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
// Extracted third-party import assets (ChatGPT export images/audio/PDFs). The
// Brain Memory conversation viewer renders these inline (`![](/data/brain-
// imports/...)`) and as asset links. Read-only; range support for large PDFs.
app.use('/data/brain-imports', express.static(PATHS.brainImportAssets, ASSET_STATIC_OPTS));
// Writers Room file-primary draft prose bodies (works/<workId>/drafts/<draftId>.md).
// Federation (#1565) pulls them peer→peer from this mount: a receiver that merged
// a work record GETs each missing body's bytes by its nested path. Read-only;
// range support for large drafts. (Tailnet-only per the project's threat model.)
// The gate restricts the mount to the draft-body path ONLY — without it, the
// static root would also serve adjacent work-metadata JSON (manifest.json /
// manifest.imported.json on file-backend/migrated installs) to any client that
// knows a work id. Only `<workId>/drafts/<draftId>.md` is needed for body pulls.
app.use('/data/writers-room/works', (req, res, next) => {
  if (!/^\/[^/]+\/drafts\/[^/]+\.md$/.test(req.path)) return res.status(404).end();
  next();
}, express.static(wrWorksDir(), ASSET_STATIC_OPTS));

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
  .then(() => {
    // Recover inbox entries stuck in 'classifying' from a previous crash. Runs
    // AFTER initSyncLog() because updateInboxLog() now appends to the brain sync
    // log — running it before currentSeq is loaded would mint colliding seqs and
    // corrupt peer cursors. Fire-and-forget; failures are logged.
    recoverStuckClassifications().catch(err => console.error(`❌ Brain recovery failed: ${err.message}`));
  })
  .then(() => initMediaJobQueue())
  .then(() => {
    // LoRA training run records reconcile against the live queue (interrupted
    // runs → failed) and mirror queue-side cancels — must run after the queue
    // has loaded its persisted jobs.
    initLoraTraining().catch(err => console.error(`❌ loraTraining init failed: ${err.message}`));
    // Universe Builder needs the media job queue running before it can listen
    // for `completed` events — so initialize the hook here.
    initUniverseBuilderCollectionHook();
    // Catalog image-attach hook — durably files a queued render onto its target
    // ingredient on completion, even if the editor page unmounted mid-render
    // (#1359). Also depends on the media job queue being loaded.
    initCatalogImageAttachHook();
    // Writers-Room scene-image hook — durably files a queued storyboard render
    // onto its analysis snapshot + work collection on completion, even if the
    // editor unmounted mid-render (#1363). Also depends on the queue being loaded.
    initWritersRoomSceneImageHook();
    // Music Video scene-image hook — durably files a queued reference-frame
    // render onto its project scene's `referenceImageId` on completion, even if
    // the director board unmounted mid-render (#1760 Phase 1b). Also depends on
    // the queue being loaded.
    initMusicVideoSceneImageHook();
    // Music Video scene-video hook — durably files a queued i2v scene clip onto
    // its project scene's `videoHistoryId` on completion, even if the director
    // board unmounted mid-render (#1760 Phase 1). Also depends on the queue
    // being loaded.
    initMusicVideoSceneVideoHook();
    // Creative Director music-bed hook — durably files a queued first-pass
    // audio render onto its project's `musicBed` field on completion, even if
    // the requesting client unmounted mid-render (#1928). Also depends on the
    // queue being loaded.
    initCreativeDirectorMusicBedHook();
    // Creative Director scene-frame hook — durably files a queued first-pass
    // reference-frame render onto its project scene's `sourceImageFile` on
    // completion, even if no client is watching (#1867). Also depends on the
    // queue being loaded.
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
    // Individual migration steps stay inside a try/catch so a transient hiccup
    // mid-walk doesn't crash an otherwise-healthy boot; the route surface
    // tolerates an empty catalog and the user can re-trigger via the admin
    // endpoint.
    //
    // PostgreSQL is a mandatory dependency. Before running any DB-dependent
    // boot work, verify the database is reachable and the required schema is
    // present. If not — and we're NOT in a sanctioned escape-hatch/test mode —
    // this is a fatal misconfiguration: the creative catalog has no file-backed
    // equivalent, so booting "successfully" would silently serve a broken
    // install. Fail fast with an actionable message instead.
    //
    // Escape hatches (dev/tests only, UNSUPPORTED for production):
    //   - MEMORY_BACKEND=file  (explicit file backend)
    //   - NODE_ENV=test        (test suites boot without a database)
    const dbEscapeHatch =
      process.env.MEMORY_BACKEND === 'file' || process.env.NODE_ENV === 'test';
    const { checkHealth, ensureSchema } = await import('./lib/db.js');
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

    try {
      // Two early exits guard the migrations below: (1) the fail-fast
      // process.exit(1) above when the DB is required but missing, and (2) this
      // return when on the escape hatch with no healthy DB — ensureSchema and
      // the migrations would throw otherwise.
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
      const { runDbMigrations } = await import('./scripts/run-db-migrations.js');
      try {
        await runDbMigrations();
      } catch (err) {
        console.error(`❌ DB migration failed at boot — refusing to start: ${err?.stack ?? err.message}`);
        process.exit(1);
      }
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
      // Media asset index (#1000): subscribe the generation-completed hooks +
      // reconcile the derived media_assets table against on-disk images/videos.
      // Bytes + sidecars + video-history.json stay authoritative; this builds a
      // queryable index over them. Idempotent, safe to run every boot.
      const { initMediaAssetIndex } = await import('./services/mediaAssetIndex/index.js');
      await initMediaAssetIndex();
    } catch (err) {
      console.error(`🪄 catalog migrations failed at boot: ${err.message}`);
    }

    // Mandatory PostgreSQL store warmups (#1014–1017, #1001, #997) + legacy
    // prune. Each touch forces backend selection and runs a one-time, marker-
    // gated file→DB import that MUST complete before httpServer.listen — so the
    // first request/sync sees fully-migrated records, never a half-applied
    // import racing a request. Unlike the best-effort catalog migrations above
    // (which log-and-continue), a failure here is FATAL: a store that couldn't
    // select its backend or finish its import would serve unmigrated/empty data,
    // which is worse than a hard stop. So this gets its own try/catch (a process
    // boundary, like runDbMigrations above) that exits loudly instead of
    // swallowing the error and booting a partially-migrated install. Skipped
    // when not dbReady (escape hatch), matching the early return above.
    if (dbReady) {
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
        // in an earlier .then(), so it can still be in flight here. The prune
        // below stamps a single completion marker once no domain is blocked, so
        // it must not run while CD's import (and its
        // creative-director-projects.migrated.json marker) is unfinished, or CD's
        // .imported file would never be pruned. listProjects() forces
        // selectBackend() → the (idempotent, marker-gated) import to completion.
        const { listProjects: warmCdProjects } = await import('./services/creativeDirector/local.js');
        await warmCdProjects();
        // Legacy artifact prune: runs LAST, after every file→DB warm above has
        // imported + stamped its marker, so both the migration markers AND the
        // authoritative DB rows exist. Removes the `.imported` / `.bak-NNN`
        // recovery copies the migrators parked aside, but ONLY when the live row
        // count matches the marker's recorded import (a wiped/restored DB keeps
        // the recovery files). Marker-gated in data/legacy-prune.applied.json.
        const { pruneImportedLegacyFiles } = await import('./scripts/pruneImportedLegacyFiles.js');
        await pruneImportedLegacyFiles();
      } catch (err) {
        console.error(`❌ Mandatory store warmup failed at boot — refusing to start: ${err?.stack ?? err.message}`);
        process.exit(1);
      }
    }
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
    const { backfillSeriesCoverImages } = await import('./scripts/backfillSeriesCoverImages.js');
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
    httpServer.listen(PORT, HOST, () => {
      // One canonical "where do I open this" banner — :5555 is always user-facing
      // (HTTP or HTTPS), :PORTOS_HTTP_PORT (default 5553) is the loopback HTTP
      // mirror that only spawns when HTTPS is active. See docs/PORTS.md.
      console.log(`🚀 PortOS listening on :${PORT} (${scheme})`);
      if (httpsEnabled) {
        const localHttpPort = Number(process.env.PORTOS_HTTP_PORT) || PORTS.API_LOCAL;
        // Lead with the URL that works from THIS machine with no cert warnings:
        // the loopback HTTP mirror. http://localhost:${PORT} does NOT work in
        // HTTPS mode (the :${PORT} socket speaks TLS only), so local users who
        // type it land on a dead port — point them here instead.
        console.log(`   👉 http://localhost:${localHttpPort} (open locally — no cert warnings)`);
        // Only advertise the Tailscale hostname when it's actually usable. A cert
        // provisioned while MagicDNS was down can carry a bogus host like
        // "undefined.<tailnet>.ts.net"; printing it as "trusted" just misleads.
        const selfHost = getSelfHost();
        if (selfHost && !/^(undefined|null)\b/i.test(selfHost)) {
          console.log(`   ✅ https://${selfHost}:${PORT} (remote via Tailscale, trusted)`);
        }
        console.log(`   🔐 https://<tailscale-ip>:${PORT} (remote via Tailscale; cert warning unless using the hostname above)`);
        initCertRenewer(httpServer);
        if (localHttpServer) {
          io.attach(localHttpServer);
          localHttpServer.listen(localHttpPort, '127.0.0.1');
          localHttpServer.on('error', (err) => {
            console.warn(`⚠️  Loopback HTTP mirror on :${localHttpPort} failed: ${err.message} — http://localhost:${localHttpPort} won't work; use https://...:${PORT}`);
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

  const { close } = await import('./lib/db.js');
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
