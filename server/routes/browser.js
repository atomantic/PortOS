import express from 'express';
import { z } from 'zod';
import * as browserService from '../services/browserService.js';

const router = express.Router();

// Validation schemas
const updateConfigSchema = z.object({
  cdpPort: z.number().int().min(1024).max(65535).optional(),
  cdpHost: z.enum(['127.0.0.1', 'localhost', '::1']).optional(),
  healthPort: z.number().int().min(1024).max(65535).optional(),
  autoConnect: z.boolean().optional(),
  headless: z.boolean().optional(),
  userDataDir: z.string().optional()
});

// GET /api/browser - Full browser status
router.get('/', async (req, res) => {
  const status = await browserService.getFullStatus();
  res.json(status);
});

// GET /api/browser/config - Get browser config
router.get('/config', async (req, res) => {
  const config = await browserService.getConfig();
  res.json(config);
});

// PUT /api/browser/config - Update browser config
router.put('/config', async (req, res) => {
  const updates = updateConfigSchema.parse(req.body);
  const config = await browserService.updateConfig(updates);
  res.json(config);
});

// POST /api/browser/launch - Start the browser process
router.post('/launch', async (req, res) => {
  console.log('🌐 Browser launch requested');
  const status = await browserService.launchBrowser();
  res.json(status);
});

// POST /api/browser/stop - Stop the browser process
router.post('/stop', async (req, res) => {
  console.log('🛑 Browser stop requested');
  const status = await browserService.stopBrowser();
  res.json(status);
});

// POST /api/browser/restart - Restart the browser process
router.post('/restart', async (req, res) => {
  console.log('🔄 Browser restart requested');
  const status = await browserService.restartBrowser();
  res.json(status);
});

// GET /api/browser/health - Quick health check
router.get('/health', async (req, res) => {
  const health = await browserService.getHealthStatus();
  res.json(health);
});

// GET /api/browser/process - PM2 process status
router.get('/process', async (req, res) => {
  const process = await browserService.getProcessStatus();
  res.json(process);
});

// GET /api/browser/pages - List open CDP pages
router.get('/pages', async (req, res) => {
  const pages = await browserService.getOpenPages();
  res.json(pages);
});

// GET /api/browser/version - CDP version info
router.get('/version', async (req, res) => {
  const version = await browserService.getCdpVersion();
  if (!version) {
    return res.status(503).json({ error: 'Browser not reachable' });
  }
  res.json(version);
});

// GET /api/browser/logs - Recent PM2 logs
router.get('/logs', async (req, res) => {
  const lines = parseInt(req.query.lines || '50', 10);
  const logs = await browserService.getRecentLogs(lines);
  res.json(logs);
});

export default router;
