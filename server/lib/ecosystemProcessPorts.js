/**
 * Attribute an ecosystem config's parsed port labels to the app that owns them.
 *
 * A PM2 ecosystem config routinely describes SEVERAL product surfaces: PortOS's
 * own config declares `portos-server`/`portos-ui` (the app) alongside
 * `portos-autofixer`/`portos-autofixer-ui` and `portos-browser` (sibling
 * daemons). "First process carrying the label wins" silently mis-attributes a
 * sibling's port to the app — issue #7357: the ONLY `ports.ui` in PortOS's
 * config belongs to `portos-autofixer-ui` (5560), so saving the PortOS app
 * record resolved `uiPort` to 5560, defeated the served-by-API derivation, and
 * rewrote `AUTOFIXER_UI` to the API server's own 5555.
 *
 * The rule here is *positive attribution with a conservative fallback*:
 *
 *   1. Prefer a process on the app's own SURFACE — the process name with a
 *      trailing role suffix (`-server`, `-ui`, …) stripped. `portos-server` and
 *      `portos-ui` share surface `portos`; `portos-autofixer-ui` does not.
 *   2. Otherwise accept the first process carrying the label UNLESS it is
 *      provably a sibling surface — its surface differs from the app's AND at
 *      least one other process in the config shares that surface, which is what
 *      makes it a distinct multi-process product surface rather than an
 *      unconventionally-named process of this app.
 *
 * Step 2 is what keeps an app whose processes are named `backend`/`frontend`
 * working exactly as before: `frontend` is not on `backend`'s surface, but
 * nothing else in the config claims surface `frontend`, so its `ui` port is
 * still the app's. A label with no attributable process resolves to `undefined`,
 * which is the signal callers use to fall back to derivation (a served-by-API
 * app's `uiPort` = its `apiPort`).
 *
 * Pure and import-free: both the write-back path (`services/appPortConfig.js`)
 * and the read/derive path (`services/appListEnrichment.js`) share it so a
 * displayed port and a rewritten port can never disagree about whose it is.
 */

/**
 * Role suffixes a process name carries to mark WHICH part of one surface it is.
 * Stripping them collapses `portos-server` and `portos-ui` onto surface
 * `portos` while leaving `portos-autofixer` (no role suffix) as its own.
 */
/** A declared port value: a positive integer (0 / null / a string is not a port). */
const isPort = (value) => Number.isInteger(value) && value > 0;

const ROLE_SUFFIXES = ['server', 'api', 'backend', 'ui', 'client', 'web', 'frontend'];

/**
 * The product surface a PM2 process belongs to: its name minus one trailing
 * role suffix. Only a suffix preceded by `-`/`_` and leaving a non-empty stem is
 * stripped, so a bare `ui` process stays `ui` rather than collapsing to ''.
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
 * The process whose surface defines the app. Prefers a name the app record
 * already claims as its own (`processes[]`/`pm2ProcessNames[]`, in order) and
 * that the config actually declares — the record is the only place that knows
 * which of several surfaces in one config is the app. Falls back to the first
 * process carrying an `api` port (the historical primary), then the first
 * process at all.
 *
 * The owned-name list is used for ORDER only, never as a membership filter: a
 * record lists every PM2 process it supervises, siblings included (PortOS's own
 * record claims `portos-autofixer-ui`), so filtering by it would re-admit the
 * very process this module exists to exclude.
 */
function resolvePrimaryProcess(processes, ownedNames) {
  for (const name of ownedNames || []) {
    const match = processes.find(proc => proc?.name === name);
    if (match) return match;
  }
  return processes.find(proc => isPort(proc?.ports?.api)) || processes[0] || null;
}

/** Process names the app record claims, in declaration order. */
function ownedProcessNames(app) {
  const names = [];
  for (const proc of Array.isArray(app?.processes) ? app.processes : []) {
    if (typeof proc?.name === 'string') names.push(proc.name);
  }
  for (const name of Array.isArray(app?.pm2ProcessNames) ? app.pm2ProcessNames : []) {
    if (typeof name === 'string') names.push(name);
  }
  return names;
}

