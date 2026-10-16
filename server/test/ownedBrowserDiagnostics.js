import { channel } from 'node:diagnostics_channel';
import { closeSync, existsSync, lstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { recordTempRootOwner } from '../lib/mockPathsDataRoot.js';

const lifecycle = channel('portos.composition-browser.lifecycle');
// The environment and transformed test modules can have different module
// caches. The Node channel is shared across those realms; retain one diagnostic
// binding per exact child, even when a local assertion observer also tracks it.
const bindingsKey = Symbol.for('portos.composition-browser.diagnostic-bindings');
const bindings = lifecycle[bindingsKey] ??= new WeakMap();
const repo = fileURLToPath(new URL('../../', import.meta.url));
const BUDGET = 8 * 1024 * 1024;
const events = new Set(['allocated', 'child', 'exit', 'close', 'remove-start', 'remove-resolved', 'remove-rejected']);
const removals = new Set(['not-started', 'pending', 'resolved', ...['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'EACCES', 'ENOENT', 'other'].map(code => `rejected:${code}`)]);
const safeOwner = owner => typeof owner === 'string' && owner.length <= 240
  && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(owner) && !owner.split('/').includes('..');
const ownerFor = filepath => {
  if (typeof filepath !== 'string') return 'unavailable';
  const owner = relative(repo, filepath).split(sep).join('/');
  return safeOwner(owner) ? owner : 'unavailable';
};
const present = profile => { try { return existsSync(profile); } catch { return 'unknown'; } };
const safeSignal = signal => signal == null ? 'none' : typeof signal === 'string' && Object.hasOwn(osConstants.signals, signal) ? signal : 'other';
const safeExit = code => code == null ? 'none' : Number.isSafeInteger(code) && Math.abs(code) <= 2147483647 ? code : 'other';
const elapsed = started => Math.min(86400000, Math.max(0, Math.round(performance.now() - started)));

// One interpretation for both local assertion diagnostics and persisted worker
// observations. Native exit/close events are distinct from a public child status.
export function createOwnedBrowserDiagnostics({ changed = () => {} } = {}) {
  const children = [];
  const listeners = new Map();
  const subscriber = {};
  const sampleStatus = owned => {
    const child = owned.binding?.child;
    try { if (child) { owned.exitCode = safeExit(child.exitCode); owned.signalCode = safeSignal(child.signalCode); } }
    catch { owned.exitCode = 'other'; owned.signalCode = 'other'; }
  };
  const observe = (owned, event) => {
    const bound = owned.binding;
    sampleStatus(owned);
    if (owned.events.length < 16) owned.events.push(`${event}@${elapsed(owned.started)}ms`);
    else owned.truncated = true;
    for (const notify of bound?.notifications.values() || [changed]) {
      try { notify(owned); } catch { /* observation must never reject a child event */ }
    }
  };
  const allocate = profile => {
    let owned = children.find(item => item.profile === profile);
    if (!owned) {
      owned = { profile, exited: false, closed: false, removal: 'not-started',
        presentAfterRemoval: 'unknown', events: [], started: performance.now(), truncated: false, observer: 'active', exitCode: 'none', signalCode: 'none' };
      children.push(owned);
      observe(owned, 'allocated');
    }
    return owned;
  };
  const bind = (owned, child) => {
    if (listeners.has(owned) || !child?.once) return;
    let bound = bindings.get(child);
    if (bound && bound.owned.profile !== owned.profile) return;
    if (bound) {
      children[children.indexOf(owned)] = bound.owned;
      owned = bound.owned;
      bound.notifications.set(subscriber, changed);
      listeners.set(owned, bound);
      // This consumer also needs the already-observed facts.
      try { changed(owned); } catch { /* diagnostics only */ }
      return;
    }
    const exit = () => { owned.exited = true; observe(owned, 'exit'); };
    const close = () => { owned.closed = true; observe(owned, 'close'); };
    bound = { child, exit, close, owned, notifications: new Map([[subscriber, changed]]) };
    owned.binding = bound;
    bindings.set(child, bound);
    listeners.set(owned, bound);
    child.once('exit', exit);
    child.once('close', close);
    observe(owned, 'child');
  };
  const removal = (owned, event, code) => {
    if (event === 'remove-start') owned.removal = 'pending';
    else {
      owned.removal = event === 'remove-resolved' ? 'resolved' : `rejected:${code}`;
      if (!removals.has(owned.removal)) owned.removal = 'rejected:other';
      owned.presentAfterRemoval = present(owned.profile);
    }
    observe(owned, event);
  };
  return {
    children, allocate, bind, removal,
    track(child, args) {
      const arg = args?.find(value => value.startsWith('--user-data-dir=') && value.includes('portos-composition-browser-'));
      if (arg) bind(allocate(arg.slice('--user-data-dir='.length)), child);
    },
    async remove(remove, path, ...args) {
      const owned = children.find(item => item.profile === path);
      if (!owned) return remove(path, ...args);
      removal(owned, 'remove-start');
      try {
        const result = await remove(path, ...args);
        removal(owned, 'remove-resolved');
        return result;
      } catch (error) {
        removal(owned, 'remove-rejected', error?.code);
        throw error;
      }
    },
    dispose() {
      for (const owned of children) {
        const bound = listeners.get(owned);
        sampleStatus(owned);
        owned.observer = 'ended';
        // Persist this consumer's ending before detaching its notification.
        try { changed(owned); } catch { /* diagnostics only */ }
        bound?.notifications.delete(subscriber);
        if (bound && !bound.notifications.size) {
          bound.child.removeListener('exit', bound.exit);
          bound.child.removeListener('close', bound.close);
          bindings.delete(bound.child);
        }
      }
      listeners.clear();
    },
    describe(owned) {
      return `owned lifecycle: exit=${owned.exited} close=${owned.closed} removal=${owned.removal}`
        + ` presentAfterRemoval=${owned.presentAfterRemoval} presentNow=${present(owned.profile)}`
        + ` events=${owned.events.join(',')} truncated=${owned.truncated}`;
    },
  };
}

// Installed for the entire worker environment, including collection and suite
// hooks. Only exact profiles directly under this run's root are admitted.
export function observeOwnedBrowsers(getOwner) {
  const runRoot = process.env.PORTOS_TEST_TEMP_ROOT;
  let ended = false;
  let capped = false;
  const owners = new Map();
  const roots = new Map();
  const diagnostics = createOwnedBrowserDiagnostics({ changed(owned) {
    const observation = JSON.stringify({ v: 1, ...roots.get(owned.profile), exitCode: owned.exitCode, signalCode: owned.signalCode, exit: owned.exited, close: owned.closed,
      removal: owned.removal, presentAfterRemoval: owned.presentAfterRemoval,
      observer: ended ? 'ended' : 'active', events: owned.events, truncated: owned.truncated });
    recordTempRootOwner(owned.profile, { owner: owners.get(owned.profile) || 'unavailable', observation });
  } });
  const receive = message => {
    // A passive observer must never turn a fixture operation into a failure.
    try {
      if (ended || !runRoot || !message || typeof message.profile !== 'string'
        || dirname(resolve(message.profile)) !== resolve(runRoot)
        || !/^portos-(?:composition-browser|code-animation-stages)-[A-Za-z0-9]+$/.test(basename(message.profile))) return;
      let owned = diagnostics.children.find(item => item.profile === message.profile);
      if (message.event === 'allocated' && !owned) {
        if (diagnostics.children.length >= 64) {
          if (!capped) recordTempRootOwner(joinCap(runRoot), { owner: 'unavailable', observation: '{"v":1,"state":"capped"}' });
          capped = true;
          return;
        }
        owners.set(message.profile, ownerFor(getOwner()));
        if (basename(message.profile).startsWith('portos-code-animation-stages-')) {
          const { dev, ino } = lstatSync(message.profile);
          roots.set(message.profile, { v: 2, generation: roots.size + 1, dev, ino });
        }
        owned = diagnostics.allocate(message.profile);
      }
      if (!owned) return;
      if (message.event === 'child') diagnostics.bind(owned, message.child);
      if (['remove-start', 'remove-resolved', 'remove-rejected'].includes(message.event)) diagnostics.removal(owned, message.event, message.code);
    } catch { /* unavailable evidence; original fixture verdict remains authoritative */ }
  };
  lifecycle.subscribe(receive);
  return () => {
    if (ended) return;
    ended = true;
    lifecycle.unsubscribe(receive);
    // No waiting for late children/removal: the final snapshot explicitly ends
    // observation. Remove only the two listeners this observer installed.
    try { diagnostics.dispose(); } catch { /* best effort */ }
  };
}
const joinCap = root => resolve(root, '.composition-observer');

// A bounded, privacy-validating decoder, shared by the existing global guard.
// Never accept arbitrary JSON properties or text as public lifecycle facts.
export function readOwnedBrowserObservations(root) {
  const owners = new Map();
  const observations = new Map();
  let state = 'unavailable';
  let fd;
  try {
    fd = openSync(resolve(root, '.leak-owners'), 'r');
    const buffer = Buffer.alloc(BUDGET + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!read) break;
      bytes += read;
    }
    state = bytes >= BUDGET ? 'capped' : 'available';
    const text = buffer.subarray(0, Math.min(bytes, BUDGET)).toString('utf8');
    const lines = text.split('\n');
    const incomplete = !text.endsWith('\n') ? lines.pop()?.split('\t')[0] : undefined;
    for (const line of lines) {
      const columns = line.split('\t');
      const [dir, owner, encoded] = columns;
      if (columns.length > 3 || Buffer.byteLength(line) >= 1024 || (!line.endsWith('}') && encoded)) { observations.delete(dir); continue; }
      if (!dir || basename(dir) !== dir) continue;
      // Keep ordinary two-column owner rows readable, but never print a path.
      if (!encoded) {
        observations.delete(dir);
        if (/^[A-Za-z0-9_.-]{1,240}$/.test(owner) && !['.', '..'].includes(owner)) owners.set(dir, owner);
        continue;
      }
      let value;
      try { value = JSON.parse(encoded); } catch { observations.delete(dir); continue; }
      if (dir === '.composition-observer' && value?.v === 1 && value.state === 'capped') { state = 'capped'; continue; }
      const stageRoot = value?.v === 2 && /^portos-code-animation-stages-[A-Za-z0-9]+$/.test(dir)
        && ['generation', 'dev', 'ino'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
        && value.generation >= 1 && value.generation <= 64;
      const valid = (value?.v === 1 || stageRoot)
        && safeExit(value.exitCode === 'none' ? null : value.exitCode) === value.exitCode
        && safeSignal(value.signalCode === 'none' ? null : value.signalCode) === value.signalCode
        && typeof value.exit === 'boolean' && typeof value.close === 'boolean'
        && removals.has(value.removal) && [true, false, 'unknown'].includes(value.presentAfterRemoval)
        && ['active', 'ended'].includes(value.observer) && typeof value.truncated === 'boolean'
        && Array.isArray(value.events) && value.events.length <= 16
        && value.events.every(event => typeof event === 'string' && /^(.*)@(\d{1,8})ms$/.test(event)
          && events.has(event.split('@')[0]) && Number(event.match(/@(\d+)ms$/)[1]) <= 86400000)
        && Object.keys(value).sort().join(',') === (stageRoot
          ? 'close,dev,events,exit,exitCode,generation,ino,observer,presentAfterRemoval,removal,signalCode,truncated,v'
          : 'close,events,exit,exitCode,observer,presentAfterRemoval,removal,signalCode,truncated,v');
      if (!valid) { observations.delete(dir); continue; }
      observations.set(dir, { ...value, owner: safeOwner(owner) ? owner : 'unavailable' });
    }
    if (incomplete) observations.delete(incomplete);
  } catch { /* missing or unreadable observations are never cleanup success */ }
  finally { try { if (fd !== undefined) closeSync(fd); } catch { /* diagnostics only */ } }
  return { owners, observations, state };
}

export function describeOwnedBrowserObservation(value, state) {
  if (!value) return `provenance=${state === 'capped' ? 'capped' : 'unavailable'}`;
  return `owner=${value.owner} provenance=${state} snapshot=last-recorded fixture-before-global-backstop exitObserved=${value.exit} closeObserved=${value.close} exitCode=${value.exitCode} signalCode=${value.signalCode}`
    + ` removal=${value.removal} presentAfterRemoval=${value.presentAfterRemoval} presentAtGlobalGuard=true`
    + ` observer=${value.observer} events=${value.events.join(',')} truncated=${value.truncated}`;
}

// Inspect only the retained root, without following symlinks or printing names.
// Bound both traversal and output; 'other' includes unknown application entries.
export function describeStageFixtureRoot(path, value, state) {
  let identity = 'unavailable';
  const counts = { profile: 0, application: 0, other: 0 };
  let visited = 0;
  let capped = false;
  let unreadable = false;
  try {
    const current = lstatSync(path);
    identity = value?.v === 2 ? (current.dev === value.dev && current.ino === value.ino ? 'matches' : 'changed') : 'unavailable';
    const walk = (directory, category, depth) => {
      if (depth > 12 || visited >= 256) { capped = true; return; }
      const dir = opendirSync(directory);
      try {
        let entry;
        while ((entry = dir.readSync())) {
          if (visited++ >= 256) { capped = true; break; }
          const group = category || (entry.name === 'chrome-test-profile' ? 'profile'
            : ['code-animation', 'videos', 'video-thumbnails', 'uploads', 'music'].includes(entry.name) ? 'application' : 'other');
          counts[group]++;
          if (entry.isDirectory() && !entry.isSymbolicLink()) walk(resolve(directory, entry.name), group, depth + 1);
        }
      } finally { dir.closeSync(); }
    };
    if (current.isDirectory() && !current.isSymbolicLink()) walk(path, null, 0);
  } catch { unreadable = true; }
  return `${describeOwnedBrowserObservation(value, state)} generation=${value?.v === 2 ? value.generation : 'unavailable'}`
    + ` rootIdentity=${identity} profileEntries=${counts.profile} applicationEntries=${counts.application} otherEntries=${counts.other} contentsCapped=${capped} contentsUnreadable=${unreadable}`;
}
