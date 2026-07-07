import { Router } from 'express';
import { spawn } from 'child_process';
import { readFile, writeFile, stat, access, mkdir } from 'fs/promises';
import { join, resolve, extname } from 'path';
import { PATHS, tryReadFile, readJSONFile, safeJSONParse, atomicWrite } from '../lib/fileUtils.js';
import * as appsService from '../services/apps.js';
import { notifyAppsChanged, PORTOS_APP_ID } from '../services/apps.js';
import * as pm2Service from '../services/pm2.js';
import * as appUpdater from '../services/appUpdater.js';
import * as appBuilder from '../services/appBuilder.js';
import * as cos from '../services/cos.js';
import { logAction } from '../services/history.js';
import { z } from 'zod';
import { validateRequest, appSchema, appUpdateSchema, sanitizeTaskMetadata, documentUpdateSchema } from '../lib/validation.js';
import * as git from '../services/git.js';
import { parseCronToNextRun } from '../services/eventScheduler.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { parseEcosystemFromPath, usesPm2, writeEcosystemPortEdits } from '../services/streamingDetect.js';
import { checkViteHost, findViteConfig, rewriteAllowedHosts } from '../lib/viteAllowedHosts.js';
import { detectAppIcon, getIconContentType, isUsableSvg } from '../services/appIconDetect.js';
import { hasDeployScript } from '../services/appDeployer.js';
import { checkScripts, installScripts, XCODE_SCRIPT_NAMES } from '../services/xcodeScripts.js';
import { SELF_IMPROVEMENT_TASK_TYPES } from '../services/taskSchedule.js';
import { certPaths } from '../../lib/certPaths.js';

const router = Router();

// Delay before restarting PortOS itself so the JSON response reaches the client
const SELF_RESTART_RESPONSE_DELAY_MS = 500;

/** Async equivalent of existsSync — returns true if the path is accessible */
const pathExists = (p) => access(p).then(() => true).catch(() => false);

/**
 * Derive uiPort from apiPort when app has dev UI but no dedicated prod UI port
 * (prod UI is served by the API server in these cases).
 */
function deriveUiPort(uiPort, apiPort, devUiPort) {
  if (!uiPort && apiPort && devUiPort) return apiPort;
  return uiPort;
}

/**
 * Middleware to load app by :id param and attach to req.loadedApp
 * Throws 404 if not found, eliminating repeated null checks across routes
 */
const loadApp = asyncHandler(async (req, res, next) => {
  const app = await appsService.getAppById(req.params.id);
  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }
  req.loadedApp = app;
  next();
});

// GET /api/apps - List all apps
router.get('/', asyncHandler(async (req, res) => {
  const apps = await appsService.getAllApps();

  // Group apps by their PM2_HOME (null = default)
  const pm2HomeGroups = new Map();
  for (const app of apps) {
    const home = app.pm2Home || null;
    if (!pm2HomeGroups.has(home)) {
      pm2HomeGroups.set(home, []);
    }
    pm2HomeGroups.get(home).push(app);
  }

  // Fetch PM2 processes for each unique PM2_HOME.
  // listProcessesStrict returns `null` on a failed read (vs `[]` for a
  // successful read with no processes) — track those homes so we report
  // `unknown` (status unavailable) instead of `not_started` (confidently not
  // running) for their apps. See getAppStatuses() in the service for the same
  // absent-vs-empty distinction.
  const pm2Maps = new Map();
  const failedHomes = new Set();
  for (const pm2Home of pm2HomeGroups.keys()) {
    const processes = await pm2Service.listProcessesStrict(pm2Home);
    if (processes === null) {
      failedHomes.add(pm2Home);
      pm2Maps.set(pm2Home, new Map());
    } else {
      pm2Maps.set(pm2Home, new Map(processes.map(p => [p.name, p])));
    }
  }

  // Enrich with PM2 status and auto-populate processes if needed
  const enriched = await Promise.all(apps.map(async (app) => {
    // Non-PM2 apps skip PM2 enrichment entirely
    if (!usesPm2(app.type)) {
      return { ...app, pm2Status: {}, overallStatus: 'n/a', hasDeployScript: hasDeployScript(app), xcodeScripts: checkScripts(app) };
    }

    const pm2Home = app.pm2Home || null;
    const pm2Map = pm2Maps.get(pm2Home) || new Map();
    const homeFailed = failedHomes.has(pm2Home);

    const statuses = {};
    for (const processName of app.pm2ProcessNames || []) {
      const pm2Proc = pm2Map.get(processName);
      // A failed PM2 read leaves status genuinely unknown — don't claim
      // `not_found` (which the UI reads as "registered but never launched").
      statuses[processName] = pm2Proc
        ?? { name: processName, status: homeFailed ? 'unknown' : 'not_found', pm2_env: null };
    }

    // Compute overall status. A failed PM2 home short-circuits to `unknown`
    // with a `degraded` flag rather than collapsing to `not_started`.
    const statusValues = Object.values(statuses);
    let overallStatus = 'unknown';
    if (homeFailed) {
      overallStatus = 'unknown';
    } else if (statusValues.some(s => s.status === 'online')) {
      overallStatus = 'online';
    } else if (statusValues.some(s => s.status === 'stopped')) {
      overallStatus = 'stopped';
    } else if (statusValues.every(s => s.status === 'not_found')) {
      overallStatus = 'not_started';
    }

    // Auto-populate processes from ecosystem config if not already set
    let processes = app.processes;
    if ((!processes || processes.length === 0) && await pathExists(app.repoPath)) {
      const parsed = await parseEcosystemFromPath(app.repoPath).catch(() => ({ processes: [] }));
      processes = parsed.processes;
    }

    // Auto-derive uiPort/apiPort/devUiPort from processes when not explicitly set
    let { uiPort, apiPort, devUiPort } = app;
    if (!uiPort && processes?.length) {
      const uiProc = processes.find(p => p.ports?.ui);
      if (uiProc) uiPort = uiProc.ports.ui;
    }
    if (!apiPort && processes?.length) {
      const apiProc = processes.find(p => p.ports?.api);
      if (apiProc) apiPort = apiProc.ports.api;
    }
    if (!devUiPort && processes?.length) {
      const devUiProc = processes.find(p => p.ports?.devUi);
      if (devUiProc) devUiPort = devUiProc.ports.devUi;
    }
    uiPort = deriveUiPort(uiPort, apiPort, devUiPort);

    return {
      ...app,
      processes,
      uiPort,
      devUiPort,
      apiPort,
      pm2Status: statuses,
      overallStatus,
      degraded: homeFailed,
      hasDeployScript: hasDeployScript(app),
      xcodeScripts: checkScripts(app)
    };
  }));

  res.json(enriched);
}));

