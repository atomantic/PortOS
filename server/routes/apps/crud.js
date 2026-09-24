import { appListQuerySchema, appQualityQuerySchema, appQualityHistoryQuerySchema, appQualityFederationQuerySchema } from '../../lib/auditQuality.js';
import { exportPortosQuality } from '../../services/appQualityFederation.js';
import { enrichAppsWithQuality, getAppQualityHistory } from '../../services/appQuality.js';
import { publishAppQualitySnapshot } from '../../services/appQualitySnapshotFile.js';
/**
 * App CRUD + status enrichment + archive lifecycle.
 *
 *   GET    /                     → App[]  (PM2-status-enriched)
 *   GET    /:id                  → App    (PM2-status-enriched, + appVersion)
 *   POST   /                     → App
 *   PUT    /:id                  → App    (ports written back to ecosystem config)
 *   DELETE /:id                  → 204  (removes the PortOS registry association only)
 *   POST   /:id/archive          → App
 *   POST   /:id/unarchive        → App
 *   POST   /:id/quality-snapshot → commits the app's `.quality.json` snapshot
 */

import { Router } from 'express';
import { join } from 'path';
import { readJSONFile } from '../../lib/fileUtils.js';
import * as appsService from '../../services/apps.js';
import { notifyAppsChanged, PORTOS_APP_ID } from '../../services/apps.js';
import * as pm2Service from '../../services/pm2.js';
import { validateRequest, appSchema, appUpdateSchema } from '../../lib/validation.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { usesPm2 } from '../../services/appProcessTypes.js';
import { detectAppIcon } from '../../services/appIconDetect.js';
import { hasDeployScript } from '../../services/appDeployer.js';
import { checkScripts } from '../../services/xcodeScripts.js';
import { applyEcosystemPortEdits } from '../../services/appPortConfig.js';
import { enrichAppsWithPm2Status } from '../../services/appListEnrichment.js';
import { loadApp, pathExists, deriveAppPorts, computeOverallStatus } from './shared.js';

const router = Router();

// Numeric local evidence only. This endpoint never invokes aggregate reads or forwards peer data.
router.get('/quality-federation', asyncHandler(async (req, res) => {
  const { days, repository } = validateRequest(appQualityFederationQuerySchema, req.query);
  const payload = await exportPortosQuality(req.get('X-PortOS-Instance-Id'), days, {}, repository);
  if (!payload) throw new ServerError('Quality sharing requires a registered enabled sync peer and a known repository', {
    status: 403,
    code: 'PEER_PULL_FORBIDDEN',
    severity: 'warning',
  });
  res.json(payload);
}));

// GET /api/apps - List all apps. The bare response is the frozen PM2-enriched
// peer-probe contract. `view=nav` is the cheap sidebar projection; `view=probe`
// keeps PM2 enrichment but returns only the fields the peer UI consumes.
router.get('/', asyncHandler(async (req, res) => {
  const { includeQuality, view } = validateRequest(appListQuerySchema, req.query);
  const rawApps = await appsService.getAllApps();
  if (view === 'nav') {
    res.json(rawApps.map(({ id, name, icon, archived, type }) => ({ id, name, icon, archived, type })));
    return;
  }

  const apps = await enrichAppsWithPm2Status(rawApps);
  if (view === 'probe') {
    res.json(apps.map(({ id, name, icon, overallStatus, uiPort, apiPort, type }) => ({
      id, name, icon, overallStatus, uiPort, apiPort, type,
    })));
    return;
  }

  // The bare list is the frozen peer-probe contract. Local UI opts into
  // assessment prose explicitly so it never rides automatic federation probes.
  res.json(includeQuality === 'true' ? await enrichAppsWithQuality(apps) : apps);
}));

router.get('/:id/quality-history', loadApp, asyncHandler(async (req, res) => {
  const { days } = validateRequest(appQualityHistoryQuerySchema, req.query);
  res.json(await getAppQualityHistory(req.loadedApp, days));
}));

// POST /api/apps/:id/quality-snapshot - Land this app's numeric snapshot as
// `.quality.json` through an immediately-merged PR. Deliberately NOT gated on
// publishQualitySnapshot: the toggle automates the audit hook, a manual call
// here is explicit intent.
router.post('/:id/quality-snapshot', loadApp, asyncHandler(async (req, res) => {
  res.json({ success: true, ...await publishAppQualitySnapshot(req.loadedApp) });
}));

