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
 *   2. Otherwise accept a carrier only when its name declares no role at all —
 *      a suffixed name like `portos-autofixer-ui` names the surface it serves
 *      and thereby says it is not this app's, while a bare `frontend` beside a
 *      `backend` declares nothing and is still taken as this app's UI, exactly
 *      as before.
 *
 * Where the two are genuinely indistinguishable, ignoring is the safe default:
 * it costs a 422 the user can act on, whereas attributing costs a silent rewrite
 * of a sibling's port literal. A label with no attributable process resolves to
 * `undefined`, which is the signal callers use to fall back to derivation (a
 * served-by-API app's `uiPort` = its `apiPort`).
 *
 * Two residual ambiguities are accepted deliberately, because every alternative
 * trades them for a worse one:
 *
 *   - A BARE-named sibling carrying an explicit `ports: { ui: N }` is still
 *     attributed, because a bare name is exactly the `frontend`-beside-`backend`
 *     shape and carries no evidence either way. It is narrow: a bare env `PORT`
 *     parses as `api`, never `ui` (`parseEcosystemConfig` routes it to `ui` only
 *     for a `-ui`/`-client`-suffixed name, which rule 2 already excludes), so it
 *     takes a hand-written `ports` object to reach. `findCrossProcessPortCollision`
 *     is the backstop for the damaging case.
 *   - Resolving the primary in config order assumes an ecosystem file declares
 *     the app's own process before a sibling daemon's — the PM2 convention, what
 *     PortOS's own config does, and an assumption `deriveAppPorts` has always
 *     made for `apiPort` (first `api` carrier wins). An inverted config already
 *     displays the wrong `apiPort` today, independent of this module.
 *
 * Pure and import-free: both the write-back path (`services/appPortConfig.js`)
 * and the read/derive path (`services/appListEnrichment.js`) share it so a
 * displayed port and a rewritten port can never disagree about whose it is.
 */

/** A declared port value: a positive integer (0 / null / a string is not a port). */
const isPort = (value) => Number.isInteger(value) && value > 0;

/**
 * Role suffixes a process name carries to mark WHICH part of one surface it is.
 * Stripping them collapses `portos-server` and `portos-ui` onto surface
 * `portos` while leaving `portos-autofixer` (no role suffix) as its own.
 */
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
 * The process whose surface defines the app: the first process in CONFIG order
 * that the app record claims and that carries an `api` port, else the first
 * claimed process, else the same walk over every process when the record claims
 * none of them.
 *
 * CONFIG order, never the record's order — an ecosystem file declares the app's
 * own process first, while a record's `processes[]`/`pm2ProcessNames[]` is just
 * the supervised set and may be sorted or reordered. Picking by record order
 * would let an alphabetically-sorted list (`portos-autofixer` before
 * `portos-server`) name a sibling as primary and invert the whole attribution.
 *
 * The record is consulted for MEMBERSHIP only, and it is a weak signal at that:
 * it claims every process it supervises, siblings included, so it narrows the
 * field without identifying the app's own surface on its own.
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
 * Resolve `api`/`ui`/`devUi` ports from a parsed process list, attributing each
 * label to the app that owns it rather than to whichever process declares it
 * first.
 *
 * @param {Array<{name?: string, ports?: Record<string, number>}>} processes
 *   parsed ecosystem processes (or an app record's `processes[]` — same shape)
 * @param {object} [app] the app record, consulted only for which process names
 *   it claims; omit it and the primary is resolved over every process
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

  for (const label of ['api', 'ui', 'devUi']) {
    const carriers = procs.filter(proc => isPort(proc.ports?.[label]));
    const attributed = carriers.find(proc => processSurface(proc.name) === appSurface)
      // No process on the app's own surface declares this label. Accept a
      // carrier only when its name does NOT declare a role on some other
      // surface: `portos-autofixer-ui` names the surface it serves and says it
      // is not this app's, so it is ignored (the label then resolves to
      // undefined and the served-by-API derivation takes over), while a
      // `frontend` beside a `backend` strips to no role at all and is still
      // taken as this app's UI, exactly as before. Where the two are genuinely
      // indistinguishable, ignoring costs a 422 the user can act on; attributing
      // costs a silent rewrite of a sibling's port literal.
      || carriers.find(proc => processSurface(proc.name) === proc.name);
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
  const claimed = new Set();
  for (const proc of procs) {
    for (const [label, port] of Object.entries(proc.ports || {})) {
      if (!isPort(port)) continue;
      const edit = (edits || []).find(e => e?.processName === proc.name && e?.label === label);
      claims.push({ processName: proc.name, label, port: edit ? edit.newPort : port });
      claimed.add(`${proc.name}\u0000${label}`);
    }
  }
  // An edit can also introduce a label the process does not declare yet. Seed
  // those too, so two edits that would hand the same new port to two different
  // processes still collide with each other.
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
