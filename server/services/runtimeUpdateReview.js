/** Machine-local, cached observations for the Review Hub's software updates. */
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PATHS, atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { compareHarnessVersions } from '../lib/harnessOutput.js';
import { compareVersions } from '../../scripts/checkNodeVersion.js';
import { reviewEvents } from './review.js';
import { runtimeUpdateEvents } from './runtimeUpdateEvents.js';

const UPDATE_LINK = `/apps/${PORTOS_APP_ID}/update`;
const CACHE_FILE = join(PATHS.data, 'cache', 'runtime-update-review.json');
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;

const row = (id, title, summary, drillTo, revision, severity = 'normal') => ({
  id, title, summary, drillTo, revision, severity,
  priority: severity === 'high' ? 'HIGH' : 'MEDIUM',
  drillLabel: id.startsWith('harness:') ? 'Open harness' : 'Open PortOS update',
  nextAction: id.startsWith('harness:') ? 'Review harness update' : 'Review runtime update',
  operations: [], required: true,
});

function unknown(previous, fallback) {
  return { ...(previous || fallback), unverified: true, unverifiedPrevious: Boolean(previous && (!previous.unverified || previous.unverifiedPrevious)) };
}

function reconcileRuntime(rows, status) {
  const setUnknown = (id, fallback) => rows.set(id, unknown(rows.get(id), fallback));
  if (!status?.node?.version || !status.pm2) {
    const prior = [...rows.keys()].filter((id) => !id.startsWith('harness:'));
    if (prior.length) prior.forEach((id) => rows.set(id, unknown(rows.get(id))));
    else setUnknown('runtime-check', row('runtime-check', 'Runtime update check unavailable', 'Node.js and pm2 updates could not be checked.', UPDATE_LINK, 'unverified'));
    return;
  }
  rows.delete('runtime-check');
  const { node, releases, pm2, startup } = status;
  const baseline = node.securityBaseline || {};
  const latest = releases?.latestInLine?.version;
  const minimum = baseline.minimum ? `v${baseline.minimum}` : null;
  const indexVerified = Boolean(latest && releases.securityVerified !== false
    && !(baseline.compliant === false && minimum && compareVersions(latest, minimum) < 0));
  const outdated = latest && compareVersions(latest, node.version) > 0;
  const security = baseline.compliant === false || releases?.securityUpdate === true;
  const previousNode = rows.get('node');
  const securityRevision = [releases?.latestSecurity?.version, baseline.compliant === false ? minimum : null]
    .filter(Boolean).sort((a, b) => compareVersions(b, a))[0] || null;
  const previousSecurity = previousNode?.revision?.startsWith('security:') ? previousNode.revision.slice('security:'.length) : null;
  const newerSecurity = securityRevision && (!previousSecurity || compareVersions(securityRevision, previousSecurity) > 0);
  if (!indexVerified && previousNode && !(security && (previousNode.severity !== 'high' || newerSecurity))) {
    rows.set('node', unknown(previousNode));
  } else if (security || node.inSupportedRange === false || outdated) {
    const target = outdated && (!securityRevision || compareVersions(latest, securityRevision) >= 0) ? latest : securityRevision;
    const reason = security ? 'Security update' : node.inSupportedRange === false ? 'Unsupported runtime' : 'Update available';
    const description = `${reason}: PortOS runs ${node.version}${target ? `; target ${target}` : ''}. Updating Node requires a PortOS restart.`;
    const entry = row('node', security ? 'Node.js security update needed' : 'Node.js update available', description, UPDATE_LINK,
      security ? `security:${securityRevision || target}` : `update:${target || node.version}`, security || node.inSupportedRange === false ? 'high' : 'normal');
    rows.set('node', indexVerified ? entry : unknown(entry));
  } else if (!indexVerified || baseline.compliant === null) {
    setUnknown('node', row('node', 'Node.js update status unverified', `PortOS runs ${node.version}; the security and release status could not be verified.`, UPDATE_LINK, 'unverified'));
  } else rows.delete('node');

  const daemonNode = pm2.daemon?.nodeVersion;
  const daemonComparison = compareHarnessVersions(typeof daemonNode === 'string' ? daemonNode.replace(/^v/, '') : null, node.version.replace(/^v/, ''));
  const nodeMismatch = daemonComparison !== null && daemonComparison !== 0;
  if (pm2.shipped && (pm2.cliBehind || pm2.daemonStale || nodeMismatch)) {
    const action = pm2.daemonStale ? 'Synchronizing the daemon requires a restart.'
      : nodeMismatch ? 'Review the differing Node versions; the pm2 sync action cannot fix this mismatch on its own.'
        : 'The terminal CLI can be synchronized without a restart.';
    const summary = `PortOS bundles pm2 ${pm2.shipped}; terminal ${pm2.cli || 'not installed'}, daemon ${pm2.daemon?.pm2Version || 'unknown'} on Node ${daemonNode || 'unknown'}; PortOS runs ${node.version}. ${action}`;
    const entry = row('pm2-sync', 'Review pm2 runtime alignment', summary, UPDATE_LINK,
      `${pm2.shipped}:${pm2.cli || ''}:${pm2.daemon?.pm2Version || ''}:${daemonNode || ''}:${node.version}`);
    rows.set('pm2-sync', !pm2.daemon?.pm2Version || daemonComparison === null ? unknown(entry) : entry);
  } else if (!pm2.shipped || !pm2.daemon?.pm2Version || daemonComparison === null || ['unverified', 'unsupported'].includes(pm2.cliState)) {
    const entry = unknown(rows.get('pm2-sync'), row('pm2-sync', 'pm2 runtime status unverified', `PortOS bundles pm2 ${pm2.shipped || 'unknown'}; its daemon or terminal CLI could not be verified.`, UPDATE_LINK, 'unverified'));
    rows.set('pm2-sync', { ...entry, retrySoon: pm2.cliState !== 'unsupported' || !pm2.daemon?.pm2Version || daemonComparison === null });
  } else rows.delete('pm2-sync');

  if (!pm2.shipped || !pm2.latest) {
    setUnknown('pm2-upstream', row('pm2-upstream', 'pm2 release status unverified', `PortOS bundles pm2 ${pm2.shipped || 'unknown'}; the npm release could not be checked.`, UPDATE_LINK, 'unverified'));
  } else if (compareHarnessVersions(pm2.shipped, pm2.latest) === -1) {
    rows.set('pm2-upstream', row('pm2-upstream', 'A newer pm2 release is available', `PortOS bundles pm2 ${pm2.shipped}; npm has ${pm2.latest}. The pm2 sync action installs the bundled version, so a newer bundle requires a PortOS dependency update.`, UPDATE_LINK, `${pm2.shipped}:${pm2.latest}`));
  } else if (compareHarnessVersions(pm2.shipped, pm2.latest) === null) {
    setUnknown('pm2-upstream', row('pm2-upstream', 'pm2 release status unverified', 'The bundled and published pm2 versions could not be compared.', UPDATE_LINK, 'unverified'));
  } else rows.delete('pm2-upstream');

  if (startup?.configured && startup.current === false) {
    rows.set('pm2-startup', row('pm2-startup', 'pm2 start-on-boot uses another Node', `PortOS runs ${node.version}; review the startup configuration so the correct Node is used after boot.`, UPDATE_LINK, node.version));
  } else if (startup?.current !== true && rows.has('pm2-startup')) rows.set('pm2-startup', unknown(rows.get('pm2-startup')));
  else rows.delete('pm2-startup');
}