// GET /api/apps/:id - Get single app
router.get('/:id', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { includeQuality } = validateRequest(appQualityQuerySchema, req.query);

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
    overallStatus = computeOverallStatus(Object.values(statuses), degraded);
  }

  // Auto-derive uiPort/apiPort/devUiPort from processes when not explicitly set
  const { uiPort, apiPort, devUiPort } = deriveAppPorts(app, app.processes || []);

  // Read version from app's package.json if available, and flag whether the
  // repo declares git submodules — the detail view only shows its Submodules
  // tab for repos that actually have any.
  let appVersion = null;
  let hasSubmodules = false;
  if (app.repoPath) {
    const [pkg, gitmodules] = await Promise.all([
      readJSONFile(join(app.repoPath, 'package.json'), null, { logError: false }),
      pathExists(join(app.repoPath, '.gitmodules')),
    ]);
    appVersion = pkg?.version || null;
    hasSubmodules = gitmodules;
  }

  // The detail read alone scans the checkout for applicability (cached per repo),
  // so the Quality tab's denominator and runner skip audits that cannot apply.
  const [enrichedApp] = includeQuality === 'true'
    ? await enrichAppsWithQuality([app], {
      resolveApplicability: async (target) => (await import('../../services/appQualitySchedule.js')).inapplicableAuditReasons(target),
    })
    : [app];
  res.json({ ...enrichedApp, uiPort, devUiPort, apiPort, overallStatus, degraded, pm2Status: statuses, appVersion, hasSubmodules, hasDeployScript: hasDeployScript(app), xcodeScripts: checkScripts(app) });
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
  notifyAppsChanged('create', app.id);
  res.status(201).json(app);
}));

// PUT /api/apps/:id - Update app
router.put('/:id', asyncHandler(async (req, res, next) => {
  const data = validateRequest(appUpdateSchema, req.body);

  // Only port edits need the canonical-config write-back; snapshot the
  // pre-update app just for those so ordinary updates (rename, archive,
  // jira/datadog) don't pay the extra read + fs stat. tlsPort is omitted: it's
  // synthetic (derived from cert presence / upgradeAppTls), never a literal in
  // ecosystem.config.cjs, so there's nothing to rewrite for it.
  const PORT_KEYS = ['apiPort', 'uiPort', 'devUiPort'];
  const hasPortUpdate = PORT_KEYS.some(key => key in data);
  const existing = hasPortUpdate ? await appsService.getAppById(req.params.id) : null;

  // Port fields in apps.json are *derived* from ecosystem.config.cjs (the source
  // of truth PM2 reads). Persist the change to the canonical config FIRST,
  // before the derived registry: an unreadable/unwritable config then surfaces
  // as a failed request instead of a 200 that leaves apps.json and PM2
  // disagreeing (the write throws and bubbles to the error middleware).
  if (existing && usesPm2(existing.type) && await pathExists(existing.repoPath)) {
    const { persistFailed, uiPortOverride, portCollision } = await applyEcosystemPortEdits(existing, data);

    // Pin the stored uiPort to the derived value for served-by-API apps. This
    // both overwrites the drawer's echoed/stale UI field and keeps the stored
    // value tracking apiPort — deleting `data.uiPort` would NOT be enough, since
    // updateApp merges omitted fields over the existing record, so a stale
    // explicit `uiPort` would survive (truthy) and block re-derivation. Writing
    // the derived value self-corrects on every save.
    if (uiPortOverride !== undefined) {
      data.uiPort = uiPortOverride;
    }

    // Collision gate: the edit would give one process a port another process in
    // the same ecosystem config already holds. Nothing was written; reject so the
    // user fixes the conflict rather than discovering it as a failed PM2 restart.
    if (portCollision) {
      throw new ServerError(
        `Port ${portCollision.newPort} is already used by the ${portCollision.heldBy} process (${portCollision.heldLabel}) in ${existing.name}'s ecosystem config — pick a port no other process claims.`,
        { status: 422, code: 'PORT_COLLISION' }
      );
    }

    // Honesty gate: if the user changed a port we could NOT write to the
    // source-of-truth config, reject the whole update rather than persist a
    // registry value PM2 will contradict (and the next refresh will revert).
    if (persistFailed) {
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
    notifyAppsChanged('update', req.params.id);
    res.json(merged || app);
    return;
  }

  notifyAppsChanged('update', req.params.id);
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

  // Keep the dashboard, sidebar, OpenWorld, and any open detail view in sync
  // with the registry removal. This only removes PortOS's association; the
  // app's repository is not touched by appsService.deleteApp().
  notifyAppsChanged('delete', req.params.id);
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
  notifyAppsChanged('archive', app.id);
  res.json(app);
}));

// POST /api/apps/:id/unarchive - Unarchive app (include in COS tasks)
router.post('/:id/unarchive', asyncHandler(async (req, res) => {
  const app = await appsService.unarchiveApp(req.params.id);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  console.log(`📤 Unarchived app: ${app.name}`);
  notifyAppsChanged('unarchive', app.id);
  res.json(app);
}));

export default router;