/**
 * Resolve `api`/`ui`/`devUi` ports from a parsed process list, attributing each
 * label to the app that owns it rather than to whichever process declares it
 * first.
 *
 * @param {Array<{name?: string, ports?: Record<string, number>}>} processes
 *   parsed ecosystem processes (or an app record's `processes[]` — same shape)
 * @param {object} [app] the app record, consulted only for which process names
 *   it owns; omit it and the primary falls back to the first `api` process
 * @returns {{ ports: Record<string, number|undefined>, processNames: Record<string, string|undefined> }}
 *   `ports[label]` is undefined when no process can be attributed the label;
 *   `processNames[label]` names the process the value came from (what a targeted
 *   config rewrite must aim at).
 */
export function attributeProcessPorts(processes, app) {
  const procs = (processes || []).filter(proc => proc && typeof proc === 'object');
  const ports = {};
  const processNames = {};
  if (procs.length === 0) return { ports, processNames };

  const primary = resolvePrimaryProcess(procs, ownedProcessNames(app));
  const appSurface = processSurface(primary?.name);

  // Surfaces with two or more processes of their own are distinct product
  // surfaces in this config — that is the evidence needed to IGNORE one of their
  // labels rather than mis-attribute it to the app.
  const surfaceCounts = new Map();
  for (const proc of procs) {
    const surface = processSurface(proc.name);
    surfaceCounts.set(surface, (surfaceCounts.get(surface) || 0) + 1);
  }

  for (const label of ['api', 'ui', 'devUi']) {
    const carriers = procs.filter(proc => isPort(proc.ports?.[label]));
    const owned = carriers.find(proc => processSurface(proc.name) === appSurface);
    // No process on the app's own surface declares this label: accept the first
    // carrier that is not provably a sibling surface (step 2 above).
    const attributed = owned
      || carriers.find(proc => (surfaceCounts.get(processSurface(proc.name)) || 0) < 2);
    if (!attributed) continue;
    ports[label] = attributed.ports[label];
    processNames[label] = attributed.name;
  }

  return { ports, processNames };
}

/**
 * Cross-process port collisions a set of edits would introduce.
 *
 * A port the config already gives to ANOTHER process must never be written into
 * this one: issue #7357 rewrote `AUTOFIXER_UI` to 5555 while `portos-server`
 * held 5555, producing a correct-looking config that collides the moment PM2
 * restarts. Every label in every process's `ports` map counts as a claim — a
 * sibling's `cdp`/`health`/loopback-mirror port is just as taken as its `api`.
 *
 * Only CROSS-process collisions are reported. Two labels on one process sharing
 * a value is the legitimate served-by-API shape (`ports: { api: N, ui: N }`),
 * and edits that merely reproduce it must still go through.
 *
 * @param {Array<{name?: string, ports?: Record<string, number>}>} processes
 * @param {Array<{processName: string, label: string, newPort: number}>} edits
 * @returns {{ processName: string, label: string, newPort: number, heldBy: string, heldLabel: string }|null}
 *   the first collision found, or null when every edit is free of one
 */
export function findCrossProcessPortCollision(processes, edits) {
  const procs = (processes || []).filter(proc => proc && typeof proc === 'object');
  // Post-edit view: an edited label vacates its old value, so an edit that moves
  // a port out of the way cannot collide with the value it just released.
  const claims = [];
  for (const proc of procs) {
    for (const [label, port] of Object.entries(proc.ports || {})) {
      if (!isPort(port)) continue;
      const edit = (edits || []).find(e => e?.processName === proc.name && e?.label === label);
      claims.push({ processName: proc.name, label, port: edit ? edit.newPort : port });
    }
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
 * Derive `uiPort` from `apiPort` when an app has a dev UI but no dedicated prod
 * UI port — the prod UI is then served by the API server, so the two are the
 * same port and the UI port cannot be set independently.
 *
 * Lives beside the attribution rules because it is the other half of the same
 * decision: `attributeProcessPorts` deciding a label has no owning process is
 * precisely what hands control to this derivation. Keeping it here also stops
 * the port write-back path from importing a service graph for one pure
 * function; `services/appListEnrichment.js` re-exports it for its callers.
 */
export function deriveUiPort(uiPort, apiPort, devUiPort) {
  if (!uiPort && apiPort && devUiPort) return apiPort;
  return uiPort;
}
