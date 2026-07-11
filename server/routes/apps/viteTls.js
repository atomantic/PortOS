/**
 * App config repair: Tailscale TLS upgrade + Vite allowed-hosts guard/remediation.
 *
 *   POST /:id/upgrade-tls      → { ok, helperPath, ... }
 *   GET  /:id/vite-host-check  → { host, hasViteConfig, hostAllowed, canAutoFix }
 *   POST /:id/fix-vite-hosts   → { ok, mode, ... }  (allow-all rewrite or AI CoS task)
 */

import { Router } from 'express';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, atomicWrite } from '../../lib/fileUtils.js';
import * as appsService from '../../services/apps.js';
import { PORTOS_APP_ID } from '../../services/apps.js';
import * as cos from '../../services/cos.js';
import { z } from 'zod';
import { validateRequest } from '../../lib/validation.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { checkViteHost, findViteConfig, rewriteAllowedHosts } from '../../lib/viteAllowedHosts.js';
import { certPaths } from '../../../lib/certPaths.js';
import { loadApp, pathExists } from './shared.js';

const router = Router();

// POST /api/apps/:id/upgrade-tls - Copy the tailscale-https helper into the target app's
// repo and record tlsPort in apps.json so the Launch button prefers HTTPS. The app still
// needs to be edited manually to call createTailscaleServers() — we return an example
// snippet in the response so the frontend can surface it. Refuse to overwrite an existing
// helper unless `force: true` is set; this way a user who has customized their copy keeps it.
const upgradeTlsSchema = z.object({
  tlsPort: z.number().int().min(1).max(65535),
  force: z.boolean().optional()
});
router.post('/:id/upgrade-tls', loadApp, asyncHandler(async (req, res) => {
  const { tlsPort, force } = validateRequest(upgradeTlsSchema, req.body);
  const app = req.loadedApp;
  if (app.id === PORTOS_APP_ID) {
    throw new ServerError('PortOS itself already uses the helper — nothing to upgrade', {
      status: 400, code: 'ALREADY_UPGRADED'
    });
  }
  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repository path not found', { status: 400, code: 'PATH_NOT_FOUND' });
  }
  const sourcePath = join(PATHS.root, 'lib', 'tailscale-https.js');
  const targetDir = join(app.repoPath, 'lib');
  const targetPath = join(targetDir, 'tailscale-https.js');

  const alreadyExists = await pathExists(targetPath);
  if (alreadyExists && !force) {
    throw new ServerError(
      'A tailscale-https.js already exists in the target app. Pass force:true to overwrite.',
      { status: 409, code: 'ALREADY_EXISTS' }
    );
  }

  const helperSource = await readFile(sourcePath, 'utf-8');
  await atomicWrite(targetPath, helperSource);

  await appsService.updateApp(app.id, { tlsPort });

  const snippet = [
    `// In your server entry, replace the direct http.createServer(app).listen(...) with:`,
    `import { createTailscaleServers, watchCertReload } from './lib/tailscale-https.js';`,
    ``,
    `const CERT_DIR = process.env.CERT_DIR || '/path/to/data/certs'; // shared with PortOS`,
    `const { server, mirror, httpsEnabled } = createTailscaleServers(app, { certDir: CERT_DIR });`,
    `// io.attach(server); if (mirror) io.attach(mirror); // when using Socket.IO`,
    `server.listen(${tlsPort}, '0.0.0.0');`,
    `// Optional: bind the HTTP mirror on a port of your choosing (127.0.0.1 only).`,
    `// if (mirror) mirror.listen(<your-mirror-port>, '127.0.0.1');`,
    `if (httpsEnabled) watchCertReload(server, CERT_DIR);`
  ].join('\n');

  res.json({
    ok: true,
    helperPath: targetPath,
    overwrote: alreadyExists,
    tlsPort,
    snippet,
    certDirHint: certPaths(PATHS.data).dir,
    note: 'Point your app at the PortOS cert dir (or symlink it) so apps share the single Tailscale cert.'
  });
}));