// GET /api/apps/:id - Get single app
router.get('/:id', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  // Non-PM2 apps skip PM2 status
  let statuses = {};
  let overallStatus = 'n/a';

  let degraded = false;
  if (usesPm2(app.type)) {
    // getAppStatusStrict returns `null` when the PM2 read failed (vs a real
    // status object). A failed read is genuinely unknown, not "not running" —
    // mark `degraded` so the detail UI can offer refresh-to-retry rather than a
    // misleading Start. Mirrors the list endpoint's `degraded`.
    // Read each process's PM2 status in parallel — a detail view of a
    // multi-process app would otherwise serialize one IPC round-trip per process.
    const reads = await Promise.all(
      (app.pm2ProcessNames || []).map(async (processName) => ({
        processName,
        status: await pm2Service.getAppStatusStrict(processName, app.pm2Home),
      })),
    );
    for (const { processName, status } of reads) {
      if (status === null) {
        degraded = true;
        statuses[processName] = { name: processName, status: 'unknown', pm2_env: null };
      } else {
        statuses[processName] = status;
      }
    }

    // Compute overall status (same logic as list endpoint). A degraded read
    // short-circuits to `unknown` rather than collapsing to `not_started`.
    const statusValues = Object.values(statuses);
    overallStatus = 'unknown';
    if (degraded) {
      overallStatus = 'unknown';
    } else if (statusValues.some(s => s.status === 'online')) {
      overallStatus = 'online';
    } else if (statusValues.some(s => s.status === 'stopped')) {
      overallStatus = 'stopped';
    } else if (statusValues.every(s => s.status === 'not_found')) {
      overallStatus = 'not_started';
    }
  }

  // Auto-derive uiPort/apiPort/devUiPort from processes when not explicitly set
  let { uiPort, apiPort, devUiPort } = app;
  const processes = app.processes || [];
  if (!uiPort && processes.length) {
    const uiProc = processes.find(p => p.ports?.ui);
    if (uiProc) uiPort = uiProc.ports.ui;
  }
  if (!apiPort && processes.length) {
    const apiProc = processes.find(p => p.ports?.api);
    if (apiProc) apiPort = apiProc.ports.api;
  }
  if (!devUiPort && processes.length) {
    const devUiProc = processes.find(p => p.ports?.devUi);
    if (devUiProc) devUiPort = devUiProc.ports.devUi;
  }
  uiPort = deriveUiPort(uiPort, apiPort, devUiPort);

  // Read version from app's package.json if available
  let appVersion = null;
  if (app.repoPath) {
    const pkg = await readJSONFile(join(app.repoPath, 'package.json'), null, { logError: false });
    appVersion = pkg?.version || null;
  }

  res.json({ ...app, uiPort, devUiPort, apiPort, overallStatus, degraded, pm2Status: statuses, appVersion, hasDeployScript: hasDeployScript(app), xcodeScripts: checkScripts(app) });
}));

// POST /api/apps/:id/xcode-scripts/install - Install missing management scripts
// Restrict the request payload to the known, fixed set of script names so that
// arbitrary or oversized arrays are rejected at the validation layer.
const installScriptsSchema = z.object({
  scripts: z.array(z.enum(XCODE_SCRIPT_NAMES)).min(1).max(XCODE_SCRIPT_NAMES.length)
});
router.post('/:id/xcode-scripts/install', loadApp, asyncHandler(async (req, res) => {
  const { scripts } = validateRequest(installScriptsSchema, req.body);
  if (!req.loadedApp.repoPath || !await pathExists(req.loadedApp.repoPath)) {
    throw new ServerError('App repository path not found', { status: 400, code: 'PATH_NOT_FOUND' });
  }
  const result = await installScripts(req.loadedApp, scripts);
  if (result.errors.length && !result.installed.length) {
    throw new ServerError(result.errors.join(', '), { status: 400, code: 'INSTALL_FAILED' });
  }
  res.json(result);
}));

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

// GET /api/apps/:id/icon - Serve the app's detected icon image
router.get('/:id/icon', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  // Use stored appIconPath, or detect on-the-fly. Stored SVGs that embed an
  // external <image href="..."> render blank under the route's `default-src
  // 'none'` CSP, so re-detect when the cached path is an unusable SVG (e.g.
  // PortOS's own favicon.svg, which wraps a /portos-logo.png reference) —
  // otherwise installs that resolved an icon BEFORE the detector learned to
  // skip these stay broken until the user manually re-detects.
  let iconPath = app.appIconPath;
  const stale =
    !iconPath ||
    !await pathExists(iconPath) ||
    (extname(iconPath).toLowerCase() === '.svg' && !await isUsableSvg(iconPath));
  if (stale) {
    iconPath = await detectAppIcon(app.repoPath, app.type);
    if (iconPath && iconPath !== app.appIconPath) {
      await appsService.updateApp(app.id, { appIconPath: iconPath });
    }
  }

  if (!iconPath || !await pathExists(iconPath)) {
    throw new ServerError('No app icon found', { status: 404 });
  }

  const contentType = getIconContentType(iconPath);
  const iconStat = await stat(iconPath).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (!iconStat) throw new ServerError('No app icon found', { status: 404 });
  const etag = `W/"${iconStat.mtimeMs.toString(36)}-${iconStat.size.toString(36)}"`;

  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('ETag', etag);
  res.set('X-Content-Type-Options', 'nosniff');
  if (contentType === 'image/svg+xml') {
    res.set('Content-Disposition', 'inline; filename="icon.svg"');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  }

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) {
    const tags = ifNoneMatch.split(',').map(v => v.trim());
    if (tags.includes('*') || tags.includes(etag)) {
      return res.status(304).end();
    }
  }

  const iconData = await readFile(iconPath).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (!iconData) throw new ServerError('No app icon found', { status: 404 });
  res.send(iconData);
}));

