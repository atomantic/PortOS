import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PATHS } from './lib/fileUtils.js';
import { existsSync } from 'fs';
import { readFile, unlink } from 'fs/promises';

import alertsRoutes from './routes/alerts.js';
import appleHealthRoutes from './routes/appleHealth.js';
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
import gsdRoutes from './routes/gsd.js';
import memoryRoutes from './routes/memory.js';
import notificationsRoutes from './routes/notifications.js';
import standardizeRoutes from './routes/standardize.js';
import brainRoutes from './routes/brain.js';
import mediaRoutes from './routes/media.js';
import calendarRoutes from './routes/calendar.js';
import messagesRoutes from './routes/messages.js';
import genomeRoutes from './routes/genome.js';
import digitalTwinRoutes from './routes/digital-twin.js';
import socialAccountsRoutes from './routes/socialAccounts.js';
import lmstudioRoutes from './routes/lmstudio.js';
import browserRoutes from './routes/browser.js';
import moltworldToolsRoutes from './routes/moltworldTools.js';
import moltworldWsRoutes from './routes/moltworldWs.js';
import insightsRoutes from './routes/insights.js';
import datadogRoutes from './routes/datadog.js';
import jiraRoutes from './routes/jira.js';
import autobiographyRoutes from './routes/autobiography.js';
import backupRoutes from './routes/backup.js';
import databaseRoutes from './routes/database.js';
import searchRoutes from './routes/search.js';
import identityRoutes from './routes/identity.js';
import instancesRoutes from './routes/instances.js';
import meatspaceRoutes from './routes/meatspace.js';
import reviewRoutes from './routes/review.js';
import githubRoutes from './routes/github.js';
import settingsRoutes from './routes/settings.js';
import telegramRoutes from './routes/telegram.js';
import updateRoutes from './routes/update.js';
import loopsRoutes from './routes/loops.js';
import characterRoutes from './routes/character.js';
import toolsRoutes from './routes/tools.js';
import imageGenRoutes from './routes/imageGen.js';
import { ensureSelf, startPolling } from './services/instances.js';
import { initSyncLog } from './services/brainSyncLog.js';
import { backfillOriginInstanceId } from './services/brainStorage.js';
import { initSyncOrchestrator } from './services/syncOrchestrator.js';
import { initSocket } from './services/socket.js';
import { errorMiddleware, setupProcessErrorHandlers, asyncHandler } from './lib/errorHandler.js';
import { initAutoFixer } from './services/autoFixer.js';
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
const httpServer = createServer(app);
const PORT = process.env.PORT || 5555;
const HOST = process.env.HOST || '0.0.0.0';

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
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Make io available to routes
app.set('io', io);

// API Routes
app.use('/api/alerts', alertsRoutes);
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
app.use('/api/memory', memoryRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/standardize', standardizeRoutes);
app.use('/api/brain', brainRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/digital-twin/social-accounts', socialAccountsRoutes);
app.use('/api/meatspace/genome', genomeRoutes);
app.use('/api/digital-twin/identity', identityRoutes);
app.use('/api/digital-twin/autobiography', autobiographyRoutes);
app.use('/api/digital-twin', digitalTwinRoutes);
app.use('/api/lmstudio', lmstudioRoutes);
app.use('/api/browser', browserRoutes);
app.use('/api/datadog', datadogRoutes);
app.use('/api/jira', jiraRoutes);
app.use('/api/health', appleHealthRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/instances', instancesRoutes);
app.use('/api/meatspace', meatspaceRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/update', updateRoutes);
app.use('/api/loops', loopsRoutes);
app.use('/api/character', characterRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/image-gen', imageGenRoutes);

// Initialize agent automation scheduler and action executor
automationScheduler.init().catch(err => console.error(`❌ Agent scheduler init failed: ${err.message}`));
agentActionExecutor.init();

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
  .then(() => {
    // Start server only after sync log is initialized
    httpServer.listen(PORT, HOST, () => {
      console.log(`🚀 PortOS server running at http://${HOST}:${PORT}`);

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