// GET /api/apps/:id/vite-host-check?host=<hostname> - Report whether the app's
// Vite dev server would accept requests for `host` (the Tailscale MagicDNS / IP
// name PortOS is served under). Vite ≥5 blocks unknown hosts, so launching an
// app's Dev UI over Tailscale fails until that host is allow-listed. This drives
// the Dev-UI launch guard and the remediation UI in the app detail view.
router.get('/:id/vite-host-check', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const host = typeof req.query.host === 'string' ? req.query.host.trim() : '';
  const extraDirs = (app.processes || []).map((p) => p.cwd).filter(Boolean);
  const status = await checkViteHost(app.repoPath, host, { extraDirs });
  res.json({ host, ...status });
}));

// POST /api/apps/:id/fix-vite-hosts - Remediate the Vite allowedHosts block.
//   mode 'allow-all' (default): deterministically rewrite the app's vite.config
//     to `server.allowedHosts: true`. Safe for a private Tailscale network and
//     the most reliable fix; bails (422) when the config shape is too unusual to
//     edit without risking corruption, steering the user to the AI path.
//   mode 'ai': spawn a CoS agent that edits the app's vite.config in its OWN
//     repo (honoring the Scope Boundary) — handles arbitrary config shapes and
//     can create a vite.config when none exists.
const fixViteHostsSchema = z.object({
  mode: z.enum(['allow-all', 'ai']).default('allow-all'),
  host: z.string().trim().optional()
});
router.post('/:id/fix-vite-hosts', loadApp, asyncHandler(async (req, res) => {
  const { mode, host } = validateRequest(fixViteHostsSchema, req.body);
  const app = req.loadedApp;
  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repository path not found', { status: 400, code: 'PATH_NOT_FOUND' });
  }
  const extraDirs = (app.processes || []).map((p) => p.cwd).filter(Boolean);
  const config = await findViteConfig(app.repoPath, { extraDirs });

  if (mode === 'ai') {
    if (!cos.isRunning()) {
      throw new ServerError(
        'CoS is not running — start it to use AI remediation, or use the automatic fix.',
        { status: 409, code: 'COS_NOT_RUNNING' }
      );
    }
    const where = config ? config.path : `${app.repoPath} (no vite.config found — create one)`;
    const task = await cos.addTask({
      description: `Allow the Tailscale host in ${app.name}'s Vite config so its Dev UI loads`,
      priority: 'MEDIUM',
      app: app.id,
      approvalRequired: true,
      context: [
        `The app "${app.name}" is launched through PortOS over a Tailscale MagicDNS hostname` +
          (host ? ` ("${host}")` : '') + '.',
        'Launching its Vite Dev UI fails with: "Blocked request. This host is not allowed."',
        `Fix: edit ${where} so the dev server's \`server.allowedHosts\` accepts that host.`,
        'Prefer `server.allowedHosts: true` (allow all — this app runs only on a private Tailscale network),',
        'or add the specific host plus a leading-dot `.ts.net` suffix entry. Leave the rest of the config intact.',
        'If no vite config exists, create a minimal vite.config.js that sets server.allowedHosts.'
      ].join('\n')
    }, 'internal');
    return res.json({ ok: true, mode: 'ai', taskId: task.id, configPath: config?.path || null });
  }

  // mode === 'allow-all': deterministic rewrite.
  if (!config) {
    throw new ServerError(
      'No vite.config found to edit automatically — use AI remediation, which can create one.',
      { status: 422, code: 'NO_VITE_CONFIG' }
    );
  }
  const rewrite = rewriteAllowedHosts(config.content);
  if (!rewrite.ok) {
    throw new ServerError(
      `Could not safely auto-edit ${config.filename}: ${rewrite.reason}. Use AI remediation instead.`,
      { status: 422, code: 'AUTO_FIX_UNSAFE' }
    );
  }
  await atomicWrite(config.path, rewrite.content);
  res.json({
    ok: true,
    mode: 'allow-all',
    configPath: config.path,
    filename: config.filename,
    strategy: rewrite.strategy,
    note: 'Restart the app (or its Vite dev server) for the change to take effect.'
  });
}));

export default router;