// POST /api/apps - Create new app
router.post('/', asyncHandler(async (req, res, next) => {
  const data = validateRequest(appSchema, req.body);

  // Detect app icon before creation to avoid a double write
  if (data.repoPath) {
    const detectedIcon = await detectAppIcon(data.repoPath, data.type);
    if (detectedIcon) data.appIconPath = detectedIcon;
  }

  const app = await appsService.createApp(data);
  res.status(201).json(app);
}));

// PUT /api/apps/:id - Update app
router.put('/:id', asyncHandler(async (req, res, next) => {
  const data = validateRequest(appUpdateSchema, req.body);

  // Only port edits need the canonical-config write-back below; snapshot the
  // pre-update ports just for those so ordinary updates (rename, archive,
  // jira/datadog) don't pay the extra read + fs stat. tlsPort is omitted: it's
  // synthetic (derived from cert presence / upgradeAppTls), never a literal in
  // ecosystem.config.cjs, so there's nothing to rewrite for it.
  const PORT_KEYS = ['apiPort', 'uiPort', 'devUiPort'];
  const hasPortUpdate = PORT_KEYS.some(key => key in data);
  const existing = hasPortUpdate ? await appsService.getAppById(req.params.id) : null;

  // Port fields in apps.json are *derived* from ecosystem.config.cjs (the
  // source of truth PM2 reads). Persist the change to the canonical config
  // FIRST, before the derived registry: an unreadable/unwritable config then
  // surfaces as a failed request instead of a 200 that leaves apps.json and
  // PM2 disagreeing (the write throws and bubbles to the error middleware).
  if (existing && usesPm2(existing.type) && await pathExists(existing.repoPath)) {
    // Diff the submitted ports against the ACTUAL config values (not apps.json,
    // whose top-level fields may be stale or absent for derived ports). This
    // is the single source of truth for both "did it change" and "what's the
    // old literal to rewrite": EditAppModal submits every field even on a
    // rename, so a value equal to the config's current port is a no-op echo,
    // and a value that differs is a genuine edit to persist.
    const { processes: cfgProcs } = await parseEcosystemFromPath(existing.repoPath);
    const LABEL_BY_KEY = { apiPort: 'api', uiPort: 'ui', devUiPort: 'devUi' };
    const currentPort = {};
    const procNameByKey = {}; // which process block owns each label (for targeted rewrites)
    for (const proc of cfgProcs || []) {
      for (const [key, label] of Object.entries(LABEL_BY_KEY)) {
        if (currentPort[key] === undefined && Number.isInteger(proc.ports?.[label])) {
          currentPort[key] = proc.ports[label];
          procNameByKey[key] = proc.name;
        }
      }
    }
    // Count current values so a value-keyed rewrite never fires on a number
    // shared by another port field (e.g. uiPort derived from apiPort, both
    // 6000) — that would rewrite every occurrence and clobber the field the
    // user didn't touch. Such a value can't be split by value alone; it falls
    // through to the per-process-label-targeted rewrite below.
    const valueCounts = new Map();
    for (const key of PORT_KEYS) {
      const v = currentPort[key];
      if (Number.isInteger(v)) valueCounts.set(v, (valueCounts.get(v) || 0) + 1);
    }
    // A port is "changed" when the submitted value differs from the config's
    // current value for that label. A field the config doesn't define has no
    // literal to rewrite, so it isn't treated as a config edit here.
    const changedKeys = PORT_KEYS.filter(key =>
      Number.isInteger(currentPort[key]) && Number.isInteger(data[key]) && data[key] !== currentPort[key]);

    // Served-by-API detection. When an app has an API process plus a Vite dev
    // UI but no literal `ports.ui`, the prod UI is served by the API server, so
    // the `uiPort` is *derived* (= apiPort) and CANNOT be set independently —
    // there's no separate UI port literal in the config to rewrite. The edit
    // drawer always submits every port field and never syncs the UI field to a
    // changed API field, so an API-only edit arrives as `{ apiPort: <new>,
    // uiPort: <old derived> }`. We can't distinguish that stale echo from a
    // deliberate (impossible) independent UI change, so the only coherent
    // behavior is to IGNORE the submitted uiPort entirely and pin the stored
    // value to the derived port (= the post-edit API port). That tracks the API
    // port on every save, never reverts, and never spuriously 422s the common
    // API-edit path. The user changes this UI port by changing the API port.
    const effectiveApiPort = Number.isInteger(data.apiPort) ? data.apiPort : currentPort.apiPort;
    const derivedUiPort = deriveUiPort(undefined, effectiveApiPort, currentPort.devUiPort);
    const uiIsDerived = currentPort.uiPort === undefined && Number.isInteger(derivedUiPort);
    const remap = [];
    const targetedEdits = []; // shared-value keys: rewritten by process + label
    for (const key of changedKeys) {
      const oldPort = currentPort[key]; // guaranteed integer by the filter above
      // Value shared with another field (can't disambiguate by value): target
      // the specific process block + label so the edit lands on exactly the
      // port the user touched, not every occurrence of the shared literal.
      if (valueCounts.get(oldPort) > 1 && procNameByKey[key]) {
        targetedEdits.push({ processName: procNameByKey[key], label: LABEL_BY_KEY[key], oldPort, newPort: data[key] });
        continue;
      }
      remap.push([oldPort, data[key]]);
    }

    // Pin the stored uiPort to the derived value for served-by-API apps (see
    // above). This both overwrites the drawer's echoed/stale UI field and keeps
    // the stored value tracking apiPort — deleting `data.uiPort` would NOT be
    // enough, since updateApp merges omitted fields over the existing record, so
    // a stale explicit `uiPort` from an earlier refresh would survive (truthy)
    // and block re-derivation (after API 6000→7000 the GET path would keep
    // returning 6000). Writing the derived value self-corrects on every save.
    // (uiIsDerived is computed from the parsed CONFIG, not apps.json, so it's
    // true even when apps.json already holds a stale explicit value.)
    if (uiIsDerived) {
      data.uiPort = derivedUiPort;
    }

    // Persist the value-keyed remap (distinct ports) and the targeted edits
    // (shared-value ports) in ONE atomic write. Doing them as two separate
    // writes would let the value-keyed pass land on disk before a later
    // unpersistable targeted edit forces the 422 below — leaving config
    // partially changed for a rejected request. writeEcosystemPortEdits
    // computes both rewrites in memory and writes only when nothing is
    // unpersistable.
    const result = changedKeys.length > 0
      ? await writeEcosystemPortEdits(existing.repoPath, remap, targetedEdits)
      : { changed: false, remapApplied: false, applied: [], unapplied: [] };
    if (result.changed) {
      const remapMsg = result.remapApplied ? remap.map(([o, n]) => `${o}→${n}`).join(', ') : '';
      const tgtMsg = targetedEdits.map(e => `${e.label} ${e.oldPort}→${e.newPort}`).join(', ');
      console.log(`🔧 Updated ${result.file} ports for ${existing.name}: ${[remapMsg, tgtMsg].filter(Boolean).join(', ')} (restart the app to apply)`);
    }

    // Honesty gate: if the user changed a port we could NOT write to the
    // source-of-truth config, reject the whole update rather than persist a
    // registry value PM2 will contradict (and the next refresh will revert).
    // `remap.length && !remapApplied` catches value-keyed pairs whose literal
    // wasn't found; `unapplied` catches process/label edits that didn't match.
    // On any unpersistable targeted edit the writer persists nothing, so this
    // reject leaves the config untouched.
    const valueKeyedFailed = remap.length > 0 && !result.remapApplied;
    const targetedFailed = (result.unapplied || []).length > 0;
    if (changedKeys.length > 0 && (valueKeyedFailed || targetedFailed)) {
      throw new ServerError(
        `Could not persist port change to ${existing.name}'s ecosystem config — the port is derived from process config or is not a literal value. Edit the ecosystem.config.cjs directly to change this port.`,
        { status: 422, code: 'PORT_NOT_PERSISTABLE' }
      );
    }
  }

  // layeredIntelligence must go through the dedicated merge helper — the generic
  // updateApp shallow-REPLACES the nested object, so a partial patch like
  // { layeredIntelligence: { enabled: true } } would wipe stored sources /
  // allowedScopes / providerId / lastRunAt. Pull it out, apply the rest, then
  // merge-apply the config so untouched fields are preserved.
  const { layeredIntelligence: liUpdate, ...rest } = data;
  const app = await appsService.updateApp(req.params.id, rest);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  if (liUpdate !== undefined) {
    const merged = await appsService.updateAppLayeredIntelligence(req.params.id, liUpdate);
    res.json(merged || app);
    return;
  }

  res.json(app);
}));

