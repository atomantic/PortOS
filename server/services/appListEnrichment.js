/**
 * App-list PM2 status enrichment.
 *
 * Owns the orchestration that turns the raw `apps.json` records into the
 * PM2-status-enriched list the `GET /api/apps` route responds with: one PM2
 * read per unique `pm2Home`, absent-vs-empty (`unknown` vs `not_started`)
 * status classification, ecosystem-config process backfill, and port
 * derivation. The route just fetches the apps and responds — this module is
 * the single home for the enrichment logic.
 *
 * The pure port/status derivation helpers (`deriveUiPort`, `deriveAppPorts`,
 * `computeOverallStatus`) live here too and are re-exported from
 * `routes/apps/shared.js` so the detail (`GET /:id`) and lifecycle routes keep
 * a single shared implementation without importing a service from a route.
 */

import { usesPm2, parseEcosystemFromPath } from './streamingDetect.js';
import { listProcessesStrict } from './pm2.js';
import { hasDeployScript } from './appDeployer.js';
import { checkScripts } from './xcodeScripts.js';
import { pathExists } from '../lib/fileUtils.js';

/**
 * Derive uiPort from apiPort when app has dev UI but no dedicated prod UI port
 * (prod UI is served by the API server in these cases).
 */
export function deriveUiPort(uiPort, apiPort, devUiPort) {
  if (!uiPort && apiPort && devUiPort) return apiPort;
  return uiPort;
}

/**
 * Derive uiPort/apiPort/devUiPort from an app's process list when not
 * explicitly set on the app record. Shared by the list and detail endpoints so
 * the two never diverge. Returns the resolved trio (uiPort passed through
 * deriveUiPort for the served-by-API case).
 */
export function deriveAppPorts(app, processes) {
  let { uiPort, apiPort, devUiPort } = app;
  const procs = processes || [];
  if (!uiPort && procs.length) {
    const uiProc = procs.find(p => p.ports?.ui);
    if (uiProc) uiPort = uiProc.ports.ui;
  }
  if (!apiPort && procs.length) {
    const apiProc = procs.find(p => p.ports?.api);
    if (apiProc) apiPort = apiProc.ports.api;
  }
  if (!devUiPort && procs.length) {
    const devUiProc = procs.find(p => p.ports?.devUi);
    if (devUiProc) devUiPort = devUiProc.ports.devUi;
  }
  uiPort = deriveUiPort(uiPort, apiPort, devUiPort);
  return { uiPort, apiPort, devUiPort };
}

/**
 * Compute the overall status from a set of per-process PM2 statuses. A degraded
 * (failed-read) home short-circuits to `unknown` rather than collapsing to a
 * confident `not_started`. Shared by the list and detail endpoints.
 */
export function computeOverallStatus(statusValues, degraded) {
  // Mirrors the original inline logic exactly: an empty status set (an app with
  // no PM2 process names) satisfies the vacuous `every(...)` and resolves to
  // `not_started`, NOT `unknown`.
  if (degraded) return 'unknown';
  if (statusValues.some(s => s.status === 'online')) return 'online';
  if (statusValues.some(s => s.status === 'stopped')) return 'stopped';
  if (statusValues.every(s => s.status === 'not_found')) return 'not_started';
  return 'unknown';
}

/**
 * Enrich a list of app records with live PM2 status, backfilled processes, and
 * derived ports. Reads PM2 once per unique `pm2Home`.
 *
 * `listProcessesStrict` returns `null` on a failed read (vs `[]` for a
 * successful read with no processes) — those homes are tracked so their apps
 * report `unknown` (status unavailable) + `degraded: true` instead of
 * `not_started` (confidently not running). See `getAppStatuses()` in
 * `apps.js` for the same absent-vs-empty distinction.
 *
 * @param {Array<object>} apps - raw app records (e.g. from `getAllApps()`)
 * @returns {Promise<Array<object>>} PM2-status-enriched app records
 */
export async function enrichAppsWithPm2Status(apps) {
  // Group apps by their PM2_HOME (null = default) so each unique home is
  // queried at most once.
  const pm2HomeGroups = new Map();
  for (const app of apps) {
    const home = app.pm2Home || null;
    if (!pm2HomeGroups.has(home)) pm2HomeGroups.set(home, []);
    pm2HomeGroups.get(home).push(app);
  }

  const pm2Maps = new Map();
  const failedHomes = new Set();
  for (const pm2Home of pm2HomeGroups.keys()) {
    const processes = await listProcessesStrict(pm2Home);
    if (processes === null) {
      failedHomes.add(pm2Home);
      pm2Maps.set(pm2Home, new Map());
    } else {
      pm2Maps.set(pm2Home, new Map(processes.map(p => [p.name, p])));
    }
  }

  return Promise.all(apps.map(async (app) => {
    // Non-PM2 apps skip PM2 enrichment entirely.
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

    // A failed PM2 home short-circuits to `unknown` with a `degraded` flag
    // rather than collapsing to `not_started`.
    const overallStatus = computeOverallStatus(Object.values(statuses), homeFailed);

    // Auto-populate processes from ecosystem config if not already set.
    let processes = app.processes;
    if ((!processes || processes.length === 0) && await pathExists(app.repoPath)) {
      const parsed = await parseEcosystemFromPath(app.repoPath).catch(() => ({ processes: [] }));
      processes = parsed.processes;
    }

    // Auto-derive uiPort/apiPort/devUiPort from processes when not explicitly set.
    const { uiPort, apiPort, devUiPort } = deriveAppPorts(app, processes);

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
}
