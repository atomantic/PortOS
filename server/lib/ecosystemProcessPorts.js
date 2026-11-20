/**
 * Attribute an ecosystem config's parsed port labels to the app that owns them.
 *
 * A PM2 ecosystem config can describe several surfaces (e.g. `portos-server`/`portos-ui`
 * beside `portos-autofixer`), so "first process carrying the label wins" would
 * attribute a sibling's port to the app. Rule: (1) prefer a process on the app's own
 * SURFACE (name minus a trailing role suffix); (2) otherwise accept a carrier only
 * when its name declares no role at all (a bare `frontend` beside `backend`). When
 * ambiguous, ignoring is the safe default: it costs a 422 the user can act on, while
 * attributing silently rewrites a sibling's port. An unattributable label resolves to
 * `undefined`, which callers treat as "derive it" (served-by-API uiPort = apiPort).
 *
 * Accepted residual ambiguities: a bare-named sibling with a hand-written
 * `ports: { ui: N }` is still attributed (`findCrossProcessPortCollision` is the
 * backstop), and the primary is resolved in config order, assuming the app's own
 * process is declared before sibling daemons (as `deriveAppPorts` already assumes).
 *
 * Pure and import-free so the write-back path (`services/appPortConfig.js`) and the
 * read/derive path (`services/appListEnrichment.js`) agree on whose port is whose.
 */

/** A declared port value: a positive integer (0 / null / a string is not a port). */
const isPort = (value) => Number.isInteger(value) && value > 0;

/** Role suffixes stripped to collapse `portos-server`/`portos-ui` onto one surface. */
const ROLE_SUFFIXES = ['server', 'api', 'backend', 'ui', 'client', 'web', 'frontend'];

/**
 * The product surface of a PM2 process: its name minus one trailing role suffix.
 * Only a `-`/`_`-preceded suffix leaving a non-empty stem is stripped.
 */
export function processSurface(name) {
  if (typeof name !== 'string' || name.length === 0) return '';
  for (const suffix of ROLE_SUFFIXES) {
    const match = name.match(new RegExp(`^(.+)[-_]${suffix}$`, 'i'));
    if (match) return match[1];
  }
  return name;
}

/**
 * The process whose surface defines the app: the first process in CONFIG order that
 * the app record claims and that carries an `api` port, else the first claimed
 * process, else the same walk over every process. Config order, never the record's
 * (which may be sorted and would name a sibling primary); the record is a weak
 * membership signal only.
 */
function resolvePrimaryProcess(processes, ownedNames) {
  const claimed = ownedNames.size > 0
    ? processes.filter(proc => ownedNames.has(proc?.name))
    : [];
  const candidates = claimed.length > 0 ? claimed : processes;
  return candidates.find(proc => isPort(proc?.ports?.api)) || candidates[0] || null;
}

/** Process names the app record claims. */
function ownedProcessNames(app) {
  const names = new Set();
  for (const proc of Array.isArray(app?.processes) ? app.processes : []) {
    if (typeof proc?.name === 'string') names.add(proc.name);
  }
  for (const name of Array.isArray(app?.pm2ProcessNames) ? app.pm2ProcessNames : []) {
    if (typeof name === 'string') names.add(name);
  }
  return names;
}

/**
 * Resolve `api`/`ui`/`devUi` ports from a parsed process list, attributing each label
 * to the app that owns it.
 *
 * @param {Array<{name?: string, ports?: Record<string, number>}>} processes
 * @param {object} [app] app record, consulted only for which process names it claims;
 *   omit it and the primary is resolved over every process
 * @returns {{ ports: Record<string, number|undefined>, processNames: Record<string, string|undefined> }}
 *   `processNames[label]` is the process a targeted config rewrite must aim at.
 */
export function attributeProcessPorts(processes, app) {
  const procs = (processes || []).filter(proc => proc && typeof proc === 'object');
  const ports = {};
  const processNames = {};
  if (procs.length === 0) return { ports, processNames };

  const primary = resolvePrimaryProcess(procs, ownedProcessNames(app));
  const appSurface = processSurface(primary?.name);

  for (const label of ['api', 'ui', 'devUi']) {
    const carriers = procs.filter(proc => isPort(proc.ports?.[label]));
    const attributed = carriers.find(proc => processSurface(proc.name) === appSurface)
      // No carrier on the app's own surface: accept only a role-less name. A
      // suffixed sibling like `portos-autofixer` is ignored.
      || carriers.find(proc => processSurface(proc.name) === proc.name);
    if (!attributed) continue;
    ports[label] = attributed.ports[label];
    processNames[label] = attributed.name;
  }

  return { ports, processNames };
}

/**
 * Cross-process port collisions a set of edits would introduce. Every label in
 * every process's `ports` counts as a claim. Same-process label sharing is the
 * legitimate served-by-API shape (`ports: { api: N, ui: N }`) and is not reported.
 *
 * @param {Array<{name?: string, ports?: Record<string, number>}>} processes
 * @param {Array<{processName: string, label: string, newPort: number}>} edits
 * @returns {{ processName: string, label: string, newPort: number, heldBy: string, heldLabel: string }|null}
 *   the first collision found, or null when every edit is free of one
 */
export function findCrossProcessPortCollision(processes, edits) {
  const procs = (processes || []).filter(proc => proc && typeof proc === 'object');
  // Post-edit view: an edited label vacates its old value.
  const claims = [];
  const claimed = new Set();
  for (const proc of procs) {
    for (const [label, port] of Object.entries(proc.ports || {})) {
      if (!isPort(port)) continue;
      const edit = (edits || []).find(e => e?.processName === proc.name && e?.label === label);
      claims.push({ processName: proc.name, label, port: edit ? edit.newPort : port });
      claimed.add(`${proc.name}\u0000${label}`);
    }
  }
  // Seed labels an edit introduces so two edits handing one new port to different
  // processes still collide.
  for (const edit of edits || []) {
    if (!edit || !isPort(edit.newPort)) continue;
    if (claimed.has(`${edit.processName}\u0000${edit.label}`)) continue;
    claims.push({ processName: edit.processName, label: edit.label, port: edit.newPort });
  }

  for (const edit of edits || []) {
    if (!edit || !isPort(edit.newPort)) continue;
    const held = claims.find(claim => claim.processName !== edit.processName && claim.port === edit.newPort);
    if (held) {
      return {
        processName: edit.processName,
        label: edit.label,
        newPort: edit.newPort,
        heldBy: held.processName,
        heldLabel: held.label,
      };
    }
  }
  return null;
}

/**
 * Derive `uiPort` from `apiPort` when an app has a dev UI but no prod UI port (the
 * API server serves the UI). Lives here so the write-back path avoids a service-graph
 * import; `services/appListEnrichment.js` re-exports it.
 */
export function deriveUiPort(uiPort, apiPort, devUiPort) {
  if (!uiPort && apiPort && devUiPort) return apiPort;
  return uiPort;
}
