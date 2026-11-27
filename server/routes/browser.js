import { downloadQuerySchema, browserLogsQuerySchema, navigateSchema, restartSchema, updateConfigSchema } from '../lib/browserValidation.js';
import express from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { isBlockedIngestHost } from '../lib/safeUrlFetch.js';
import { assertPublicHttpUrl } from '../lib/safeUrlFetch.js';
import { getBrowserStatusSnapshot } from '../services/browserStatus.js';
import { requestHasHostControl } from '../services/authGate.js';
import * as browserService from '../services/browserService.js';

const router = express.Router();

// Settle window the pinned navigate holds open after the first document response
// so a client-side redirect (meta-refresh / location.replace) that fires just
// after load is captured and IP-verified too, not just the initial nav + HTTP
// redirect chain. Small so an interactive "open this URL" stays responsive.
const NAVIGATE_SETTLE_MS = 1000;

// GET /api/browser - Full browser status
router.get('/', asyncHandler(async (req, res) => {
  const status = await getBrowserStatusSnapshot();
  if (requestHasHostControl(req)) return res.json(status);
  // The snapshot includes raw CDP metadata, host paths and process details.
  // Publish only the fields needed to show basic browser health remotely.
  res.json({
    connected: status.connected,
    processRunning: status.processRunning,
    status: status.status,
    headless: status.headless,
    process: { status: status.process?.status },
    pages: [],
    pageCount: status.pageCount,
    downloads: { files: [] },
    contentRedacted: true,
  });
}));

// GET /api/browser/config - Get browser config
router.get('/config', asyncHandler(async (req, res) => {
  const config = await browserService.getConfig();
  res.json(config);
}));

// PUT /api/browser/config - Update browser config
router.put('/config', asyncHandler(async (req, res) => {
  const updates = validateRequest(updateConfigSchema, req.body);
  const config = await browserService.updateConfig(updates);
  res.json(config);
}));

// POST /api/browser/launch - Start the browser process
router.post('/launch', asyncHandler(async (req, res) => {
  console.log('🌐 Browser launch requested');
  const status = await browserService.launchBrowser();
  res.json(status);
}));

// POST /api/browser/stop - Stop the browser process
router.post('/stop', asyncHandler(async (req, res) => {
  console.log('🛑 Browser stop requested');
  const status = await browserService.stopBrowser();
  res.json(status);
}));

// GET /api/browser/update-preflight - Fresh, local-only evidence for a restart confirmation.
router.get('/update-preflight', asyncHandler(async (_req, res) => {
  const { prepareBrowserUpdateRestart } = await import('../services/browserUpdateRestart.js');
  res.set('Cache-Control', 'no-store');
  res.json(await prepareBrowserUpdateRestart());
}));

// POST /api/browser/restart - Restart the browser process
router.post('/restart', asyncHandler(async (req, res) => {
  const { ticket } = validateRequest(restartSchema, req.body || {});
  console.log('🔄 Browser restart requested');
  const status = ticket
    ? await (await import('../services/browserUpdateRestart.js')).confirmBrowserUpdateRestart(ticket)
    : await browserService.restartBrowser();
  res.json(status);
}));

// POST /api/browser/navigate - Open a URL in the CDP browser
router.post('/navigate', asyncHandler(async (req, res) => {
  const { url } = validateRequest(navigateSchema, req.body);
  console.log('🌐 Browser navigation requested');
  // Layer 2 — DNS-resolve pre-check: reject a hostname whose A record points at a
  // blocked (loopback / link-local / cloud-metadata) address BEFORE opening a
  // tab. Throws a clean 400 (UNSAFE_URL) via the shared safeUrlFetch gate; an
  // IP-literal target skips the lookup (isSafeIngestUrl already classified it).
  await assertPublicHttpUrl(url);
  // Layer 3 — connect-time pin: Chrome resolves DNS itself, so a rebinding answer
  // (or a server-side redirect) could still steer it to a blocked address after
  // the pre-check. navigateToUrlPinned verifies, against Chrome's OWN reported
  // remoteIPAddress, that the initial nav, EVERY HTTP redirect hop, and any
  // client-side navigation during the settle window connected to an allowed
  // address — tearing the tab down and failing closed (throws) otherwise.
  const page = await browserService.navigateToUrlPinned(url, {
    verifyRemoteIp: (ip) => !isBlockedIngestHost(ip),
    settleMs: NAVIGATE_SETTLE_MS,
  });
  res.json(page);
}));

// GET /api/browser/health - Quick health check
router.get('/health', asyncHandler(async (req, res) => {
  const health = await browserService.getHealthStatus();
  res.json(health);
}));

// GET /api/browser/logs - Recent PM2 logs
router.get('/logs', asyncHandler(async (req, res) => {
  const { lines } = validateRequest(browserLogsQuerySchema, req.query);
  const logs = await browserService.getRecentLogs(lines);
  res.json(logs);
}));

// Extensions that could execute scripts when served inline at the same origin —
// always force attachment to keep XSS via a downloaded asset off the table.
const RISKY_DOWNLOAD_EXTS = new Set(['.html', '.htm', '.svg', '.js', '.mjs', '.xml']);

// GET /api/browser/downloads/:name - Stream a downloaded file to the client.
// Inline by default so previewable types (images, PDFs, videos) open in the
// browser; the listing UI passes ?attachment=1 + HTML5 `download` for save-to-disk.
router.get('/downloads/:name', asyncHandler(async (req, res) => {
  const { attachment } = validateRequest(downloadQuerySchema, req.query);
  const file = await browserService.resolveDownload(req.params.name);
  if (!file) throw new ServerError('File not found', { status: 404 });
  res.set('X-Content-Type-Options', 'nosniff');
  // Files of the same name can be replaced by a fresh Chrome download; bypass
  // any aggressive client/intermediary caching so the user always sees current.
  res.set('Cache-Control', 'no-cache, must-revalidate');
  const forceAttachment = RISKY_DOWNLOAD_EXTS.has(file.ext) || attachment === '1';
  if (forceAttachment) {
    // RFC 5987: ASCII-safe fallback + utf-8 form for non-ASCII names.
    const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.set(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`
    );
  }
  res.type(file.mime).sendFile(file.absPath);
}));

// DELETE /api/browser/downloads/:name - Remove a downloaded file
router.delete('/downloads/:name', asyncHandler(async (req, res) => {
  const removed = await browserService.deleteDownload(req.params.name);
  if (!removed) throw new ServerError('File not found', { status: 404 });
  console.log(`🗑️ Browser download deleted`);
  res.json({ success: true });
}));

export default router;