// DELETE /api/apps/:id - Delete app (PortOS baseline cannot be deleted)
router.delete('/:id', asyncHandler(async (req, res, next) => {
  if (req.params.id === PORTOS_APP_ID) {
    throw new ServerError('PortOS baseline app cannot be deleted', { status: 403, code: 'PROTECTED' });
  }

  const deleted = await appsService.deleteApp(req.params.id);

  if (!deleted) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.status(204).send();
}));

// POST /api/apps/:id/archive - Archive app (exclude from COS tasks)
router.post('/:id/archive', asyncHandler(async (req, res) => {
  if (req.params.id === PORTOS_APP_ID) {
    throw new ServerError('PortOS baseline app cannot be archived', { status: 403, code: 'PROTECTED' });
  }

  const app = await appsService.archiveApp(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  console.log(`📦 Archived app: ${app.name}`);
  notifyAppsChanged('archive');
  res.json(app);
}));

// POST /api/apps/:id/unarchive - Unarchive app (include in COS tasks)
router.post('/:id/unarchive', asyncHandler(async (req, res) => {
  const app = await appsService.unarchiveApp(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  console.log(`📤 Unarchived app: ${app.name}`);
  notifyAppsChanged('unarchive');
  res.json(app);
}));

// PUT /api/apps/bulk-task-type/:taskType - Enable/disable a task type for all active apps
router.put('/bulk-task-type/:taskType', asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    throw new ServerError('enabled (boolean) is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (!SELF_IMPROVEMENT_TASK_TYPES.includes(req.params.taskType)) {
    throw new ServerError(`Unknown task type '${req.params.taskType}'`, { status: 400, code: 'INVALID_TASK_TYPE' });
  }

  const result = await appsService.bulkUpdateAppTaskTypeOverride(req.params.taskType, { enabled });
  console.log(`📋 Bulk ${enabled ? 'enabled' : 'disabled'} task type ${req.params.taskType} for ${result.count} apps`);
  res.json({ success: true, taskType: req.params.taskType, enabled, appsUpdated: result.count });
}));