function reconcileHarnesses(rows, harnesses, removedHarnesses, removalsBeforeRead) {
  const priorIds = new Set([...rows.keys()].filter((id) => id.startsWith('harness:')));
  if (!Array.isArray(harnesses)) {
    if (priorIds.size) priorIds.forEach((id) => rows.set(id, unknown(rows.get(id))));
    else rows.set('harness:check', unknown(null, row('harness:check', 'Harness update check unavailable', 'Coding-agent harness updates could not be checked.', '/ai/harnesses', 'unverified')));
    return;
  }
  rows.delete('harness:check');
  priorIds.delete('harness:check');
  for (const harness of harnesses) {
    if (!harness?.id) continue;
    const id = `harness:${harness.id}`;
    priorIds.delete(id);
    const link = `/ai/harnesses/${encodeURIComponent(harness.id)}`;
    if (harness.installed && removalsBeforeRead.has(harness.id)) removedHarnesses.delete(harness.id);
    // A PATH lookup cannot distinguish removal from an inaccessible binary or
    // changed PATH. It is not proof that a previous update was installed.
    if (harness.probeState === 'missing') {
      if (removalsBeforeRead.has(harness.id)) { removedHarnesses.delete(harness.id); rows.delete(id); }
      else if (rows.has(id)) rows.set(id, unknown(rows.get(id)));
      continue;
    }
    if (harness.probeState === 'unavailable' || harness.probeState === 'unprobed') {
      rows.set(id, unknown(rows.get(id), row(id, `${harness.label} status unverified`, 'The installed harness could not report its version.', link, 'unverified')));
      continue;
    }
    if (!harness.installed) { rows.delete(id); continue; }
    const compared = compareHarnessVersions(harness.version, harness.latestVersion);
    if (compared === null) {
      const reason = harness.package ? 'The installed or latest version could not be verified.' : 'No automatic release comparison is available for this harness.';
      const entry = unknown(rows.get(id), row(id, `${harness.label} update status unverified`, `Installed ${harness.version || 'version unknown'}. ${reason}`, link, 'unverified'));
      rows.set(id, { ...entry, retrySoon: Boolean(harness.package) });
    } else if (compared === -1) {
      rows.set(id, row(id, `${harness.label} update available`, `Installed ${harness.version}; latest ${harness.latestVersion}. Review the harness updater before updating.`, link, `${harness.version}:${harness.latestVersion}`));
    } else rows.delete(id);
  }
  for (const id of priorIds) rows.set(id, unknown(rows.get(id)));
}

