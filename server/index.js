import express from 'express';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PATHS } from './lib/fileUtils.js';
import { PORTS } from './lib/ports.js';
import { existsSync } from 'fs';
import { readFile, unlink } from 'fs/promises';
import { createTailscaleServers } from '../lib/tailscale-https.js';
import { getSelfHost } from './lib/peerSelfHost.js';

import alertsRoutes from './routes/alerts.js';
import appleHealthRoutes from './routes/appleHealth.js';
import avatarRoutes from './routes/avatar.js';
import systemHealthRoutes from './routes/systemHealth.js';
import appsRoutes from './routes/apps.js';
import portsRoutes from './routes/ports.js';
import logsRoutes from './routes/logs.js';
import detectRoutes from './routes/detect.js';
import scaffoldRoutes from './routes/scaffold.js';
import historyRoutes from './routes/history.js';
import commandsRoutes from './routes/commands.js';
import gitRoutes from './routes/git.js';
import usageRoutes from './routes/usage.js';
import screenshotsRoutes from './routes/screenshots.js';
import attachmentsRoutes from './routes/attachments.js';
import uploadsRoutes from './routes/uploads.js';
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
import searchRoutes from './routes/search.js';
import paletteRoutes from './routes/palette.js';
import dashboardLayoutsRoutes from './routes/dashboardLayouts.js';
import mediaCollectionsRoutes from './routes/mediaCollections.js';
import dataSyncRoutes from './routes/dataSync.js';
import identityRoutes from './routes/identity.js';
import instancesRoutes from './routes/instances.js';
import meatspaceRoutes from './routes/meatspace.js';
import mortallomRoutes from './routes/mortalloom.js';
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
import { initMediaJobQueue } from './services/mediaJobQueue/index.js';
import { recoverInFlightProjects } from './services/creativeDirector/recovery.js';
import { seedCreativeDirectorPrompts } from './services/creativeDirector/promptSeeder.js';
import imageVideoModelsRoutes from './routes/imageVideoModels.js';
import sdapiRoutes from './routes/sdapi.js';
import openclawRoutes from './routes/openclaw.js';
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
import './services/subAgentSpawner.js'; // Initialize CoS agent spawner
import * as automationScheduler from './services/automationScheduler.js';
import * as agentActionExecutor from './services/agentActionExecutor.js';
import { startBackupScheduler } from './services/backupScheduler.js';
import * as telegram from './services/telegram.js';
import * as telegramBridge from './services/telegramBridge.js';
import { getSettings as getInitSettings } from './services/settings.js';
import { startUpdateScheduler, recordUpdateResult, clearStaleUpdateInProgress, getCurrentVersion } from './services/updateChecker.js';
import { restoreLoops } from './services/loops.js';
import { startBrainScheduler } from './services/brainScheduler.js';
import { recoverStuckClassifications } from './services/brain.js';
import { initBridge as initBrainMemoryBridge } from './services/brainMemoryBridge.js';
import { initDrillCache } from './services/meatspacePostDrillCache.js';
import { createAIToolkit } from 'portos-ai-toolkit/server';
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
const CERT_DIR = join(PATHS.data, 'certs');
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
const DATA_SAMPLE_DIR = join(__dirname, '..', 'data.sample');

// Lifecycle hooks shared between AI Toolkit and PortOS runner shim
const aiToolkitHooks = {
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
  sampleProvidersFile: join(DATA_SAMPLE_DIR, 'providers.json'),
  io,
  asyncHandler,
  hooks: aiToolkitHooks
});

// Initialize compatibility shims for services that import from old service files
setProvidersToolkit(aiToolkit);
setRunnerToolkit(aiToolkit, { dataDir: DATA_DIR, hooks: aiToolkitHooks });
setPromptsToolkit(aiToolkit);

// Patch toolkit's runner to fix shell security issue (DEP0190)
// Override executeCliRun to remove 'shell: true' which causes security warnings
import { executeCliRun as executeCliRunFixed } from './services/runner.js';
aiToolkit.services.runner.executeCliRun = executeCliRunFixed;
console.log('🔧 Patched aiToolkit runner.executeCliRun to fix shell security issue');

// Note: prompts service is initialized automatically by createAIToolkit()

// Initialize auto-fixer for error recovery
initAutoFixer();

// Initialize task learning system to track agent completions
initTaskLearning();

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
app.use('/api/apps', appsRoutes);
app.use('/api/ports', portsRoutes);
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
app.use('/api/attachments', attachmentsRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/database', databaseRoutes);
app.use('/api/uploads', uploadsRoutes);
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
app.use('/api/image-video/models', imageVideoModelsRoutes);
// AUTOMATIC1111-compatible surface for tailnet clients — gated by
// settings.imageGen.expose.a1111 so it returns 403 unless the user opted in.
app.use('/sdapi/v1', sdapiRoutes);
app.use('/api/openclaw', openclawRoutes);
app.use('/api/ask', askRoutes);

// initMediaJobQueue is awaited as part of the startup chain below so that
// data/ exists and the worker loop is running before /api/video-gen or
// /api/image-gen can enqueue (otherwise persist() can race with ensureDir).

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
// Initialize brain scheduler for daily digests and weekly reviews
startBrainScheduler();
// Initialize brain→memory bridge (mirrors brain data into CoS memory for semantic search)
initBrainMemoryBridge();
// Pre-fill POST drill cache in background
initDrillCache().catch(err => console.error(`❌ POST drill cache init failed: ${err.message}`));
// Initialize backup scheduler for daily data backups
startBackupScheduler().catch(err => console.error(`❌ Backup scheduler init failed: ${err.message}`));
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

// Serve generated images from configured images directory
app.use('/data/images', express.static(PATHS.images));
// Serve generated videos + thumbnails so the Media UI and tailnet clients
// can pull them by URL without going through an explicit download route.
app.use('/data/videos', express.static(PATHS.videos));
app.use('/data/video-thumbnails', express.static(PATHS.videoThumbnails));

// Serve built client UI (production mode — no Vite dev server needed)
const CLIENT_DIST = join(__dirname, '..', 'client', 'dist');
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  // SPA fallback: serve index.html for page navigations only
  // Skip asset requests (.js, .css, etc.) so stale chunk requests get a proper 404
  // instead of index.html with text/html MIME type
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.match(/\.\w+$/) && !req.path.endsWith('.html')) {
      return next();
    }
    res.sendFile(join(CLIENT_DIST, 'index.html'));
  });
  console.log(`📦 Serving built UI from client/dist`);
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
    // Fire-and-forget — resume any Creative Director projects that were mid-
    // flight when the server died. The queue reload above just reclassified
    // their renders as 'failed (interrupted by restart)'; this nudges the
    // orchestrator so projects don't sit frozen waiting for listeners that
    // no longer exist. Doesn't block startup.
    recoverInFlightProjects().catch((e) => console.log(`⚠️ CD boot recovery failed: ${e.message}`));
    // Seed cd-treatment / cd-evaluate prompt stages on first run if the user
    // hasn't customized them yet. data/prompts/ is gitignored so without
    // this, fresh installs would break with "Stage cd-treatment not found"
    // the first time the Creative Director enqueues an agent task.
    seedCreativeDirectorPrompts()
      .then(() => aiToolkit.services.prompts.init())
      .catch((e) => console.log(`⚠️ CD prompt seeder failed: ${e.message}`));
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
  console.log(`🛑 Received ${signal} - shutting down gracefully`);

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