// POST /api/apps/detect-icons - Detect and persist app icons for all apps
router.post('/detect-icons', asyncHandler(async (req, res) => {
  const apps = await appsService.getAllApps();
  let detected = 0;

  for (const app of apps) {
    if (!app.repoPath || !await pathExists(app.repoPath)) continue;
    // Skip apps that already have a valid icon path
    if (app.appIconPath && await pathExists(app.appIconPath)) continue;

    const iconPath = await detectAppIcon(app.repoPath, app.type);
    if (iconPath) {
      await appsService.updateApp(app.id, { appIconPath: iconPath });
      detected++;
      console.log(`🎨 Detected icon for ${app.name}: ${iconPath.split('/').pop()}`);
    }
  }

  if (detected > 0) notifyAppsChanged('detect-icons');
  console.log(`🎨 Icon detection complete: ${detected}/${apps.length} apps`);
  res.json({ success: true, detected, total: apps.length });
}));

// POST /api/apps/:id/detect-icon - Detect and persist app icon for a single app
router.post('/:id/detect-icon', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repoPath is missing or inaccessible', { status: 400, code: 'INVALID_REPO_PATH' });
  }

  const iconPath = await detectAppIcon(app.repoPath, app.type);
  if (!iconPath) {
    console.log(`🎨 No icon detected for ${app.name}`);
    res.json({ success: true, detected: false, appIconPath: null });
    return;
  }

  await appsService.updateApp(app.id, { appIconPath: iconPath });
  notifyAppsChanged('detect-icon');
  console.log(`🎨 Detected icon for ${app.name}: ${iconPath.split('/').pop()}`);
  res.json({ success: true, detected: true, appIconPath: iconPath });
}));

// GET /api/apps/:id/task-types - Get per-app task type overrides
router.get('/:id/task-types', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const overrides = await appsService.getAppTaskTypeOverrides(app.id);
  res.json({ appId: app.id, appName: app.name, taskTypeOverrides: overrides });
}));

// GET /api/apps/:id/work-tracker - Resolve where this app's autonomous work
// items live (PLAN.md / GitHub / GitLab / JIRA). 'auto' resolves from the git
// origin host; see server/lib/workTracker.js. Read-only — the value itself is
// saved through the generic PUT /api/apps/:id (appUpdateSchema.workTracker).
router.get('/:id/work-tracker', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const info = await appsService.getAppWorkTracker(app.id);
  res.json({ appId: app.id, appName: app.name, ...info });
}));

// GET /api/apps/:id/layered-intelligence - Effective Layered Intelligence config
// for this app (the self-improvement loop). Merges the app's stored partial
// config over the shipped defaults so the UI always renders a complete, safe
// config — including the isPortos-derived scope set. Read-only; the value is
// saved through PUT /api/apps/:id (layeredIntelligence goes via the dedicated
// merge helper there). See server/services/layeredIntelligence.js.
router.get('/:id/layered-intelligence', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const config = await appsService.getAppLayeredIntelligenceConfig(app.id);
  res.json({ appId: app.id, appName: app.name, isPortos: app.id === PORTOS_APP_ID, config });
}));

// PUT /api/apps/:id/task-types/all - Toggle all task types for an app
router.put('/:id/task-types/all', loadApp, asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    throw new ServerError('enabled must be a boolean', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const result = await appsService.toggleAllAppTaskTypes(req.params.id, enabled);
  if (!result) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }
  console.log(`📋 ${enabled ? 'Enabled' : 'Disabled'} all task types for ${result.name}`);
  res.json({ success: true, appId: result.id, taskTypeOverrides: result.taskTypeOverrides || {} });
}));

