import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import healthRoutes from './routes/health.js';
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
import scriptsRoutes from './routes/scripts.js';
import memoryRoutes from './routes/memory.js';
import notificationsRoutes from './routes/notifications.js';
import standardizeRoutes from './routes/standardize.js';
import brainRoutes from './routes/brain.js';
import mediaRoutes from './routes/media.js';
import genomeRoutes from './routes/genome.js';
import digitalTwinRoutes from './routes/digital-twin.js';
import socialAccountsRoutes from './routes/socialAccounts.js';
import lmstudioRoutes from './routes/lmstudio.js';
import browserRoutes from './routes/browser.js';
import moltworldToolsRoutes from './routes/moltworldTools.js';
import moltworldWsRoutes from './routes/moltworldWs.js';
import { initSocket } from './services/socket.js';
import { initScriptRunner } from './services/scriptRunner.js';
import { errorMiddleware, setupProcessErrorHandlers, asyncHandler } from './lib/errorHandler.js';
import { initAutoFixer } from './services/autoFixer.js';
import { initTaskLearning } from './services/taskLearning.js';
import { recordSession, recordMessages } from './services/usage.js';
import { errorEvents } from './lib/errorHandler.js';
import './services/subAgentSpawner.js'; // Initialize CoS agent spawner
import * as automationScheduler from './services/automationScheduler.js';
import * as agentActionExecutor from './services/agentActionExecutor.js';
import { startBrainScheduler } from './services/brainScheduler.js';
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
const PORT = process.env.PORT || 5554;
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

// Build absolute paths from __dirname to ensure consistency regardless of cwd
const DATA_DIR = join(__dirname, '..', 'data');
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
app.use('/api', healthRoutes);
app.use('/api/apps', appsRoutes);
app.use('/api/ports', portsRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/detect', detectRoutes);
app.use('/api/scaffold', scaffoldRoutes);
app.use('/api', scaffoldRoutes); // Also mount at /api for /api/templates

// AI Toolkit routes with PortOS extensions
app.use('/api/providers', createPortOSProviderRoutes(aiToolkit));
app.use('/api/runs', createPortOSRunsRoutes(aiToolkit));
app.use('/api/prompts', createPortOSPromptsRoutes(aiToolkit));

app.use('/api/history', historyRoutes);
app.use('/api/commands', commandsRoutes);
app.use('/api/git', gitRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/screenshots', screenshotsRoutes);
app.use('/api/attachments', attachmentsRoutes);
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
app.use('/api/cos/scripts', scriptsRoutes); // Mount before /api/cos to avoid route conflicts
app.use('/api/cos', cosRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/standardize', standardizeRoutes);
app.use('/api/brain', brainRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/digital-twin/social-accounts', socialAccountsRoutes);
app.use('/api/digital-twin/genome', genomeRoutes);
app.use('/api/digital-twin', digitalTwinRoutes);
app.use('/api/lmstudio', lmstudioRoutes);
app.use('/api/browser', browserRoutes);

// Initialize script runner
initScriptRunner().catch(err => console.error(`❌ Script runner init failed: ${err.message}`));

// Initialize agent automation scheduler and action executor
automationScheduler.init().catch(err => console.error(`❌ Agent scheduler init failed: ${err.message}`));
agentActionExecutor.init();

// Initialize brain scheduler for daily digests and weekly reviews
startBrainScheduler();

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND'
  });
});

// Error middleware (must be last)
app.use(errorMiddleware);

// Start server
httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 PortOS server running at http://${HOST}:${PORT}`);

  // Set up process error handlers with io instance
  setupProcessErrorHandlers(io);
});
