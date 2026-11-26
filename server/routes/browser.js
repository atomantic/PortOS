import express from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { validateChromePath, validateMacAppBundle } from '../lib/browserConfig.js';
import { isSafeIngestUrl, isBlockedIngestHost } from '../lib/safeUrlFetch.js';
import { assertPublicHttpUrl } from '../lib/safeUrlFetch.js';
import { getBrowserStatusSnapshot } from '../services/browserStatus.js';
import { requestHasHostControl } from '../services/authGate.js';
import * as browserService from '../services/browserService.js';
import { logsQuerySchema } from '../lib/sharedSchemas.js';
import { browserVaultFillSchema, browserVaultListInputSchema } from '../lib/websiteLoginValidation.js';

const router = express.Router();

// Settle window the pinned navigate holds open after the first document response
// so a client-side redirect (meta-refresh / location.replace) that fires just
// after load is captured and IP-verified too, not just the initial nav + HTTP
// redirect chain. Small so an interactive "open this URL" stays responsive.
const NAVIGATE_SETTLE_MS = 1000;

// Validation schemas
const downloadQuerySchema = z.object({ attachment: z.string().optional() });
// Reuses the PM2 logs bound (1..5000) but keeps this route's historical 50-line default.
const browserLogsQuerySchema = logsQuerySchema.pick({ lines: true }).extend({
  lines: z.coerce.number().int().min(1).max(5000).default(50),
});
// SSRF guard (shared with catalog URL ingest): reject non-http(s) schemes
// (file:/chrome:/javascript:) and loopback / link-local / cloud-metadata host
// LITERALS so an agent-driven navigate can't directly target local-file
// exfiltration or a metadata endpoint. Private/LAN + Tailscale hosts stay
// allowed (a single-user tool legitimately drives its browser there);
// `localhost`/`127.x` are blocked — navigate by LAN IP/hostname for a local app.
// This is the FIRST of three layers — a host-literal guard. The hostname→blocked
// (DNS-rebinding) and post-navigate-redirect gaps it can't see are closed in the
// handler: a DNS-resolve pre-check (`assertPublicHttpUrl`) rejects a hostname
// whose A record points at a blocked address, and the CDP pin
// (`navigateToUrlPinned`) verifies Chrome's ACTUAL per-hop connect IP for the
// initial nav, every redirect, and any settle-window navigation.
const navigateSchema = z.object({
  url: z.string().url()
    .refine(isSafeIngestUrl, 'only http(s) URLs to non-loopback/non-link-local hosts are allowed')
});
const restartSchema = z.object({ ticket: z.string().uuid().optional() }).strict();

// Empty string or null from a "clear" UI action → unset (undefined), so the launcher
// falls back to the platform default Chrome instead of trying to spawn "".
const optionalPath = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z.string().max(1024).refine(
    v => !v || !v.includes('..'),
    { message: 'path must not contain path traversal' }
  ).optional()
);

const chromePathSchema = optionalPath.superRefine((value, ctx) => {
  const message = validateChromePath(value);
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

const macAppBundleSchema = optionalPath.superRefine((value, ctx) => {
  const message = validateMacAppBundle(value);
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

const updateConfigSchema = z.object({
  cdpPort: z.number().int().min(1024).max(65535).optional(),
  cdpHost: z.enum(['127.0.0.1', 'localhost', '::1']).optional(),
  healthPort: z.number().int().min(1024).max(65535).optional(),
  autoConnect: z.boolean().optional(),
  headless: z.boolean().optional(),
  userDataDir: z.string().optional(),
  downloadDir: z.string().refine(
    v => !v || !v.includes('..'),
    { message: 'downloadDir must not contain path traversal' }
  ).optional(),
  // Custom Chrome binary (e.g. Chrome Canary). When unset, the launcher falls
  // back to the platform default (`/Applications/Google Chrome.app/...` on
  // macOS, `C:\Program Files\Google\Chrome\...` on Windows, `google-chrome`
  // on Linux).
  chromePath: chromePathSchema,
  // macOS headed mode launches via `open -na <app-bundle>` for TCC reasons,
  // so the bundle (`.app`) path is tracked separately from the executable.
  macAppBundle: macAppBundleSchema,
  canaryPromptDeclined: z.boolean().optional()
});

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

// GET /api/browser/vault/logins - Website logins that may be filled (#17397).
// Metadata only (labels, exact origins, masked username, hasTotp) across every
// household subject; `?origin=` narrows to logins allowed on that exact origin.
router.get('/vault/logins', asyncHandler(async (req, res) => {
  const { origin } = validateRequest(browserVaultListInputSchema, req.query);
  const { listWebsiteLogins } = await import('../services/privacyWebsiteLogins.js');
  res.json(await listWebsiteLogins({ origin, allSubjects: true }));
}));

// POST /api/browser/vault/fill - Model-blind credential fill into one tab.
// Host-control gated like every write. The host decrypts and injects only
// when the tab's live origin exactly matches the login; the response is
// metadata only and never carries a password, seed or 2FA code. Never submits.
router.post('/vault/fill', asyncHandler(async (req, res) => {
  const request = validateRequest(browserVaultFillSchema, req.body);
  const { fillWebsiteLogin } = await import('../services/browserVaultFill.js');
  res.json(await fillWebsiteLogin(request));
}));

// GET /api/browser/health - Quick health check
router.get('/health', asyncHandler(async (req, res) => {
  const health = await browserService.getHealthStatus();
  res.json(health);
}));

// GET /api/browser/process - PM2 process status
router.get('/process', asyncHandler(async (req, res) => {
  const processStatus = await browserService.getProcessStatus();
  res.json(processStatus);
}));

// GET /api/browser/pages - List open CDP pages
router.get('/pages', asyncHandler(async (req, res) => {
  const pages = await browserService.getOpenPages();
  res.json(pages);
}));

// GET /api/browser/version - CDP version info
router.get('/version', asyncHandler(async (req, res) => {
  const version = await browserService.getCdpVersion();
  if (!version) {
    throw new ServerError('Browser not reachable', { status: 503 });
  }
  res.json(version);
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