// PUT /api/apps/:id/task-types/:taskType - Update a task type override for an app
router.put('/:id/task-types/:taskType', asyncHandler(async (req, res) => {
  const { enabled, interval, taskMetadata } = req.body;
  if (!SELF_IMPROVEMENT_TASK_TYPES.includes(req.params.taskType)) {
    throw new ServerError(`Unknown task type '${req.params.taskType}'`, { status: 400, code: 'INVALID_TASK_TYPE' });
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ServerError('enabled must be a boolean', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (typeof enabled !== 'boolean' && interval === undefined && taskMetadata === undefined) {
    throw new ServerError('enabled (boolean), interval (string|null), or taskMetadata (object|null) required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Validate and sanitize taskMetadata to allowed agent-option keys only
  let sanitizedTaskMetadata;
  if (taskMetadata === undefined) {
    sanitizedTaskMetadata = undefined;
  } else if (taskMetadata === null) {
    sanitizedTaskMetadata = null;
  } else {
    if (typeof taskMetadata !== 'object' || Array.isArray(taskMetadata)) {
      throw new ServerError('taskMetadata must be an object or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
    sanitizedTaskMetadata = sanitizeTaskMetadata(taskMetadata);
    if (sanitizedTaskMetadata === null) {
      throw new ServerError('Invalid taskMetadata: unrecognized keys or values', { status: 400, code: 'VALIDATION_ERROR' });
    }
  }

  // Validate interval against allowed values (also accepts 5-field cron expressions)
  if (interval !== undefined) {
    const allowedIntervals = ['rotation', 'daily', 'weekly', 'once', 'on-demand'];
    if (interval !== null && typeof interval === 'string') {
      const isCron = interval.trim().split(/\s+/).length === 5;
      if (!isCron && !allowedIntervals.includes(interval)) {
        throw new ServerError('interval must be one of rotation|daily|weekly|once|on-demand, a cron expression, or null', { status: 400, code: 'VALIDATION_ERROR' });
      }
      if (isCron) {
        // Validate syntax and field ranges (parseCronToNextRun throws on invalid expressions)
        // Note: null return means no match within search window (e.g. leap day) -- not invalid
        parseCronToNextRun(interval, new Date(), 'UTC');
      }
    } else if (interval !== null) {
      throw new ServerError('interval must be a string or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
  }

  const result = await appsService.updateAppTaskTypeOverride(req.params.id, req.params.taskType, { enabled, interval, taskMetadata: sanitizedTaskMetadata });
  if (!result) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  const action = typeof enabled === 'boolean' ? (enabled ? 'Enabled' : 'Disabled') : 'Updated interval for';
  console.log(`📋 ${action} task type ${req.params.taskType} for ${result.name}`);
  res.json({ success: true, appId: result.id, taskType: req.params.taskType, enabled, interval, taskTypeOverrides: result.taskTypeOverrides || {} });
}));

// POST /api/apps/:id/start - Start app via PM2
router.post('/:id/start', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!usesPm2(app.type)) {
    throw new ServerError(`${app.type} apps cannot be started via PM2`, { status: 400, code: 'NOT_PM2_APP' });
  }

  const processNames = app.pm2ProcessNames || [app.name.toLowerCase().replace(/\s+/g, '-')];

  // Check if ecosystem config exists - prefer using it for proper env var handling
  const ecosystemChecks = await Promise.all(
    ['ecosystem.config.cjs', 'ecosystem.config.js'].map(f => pathExists(`${app.repoPath}/${f}`))
  );
  const hasEcosystem = ecosystemChecks.some(Boolean);

  let results = {};

  if (hasEcosystem) {
    // Use ecosystem config for proper env/port configuration
    // Pass custom PM2_HOME if the app has one
    const result = await pm2Service.startFromEcosystem(app.repoPath, processNames, app.pm2Home)
      .catch(err => ({ success: false, error: err.message }));
    // Map result to each process name for consistent response format
    for (const name of processNames) {
      results[name] = result;
    }
  } else {
    // Fallback to command-based start for apps without ecosystem config
    const commands = app.startCommands || ['npm run dev'];
    for (let i = 0; i < processNames.length; i++) {
      const name = processNames[i];
      const command = commands[i] || commands[0];
      const result = await pm2Service.startWithCommand(name, app.repoPath, command)
        .catch(err => ({ success: false, error: err.message }));
      results[name] = result;
    }
  }

  const allSuccess = Object.values(results).every(r => r.success !== false);
  await logAction('start', app.id, app.name, { processNames }, allSuccess);
  notifyAppsChanged('start');

  res.json({ success: true, results });
}));

// POST /api/apps/:id/stop - Stop app
router.post('/:id/stop', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!usesPm2(app.type)) {
    throw new ServerError(`${app.type} apps cannot be stopped via PM2`, { status: 400, code: 'NOT_PM2_APP' });
  }

  const results = {};

  for (const name of app.pm2ProcessNames || []) {
    const result = await pm2Service.stopApp(name, app.pm2Home)
      .catch(err => ({ success: false, error: err.message }));
    results[name] = result;
  }

  const allSuccess = Object.values(results).every(r => r.success !== false);
  await logAction('stop', app.id, app.name, { processNames: app.pm2ProcessNames }, allSuccess);
  notifyAppsChanged('stop');

  res.json({ success: true, results });
}));

// POST /api/apps/:id/restart - Restart app
router.post('/:id/restart', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!usesPm2(app.type)) {
    throw new ServerError(`${app.type} apps cannot be restarted via PM2`, { status: 400, code: 'NOT_PM2_APP' });
  }

  // Self-restart: respond first, then restart after a delay so the response reaches the client
  if (app.id === PORTOS_APP_ID) {
    await logAction('restart', app.id, app.name, { processNames: app.pm2ProcessNames }, true);
    notifyAppsChanged('restart');
    res.json({ success: true, selfRestart: true });
    setTimeout(async () => {
      console.log('🔄 Self-restart: restarting PortOS processes');
      for (const name of app.pm2ProcessNames || []) {
        await pm2Service.restartApp(name, app.pm2Home)
          .catch(err => console.error(`❌ Self-restart failed for ${name}: ${err.message}`));
      }
    }, SELF_RESTART_RESPONSE_DELAY_MS);
    return;
  }

  const results = {};

  for (const name of app.pm2ProcessNames || []) {
    const result = await pm2Service.restartApp(name, app.pm2Home)
      .catch(err => ({ success: false, error: err.message }));
    results[name] = result;
  }

  const allSuccess = Object.values(results).every(r => r.success !== false);
  await logAction('restart', app.id, app.name, { processNames: app.pm2ProcessNames }, allSuccess);
  notifyAppsChanged('restart');

  res.json({ success: true, results });
}));

// POST /api/apps/:id/update - Pull, install deps, setup, restart
router.post('/:id/update', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  console.log(`⬇️ Starting update for ${app.name}`);
  const progressSteps = [];
  const emit = (step, status, message) => {
    progressSteps.push({ step, status, message, timestamp: Date.now() });
  };

  const result = await appUpdater.updateApp(app, emit);
  const success = result.success;
  await logAction('update', app.id, app.name, { steps: result.steps }, success);
  notifyAppsChanged('update');
  console.log(`${success ? '✅' : '❌'} Update ${success ? 'complete' : 'failed'} for ${app.name}`);

  res.json({ success, steps: result.steps, progress: progressSteps });
}));

// POST /api/apps/:id/build - Build production UI
router.post('/:id/build', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const result = await appBuilder.buildApp(app);

  if (result.failure === 'validation') {
    throw new ServerError(result.message, { status: 400, code: result.code });
  }

  if (result.failure === 'install') {
    await logAction('build', app.id, app.name, { buildCommand: result.buildCommand, step: `npm install (${result.label})` }, false);
    throw new ServerError(`npm install failed (${result.label}) exit=${result.exitCode}: ${result.output}`, { status: 500, code: 'INSTALL_FAILED' });
  }

  await logAction('build', app.id, app.name, { buildCommand: result.buildCommand }, result.success);

  if (!result.success) {
    const detail = result.signal ? `killed by ${result.signal}` : result.output || `exit code ${result.code}`;
    throw new ServerError(`Build failed: ${detail}`, { status: 500, code: 'BUILD_FAILED' });
  }

  res.json({ success: true, output: result.output });
}));

