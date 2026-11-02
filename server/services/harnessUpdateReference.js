import { randomUUID } from 'node:crypto';
import { realpath, stat, lstat } from 'node:fs/promises';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { readBodyCapped } from '../lib/safeUrlFetch.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { getProviderRuntime, getProviderRuntimeStatus } from './providerRuntimeInstaller.js';
import { getRuntimeUpdateReviewSnapshot } from './runtimeUpdateReview.js';

// Public, direct-package references only. These do not establish what installed
// a PATH executable or what a vendor self-updater will select.
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const GHSA = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/i;
const CVE = /^CVE-\d{4}-\d{4,}$/i;
const CACHE_MS = 15 * 60 * 1000;
const PARTIAL_CACHE_MS = 60 * 1000;
const TICKET_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 12_000;
const MAX_PAGES = 5;

async function json(url, { maxBytes, headers = {} } = {}) {
  const response = await fetchWithTimeout(url, { headers, redirect: 'error' }, TIMEOUT_MS);
  if (!response.ok) { await response.body?.cancel(); throw new Error('Reference unavailable'); }
  const bytes = await readBodyCapped(response, maxBytes);
  if (!bytes) { await response.body?.cancel().catch(() => {}); throw new Error('Reference too large'); }
  return { data: JSON.parse(bytes.toString('utf8')), link: response.headers.get('link') || '' };
}

async function registry(packageName, candidateVersion) {
  const { data } = await json(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
    maxBytes: 32 * 1024 * 1024, headers: { accept: 'application/json', 'accept-encoding': 'identity' },
  });
  if (data?.name !== packageName || !VERSION.test(data?.['dist-tags']?.latest || '')) return { state: 'unknown', publishedAt: null };
  if (data['dist-tags'].latest !== candidateVersion) {
    return { state: 'incomparable', publishedAt: null };
  }
  if (data?.versions?.[candidateVersion]?.name !== packageName || data.versions[candidateVersion].version !== candidateVersion) return { state: 'unknown', publishedAt: null };
  const publishedAt = data.time?.[candidateVersion];
  const timestamp = typeof publishedAt === 'string' ? Date.parse(publishedAt) : NaN;
  return Number.isFinite(timestamp) && timestamp <= Date.now()
    ? { state: 'verified', publishedAt: new Date(timestamp).toISOString() }
    : { state: 'unknown', publishedAt: null };
}

function nextPage(link, current) {
  const next = link.split(',').find(part => /;\s*rel="next"/.test(part))?.match(/^\s*<([^>]+)>/i)?.[1];
  if (!next) return null;
  const url = new URL(next);
  const base = new URL(current);
  if (url.origin !== 'https://api.github.com' || url.pathname !== '/advisories'
    || ['ecosystem', 'type', 'affects', 'per_page'].some(key => url.searchParams.get(key) !== base.searchParams.get(key))
    || [...url.searchParams.keys()].some(key => !['ecosystem', 'type', 'affects', 'per_page', 'page', 'after', 'before'].includes(key))) throw new Error('Invalid advisory page');
  return url.href;
}

async function advisories(packageName, version) {
  const url = new URL('https://api.github.com/advisories');
  url.search = new URLSearchParams({ ecosystem: 'npm', type: 'reviewed', affects: `${packageName}@${version}`, per_page: '100' }).toString();
  let current = url.href;
  const items = new Map();
  let incomplete = false;
  for (let page = 0; page < MAX_PAGES && current; page += 1) {
    const response = await json(current, { maxBytes: 2 * 1024 * 1024,
      headers: { accept: 'application/vnd.github+json', 'accept-encoding': 'identity', 'user-agent': 'PortOS-harness-update-review' } }).catch(() => null);
    if (!response || !Array.isArray(response.data)) return { state: items.size ? 'partial' : 'unknown', items: [...items.values()] };
    const { data, link } = response;
    for (const advisory of data) {
      if (advisory?.withdrawn_at) continue;
      if (!GHSA.test(advisory?.ghsa_id || '')) { incomplete = true; continue; }
      const affected = Array.isArray(advisory.vulnerabilities) ? advisory.vulnerabilities.filter(entry =>
        entry?.package?.ecosystem === 'npm' && entry.package.name === packageName && typeof entry.vulnerable_version_range === 'string') : [];
      if (!affected.length) { incomplete = true; continue; }
      // Multiple ranges cannot be attributed to the version without evaluating
      // each range; keep the advisory but do not infer its target fix.
      const patched = affected.length === 1 && VERSION.test(affected[0].first_patched_version || '')
        ? [affected[0].first_patched_version] : [];
      items.set(advisory.ghsa_id, {
        id: advisory.ghsa_id, cve: CVE.test(advisory.cve_id || '') ? advisory.cve_id : null,
        severity: ['critical', 'high', 'medium', 'low'].includes(advisory.severity) ? advisory.severity : 'unknown',
        firstPatchedVersions: patched, url: `https://github.com/advisories/${advisory.ghsa_id}`,
      });
    }
    try { current = nextPage(link, current); }
    catch { return { state: 'partial', items: [...items.values()] }; }
  }
  return { state: current || incomplete ? 'partial' : 'checked', items: [...items.values()] };
}

