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
import { initSocket } from './services/socket.js';

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

// Middleware - allow any origin for Tailscale access
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

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

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    code: err.code || 'INTERNAL_ERROR'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND'
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`PortOS server running at http://${HOST}:${PORT}`);
});