// GET /api/apps/:id/status - Get PM2 status
router.get('/:id/status', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!usesPm2(app.type)) {
    return res.json({});
  }

  const statuses = {};

  for (const name of app.pm2ProcessNames || []) {
    const status = await pm2Service.getAppStatus(name, app.pm2Home)
      .catch(err => ({ status: 'error', error: err.message }));
    statuses[name] = status;
  }

  res.json(statuses);
}));

// GET /api/apps/:id/logs - Get logs
router.get('/:id/logs', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const lines = parseInt(req.query.lines, 10) || 100;
  const processName = req.query.process || app.pm2ProcessNames?.[0];

  if (!processName) {
    throw new ServerError('No process name specified', { status: 400, code: 'MISSING_PROCESS' });
  }

  const logs = await pm2Service.getLogs(processName, lines, app.pm2Home)
    .catch(err => `Error retrieving logs: ${err.message}`);

  res.json({ processName, lines, logs });
}));

// Allowlist of safe editor commands
// Security: Only allow known-safe editor commands to prevent arbitrary code execution
const ALLOWED_EDITORS = new Set([
  'code',      // VS Code
  'cursor',    // Cursor
  'zed',       // Zed
  'subl',      // Sublime Text
  'atom',      // Atom
  'vim',       // Vim
  'nvim',      // Neovim
  'nano',      // Nano
  'emacs',     // Emacs
  'idea',      // IntelliJ IDEA
  'pycharm',   // PyCharm
  'webstorm',  // WebStorm
  'phpstorm',  // PhpStorm
  'rubymine',  // RubyMine
  'goland',    // GoLand
  'clion',     // CLion
  'rider',     // Rider
  'studio',    // Android Studio
  'xed'        // Xcode
]);

