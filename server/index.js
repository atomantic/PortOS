import './lib/logger.js'; // Add timestamps to all console output
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import healthRoutes from './routes/health.js';
import appsRoutes from './routes/apps.js';
import portsRoutes from './routes/ports.js';
import logsRoutes from './routes/logs.js';
import detectRoutes from './routes/detect.js';
import scaffoldRoutes from './routes/scaffold.js';
import providersRoutes from './routes/providers.js';
import runsRoutes from './routes/runs.js';
import historyRoutes from './routes/history.js';
import commandsRoutes from './routes/commands.js';
import promptsRoutes from './routes/prompts.js';
import gitRoutes from './routes/git.js';
import usageRoutes from './routes/usage.js';
import screenshotsRoutes from './routes/screenshots.js';
import agentsRoutes from './routes/agents.js';
import cosRoutes from './routes/cos.js';
import scriptsRoutes from './routes/scripts.js';
import memoryRoutes from './routes/memory.js';
import standardizeRoutes from './routes/standardize.js';
import { initSocket } from './services/socket.js';
import { initScriptRunner } from './services/scriptRunner.js';
import { errorMiddleware, setupProcessErrorHandlers } from './lib/errorHandler.js';
import { initAutoFixer } from './services/autoFixer.js';
import { initTaskLearning } from './services/taskLearning.js';
import './services/subAgentSpawner.js'; // Initialize CoS agent spawner

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
app.use('/api/providers', providersRoutes);
app.use('/api/runs', runsRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/commands', commandsRoutes);
app.use('/api/prompts', promptsRoutes);
app.use('/api/git', gitRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/screenshots', screenshotsRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/cos/scripts', scriptsRoutes); // Mount before /api/cos to avoid route conflicts
app.use('/api/cos', cosRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/standardize', standardizeRoutes);

// Initialize script runner
initScriptRunner().catch(err => console.error(`❌ Script runner init failed: ${err.message}`));

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