function createReader({ readRegistry = registry, readAdvisories = advisories, now = Date.now } = {}) {
  return async ({ packageName, installedVersion, candidateVersion }) => {
    if (!packageName || !VERSION.test(installedVersion || '') || !VERSION.test(candidateVersion || '')) {
      return { state: 'unknown' };
    }
    const [release, installed, candidate] = await Promise.all([
      readRegistry(packageName, candidateVersion).catch(() => ({ state: 'unknown', publishedAt: null })),
      readAdvisories(packageName, installedVersion).catch(() => ({ state: 'unknown', items: [] })),
      readAdvisories(packageName, candidateVersion).catch(() => ({ state: 'unknown', items: [] })),
    ]);
    // A target is named a fix only when GitHub explicitly names it as the first
    // patched version and both exact-version queries completed successfully.
    const fixed = release.state === 'verified' && installed.state === 'checked' && candidate.state === 'checked'
      ? installed.items.filter(item => item.firstPatchedVersions.includes(candidateVersion)
        && !candidate.items.some(other => other.id === item.id)).map(item => item.id) : [];
    return { state: 'available', package: packageName, installedVersion, candidateVersion, release, installed, candidate, fixed, checkedAt: new Date(now()).toISOString() };
  };
}

const sameRow = (current, original) => Boolean(current && !current.unverified && current.revision === original.revision
  && current.harnessUpdate?.updatable && ['id', 'package', 'installedVersion', 'candidateVersion']
    .every(key => current.harnessUpdate[key] === original.harnessUpdate[key]));

async function captureExecutable(command) {
  const path = findCommandOnPath(command);
  if (!path) return null;
  const [target, file, link] = await Promise.all([realpath(path), stat(path), lstat(path)]);
  if (!file.isFile()) return null;
  const stamp = item => [item.dev, item.ino, item.size, item.mtimeMs, item.ctimeMs];
  return { path, target, file: stamp(file), link: stamp(link) };
}

function createService({ runtimeFor = getProviderRuntime, snapshot = getRuntimeUpdateReviewSnapshot,
  probe = (id) => getProviderRuntimeStatus(id, { fresh: true }), capture = captureExecutable,
  read = createReader(), now = Date.now, token = randomUUID,
  supported = () => ['darwin', 'linux'].includes(process.platform) } = {}) {
  const cache = new Map();
  const tickets = new Map();
  const rowFor = id => snapshot().items.find(item => item.id === `harness:${id}` && !item.unverified && item.harnessUpdate);
  const sameIdentity = (a, b) => a && b && JSON.stringify(a) === JSON.stringify(b);
  const reference = async (runtime, item) => {
    const key = `${runtime.id}:${item.installedVersion}:${item.candidateVersion}`;
    const existing = cache.get(key);
    if (existing && (existing.pending || now() - existing.at < existing.ttl)) return existing.pending || existing.value;
    for (const old of cache.keys()) if (old.startsWith(`${runtime.id}:`)) cache.delete(old);
    const entry = {};
    const pending = read({ packageName: runtime.npmPackage, installedVersion: item.installedVersion, candidateVersion: item.candidateVersion })
      .then(value => {
        const ttl = value.release?.state === 'verified' && value.installed?.state === 'checked' && value.candidate?.state === 'checked'
          ? CACHE_MS : PARTIAL_CACHE_MS;
        if (cache.get(key) === entry) cache.set(key, { value, at: now(), ttl });
        return value;
      }).catch(() => ({ state: 'unknown' }));
    entry.pending = pending;
    cache.set(key, entry);
    return pending;
  };
  const get = async id => {
    const runtime = runtimeFor(id);
    const row = runtime && rowFor(runtime.id);
    const item = row?.harnessUpdate;
    if (!runtime?.selfUpdate || !item?.updatable || !runtime.npmPackage || item.package !== runtime.npmPackage) return { state: 'unknown', ticket: null };
    const before = await capture(runtime.command).catch(() => null);
    const first = await probe(runtime.id).catch(() => null);
    if (!before || first?.version !== item.installedVersion) return { state: 'changed', ticket: null };
    const result = await reference(runtime, item);
    const last = await probe(runtime.id).catch(() => null);
    const after = await capture(runtime.command).catch(() => null);
    if (!sameIdentity(before, after) || last?.version !== item.installedVersion || !sameRow(rowFor(runtime.id), row)) return { state: 'changed', ticket: null };
    if (!supported()) return { ...result, ticket: null, unsupported: true };
    const time = now();
    for (const [key, value] of tickets) if (value.expiresAt <= time) tickets.delete(key);
    if (tickets.size >= 32) tickets.delete(tickets.keys().next().value);
    const idToken = token();
    tickets.set(idToken, { runtime: runtime.id, version: item.installedVersion, candidate: item.candidateVersion,
      identity: after, expiresAt: time + TICKET_MS });
    return { ...result, ticket: idToken };
  };
  const take = (id, ticket, version, candidate) => {
    const saved = tickets.get(ticket);
    tickets.delete(ticket);
    if (!saved || saved.expiresAt <= now() || saved.runtime !== id || saved.version !== version || saved.candidate !== candidate) return null;
    return saved;
  };
  const matches = async (runtime, saved) => {
    if (!saved || now() >= saved.expiresAt) return false;
    const actual = await capture(runtime.command).catch(() => null);
    return now() < saved.expiresAt && sameIdentity(saved.identity, actual);
  };
  return { get, take, matches };
}

const service = createService();
export const getHarnessUpdateReference = id => service.get(id);
export const takeHarnessUpdateTicket = (id, ticket, version, candidate) => service.take(id, ticket, version, candidate);
export const matchesHarnessUpdateTicket = (runtime, saved) => service.matches(runtime, saved);
export const __testing = { createReader, nextPage, createService };