// POST /api/apps/:id/open-editor - Open app in editor
router.post('/:id/open-editor', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const editorCommand = app.editorCommand || 'code .';
  const [cmd, ...args] = editorCommand.split(/\s+/);

  // Security: Validate that the editor command is in our allowlist
  // This prevents arbitrary command execution via malicious editorCommand values
  if (!ALLOWED_EDITORS.has(cmd)) {
    throw new ServerError(`Editor '${cmd}' is not in the allowed editors list`, {
      status: 400,
      code: 'INVALID_EDITOR',
      context: { allowedEditors: Array.from(ALLOWED_EDITORS) }
    });
  }

  // Security: Validate args don't contain shell metacharacters
  const DANGEROUS_CHARS = /[;|&`$(){}[\]<>\\!#*?~]/;
  for (const arg of args) {
    if (DANGEROUS_CHARS.test(arg)) {
      throw new ServerError('Editor arguments contain disallowed characters', {
        status: 400,
        code: 'INVALID_EDITOR_ARGS'
      });
    }
  }

  // Spawn the editor process detached so it doesn't block.
  // On Windows, editor binaries are typically `.cmd`/`.bat` shims (e.g. `code.cmd`,
  // `cursor.cmd`) which Node refuses to spawn without a shell since 20.12.2 — so we
  // opt into the shell on win32. Args are pre-sanitized for shell metacharacters
  // above, and the command is allowlisted.
  const child = spawn(cmd, args, {
    cwd: app.repoPath,
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    windowsHide: true
  });
  child.unref();

  res.json({ success: true, command: editorCommand, path: app.repoPath });
}));

// POST /api/apps/:id/open-claude - Open Claude Code in app directory
router.post('/:id/open-claude', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  // shell:true on Windows so `claude.cmd` resolves (see open-editor above for the
  // Node 20.12.2 rationale). No user args reach the command line here.
  const child = spawn('claude', [], {
    cwd: app.repoPath,
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    windowsHide: true
  });
  child.unref();

  console.log(`🤖 Opened Claude Code in ${app.name}`);
  res.json({ success: true, path: app.repoPath });
}));

// POST /api/apps/:id/open-folder - Open app folder in file manager
router.post('/:id/open-folder', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  // Cross-platform folder open command
  const platform = process.platform;
  let cmd, args;

  if (platform === 'darwin') {
    cmd = 'open';
    args = [app.repoPath];
  } else if (platform === 'win32') {
    cmd = 'explorer';
    args = [app.repoPath];
  } else {
    cmd = 'xdg-open';
    args = [app.repoPath];
  }

  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  res.json({ success: true, path: app.repoPath });
}));

// POST /api/apps/:id/refresh-config - Re-parse ecosystem config for PM2 processes
router.post('/:id/refresh-config', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!usesPm2(app.type)) {
    return res.json({ success: true, updated: false, app, processes: [] });
  }

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  // Parse ecosystem config from the app's repo path
  const { processes, pm2Home } = await parseEcosystemFromPath(app.repoPath);

  // Update app with new process data
  const updates = {};

  // Detect buildCommand from package.json if not already set
  if (!app.buildCommand) {
    const pkgPath = join(app.repoPath, 'package.json');
    const pkgContent = await tryReadFile(pkgPath);
    if (pkgContent) {
      const pkg = safeJSONParse(pkgContent);
      if (pkg?.scripts?.build) updates.buildCommand = 'npm run build';
    }
  }

  // Update pm2Home if detected and different from current
  if (pm2Home && pm2Home !== app.pm2Home) {
    updates.pm2Home = pm2Home;
  }

  if (processes.length > 0) {
    updates.processes = processes;
    updates.pm2ProcessNames = processes.map(p => p.name);

    // Derive ports from parsed process labels (same logic as streamDetection)
    const apiProc = processes.find(p => p.ports?.api);
    if (apiProc) updates.apiPort = apiProc.ports.api;

    const uiProc = processes.find(p => p.ports?.ui);
    if (uiProc) updates.uiPort = uiProc.ports.ui;

    const devUiProc = processes.find(p => p.ports?.devUi);
    if (devUiProc) updates.devUiPort = devUiProc.ports.devUi;

    updates.uiPort = deriveUiPort(updates.uiPort, updates.apiPort, updates.devUiPort || app.devUiPort);
  }

  // Detect app icon if not already set, missing on disk, or stored as an
  // unusable external-image SVG (won't render under the icon route's CSP).
  const iconStale =
    !app.appIconPath ||
    !await pathExists(app.appIconPath) ||
    (extname(app.appIconPath).toLowerCase() === '.svg' && !await isUsableSvg(app.appIconPath));
  if (iconStale) {
    const detectedIcon = await detectAppIcon(app.repoPath, app.type);
    if (detectedIcon) updates.appIconPath = detectedIcon;
  }

  // Only update if we have changes
  if (Object.keys(updates).length > 0) {
    const updatedApp = await appsService.updateApp(req.params.id, updates);
    console.log(`🔄 Refreshed config for ${app.name}: ${processes.length} processes found`);
    res.json({ success: true, updated: true, app: updatedApp, processes });
  } else {
    console.log(`🔄 No config changes for ${app.name}`);
    res.json({ success: true, updated: false, app, processes: app.processes || [] });
  }
}));

// ============================================================
// Document Endpoints
// ============================================================

const ALLOWED_DOCUMENTS = ['PLAN.md', 'CLAUDE.md', 'GOALS.md', 'REVIEW.md', 'REJECTED.md'];

// GET /api/apps/:id/documents - List which documents exist
router.get('/:id/documents', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    return res.json({ documents: [], hasPlanning: false });
  }

  const documents = await Promise.all(ALLOWED_DOCUMENTS.map(async filename => ({
    filename,
    exists: await pathExists(join(app.repoPath, filename))
  })));

  const planningDir = join(app.repoPath, '.planning');
  const hasPlanning = await pathExists(planningDir);

  // GSD status: detect which GSD artifacts exist
  const gsd = {
    hasCodebaseMap: await pathExists(join(planningDir, 'codebase')),
    hasProject: await pathExists(join(planningDir, 'PROJECT.md')),
    hasRoadmap: await pathExists(join(planningDir, 'ROADMAP.md')),
    hasState: await pathExists(join(planningDir, 'STATE.md')),
    hasConcerns: await pathExists(join(planningDir, 'CONCERNS.md')),
  };

  res.json({ documents, hasPlanning, gsd });
}));

// GET /api/apps/:id/documents/:filename - Read a single document
router.get('/:id/documents/:filename', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { filename } = req.params;

  if (!ALLOWED_DOCUMENTS.includes(filename)) {
    throw new ServerError('Document not in allowlist', { status: 400, code: 'INVALID_DOCUMENT' });
  }

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const filePath = join(app.repoPath, filename);
  const resolved = resolve(filePath);

  // Path traversal guard
  if (!resolved.startsWith(resolve(app.repoPath))) {
    throw new ServerError('Invalid document path', { status: 400, code: 'PATH_TRAVERSAL' });
  }

  if (!await pathExists(resolved)) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }

  const content = await readFile(resolved, 'utf-8');
  res.json({ filename, content });
}));

// PUT /api/apps/:id/documents/:filename - Update a document and git commit
router.put('/:id/documents/:filename', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { filename } = req.params;

  if (!ALLOWED_DOCUMENTS.includes(filename)) {
    throw new ServerError('Document not in allowlist', { status: 400, code: 'INVALID_DOCUMENT' });
  }

  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repo path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const filePath = join(app.repoPath, filename);
  const resolved = resolve(filePath);

  if (!resolved.startsWith(resolve(app.repoPath))) {
    throw new ServerError('Invalid document path', { status: 400, code: 'PATH_TRAVERSAL' });
  }

  const { content, commitMessage } = documentUpdateSchema.parse(req.body);
  const created = !await pathExists(resolved);

  await atomicWrite(resolved, content);
  await git.stageFiles(app.repoPath, [filename]);

  const status = await git.getStatus(app.repoPath);
  if (status.clean) {
    return res.json({ success: true, noChanges: true });
  }

  const message = commitMessage || `docs: update ${filename} via PortOS`;
  const result = await git.commit(app.repoPath, message);
  console.log(`📝 ${created ? 'Created' : 'Updated'} ${filename} in ${app.name} (${result.hash})`);

  res.json({ success: true, hash: result.hash, created });
}));

// ============================================================
// Agent History Endpoints
// ============================================================

// GET /api/apps/:id/agents - Recent CoS agents for this app
router.get('/:id/agents', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const limit = parseInt(req.query.limit, 10) || 50;

  // Get running agents filtered by this app
  const runningAgents = await cos.getAgents().catch(() => []);
  const appRunning = runningAgents.filter(a =>
    a.metadata?.app === app.id || a.metadata?.taskApp === app.id
  );

  // Scan last 14 days of agent history for this app
  const dates = await cos.getAgentDates().catch(() => []);
  const recentDates = dates.slice(0, 14);
  const historyAgents = [];

  for (const { date } of recentDates) {
    if (historyAgents.length >= limit) break;
    const dayAgents = await cos.getAgentsByDate(date).catch(() => []);
    const appAgents = dayAgents.filter(a =>
      a.metadata?.app === app.id || a.metadata?.taskApp === app.id
    );
    historyAgents.push(...appAgents);
  }

  // Combine running + history, deduplicate by id, limit
  const seenIds = new Set();
  const combined = [];
  for (const agent of [...appRunning, ...historyAgents]) {
    if (seenIds.has(agent.id)) continue;
    seenIds.add(agent.id);
    combined.push(agent);
    if (combined.length >= limit) break;
  }

  const running = combined.filter(a => a.status === 'running' || a.status === 'spawning').length;
  const succeeded = combined.filter(a => a.status === 'completed').length;
  const failed = combined.filter(a => a.status === 'failed' || a.status === 'error').length;

  res.json({
    agents: combined,
    summary: { total: combined.length, running, succeeded, failed }
  });
}));

export default router;