/** One refresh at a time; a mutation during a refresh forces another observation. */
function createRuntimeUpdateReviewMonitor({ readRuntime, readHarnesses, notify, load, save } = {}) {
  let rows = new Map();
  let inflight = null;
  let again = false;
  let started = false;
  let ready = false;
  let checked = false;
  let timer = null;
  const removedHarnesses = new Set();
  const items = () => (checked || rows.size ? [...rows.values()] : [unknown(null, row('runtime-check', 'Software update checks pending', 'Node.js, pm2 and harness checks have not completed yet.', UPDATE_LINK, 'unverified'))]).map((entry) => ({
    ...entry,
    ...(entry.unverified ? { summary: `${entry.unverifiedPrevious ? 'Status unverified; last known result:' : 'Status unverified.'} ${entry.summary}` } : {}),
  }));
  const refresh = () => {
    if (inflight) { again = true; return inflight; }
    inflight = (async () => {
      do {
        again = false;
        const before = [...rows.values()];
        const removalsBeforeRead = new Set(removedHarnesses);
        const [runtime, harnesses] = await Promise.allSettled([Promise.resolve().then(readRuntime), Promise.resolve().then(readHarnesses)]);
        reconcileRuntime(rows, runtime.status === 'fulfilled' ? runtime.value : null);
        reconcileHarnesses(rows, harnesses.status === 'fulfilled' ? harnesses.value : null, removedHarnesses, removalsBeforeRead);
        const wasChecked = checked;
        checked = true;
        if (!wasChecked || !isDeepStrictEqual(before, [...rows.values()])) {
          notify();
          await save([...rows.values()]).catch((error) => console.error(`❌ Runtime update cache write failed: ${error.message}`));
        }
      } while (again);
    })().finally(() => { inflight = null; });
    return inflight;
  };
  const tick = () => {
    refresh().catch((error) => console.error(`❌ Runtime update check failed: ${error.message}`)).finally(() => {
      if (!started) return;
      clearTimeout(timer);
      timer = setTimeout(tick, [...rows.values()].some((entry) => entry.unverified && entry.retrySoon !== false) ? RETRY_INTERVAL_MS : CHECK_INTERVAL_MS);
      timer.unref?.();
    });
  };
  const onChange = ({ removedHarness } = {}) => {
    if (removedHarness) removedHarnesses.add(removedHarness);
    if (ready) tick();
  };
  const start = async () => {
    if (started) return;
    started = true;
    runtimeUpdateEvents.on('changed', onChange);
    const cached = await load().catch(() => []);
    if (!started) return;
    if (Array.isArray(cached)) {
      rows = new Map(cached.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.summary === 'string')
        .map((entry) => [entry.id, unknown(entry)]));
      if (rows.size) notify();
    }
    ready = true;
    tick();
  };
  const stop = () => { started = false; ready = false; clearTimeout(timer); runtimeUpdateEvents.off('changed', onChange); };
  return { items, refresh, start, stop };
}

const monitor = createRuntimeUpdateReviewMonitor({
  readRuntime: async () => (await import('./nodeRuntime.js')).getNodeRuntimeStatus(),
  readHarnesses: async () => (await import('./harnesses.js')).listHarnesses({ fresh: true }),
  notify: () => reviewEvents.emit('queue:changed'),
  load: async () => readJSONFile(CACHE_FILE, []),
  save: async (entries) => atomicWrite(CACHE_FILE, entries),
});

export const getRuntimeUpdateReviewItems = () => monitor.items();
export const startRuntimeUpdateReview = () => monitor.start();
export const __testing = { createRuntimeUpdateReviewMonitor };
