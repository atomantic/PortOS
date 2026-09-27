/** Machine-local maintenance of raw terminal recordings. History is never deleted. */
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable, Transform } from 'node:stream';
import { z } from 'zod';
import { atomicWrite, createWriteStreamGuarded, unlinkGuarded } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { AGENTS_DIR, loadConfig, saveConfig, withConfigLock, withStateLock, readAgentsStateForSafetyCheck } from './cosState.js';
import { cosEvents } from './cosEvents.js';

const DAY = 86400000;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEMP_RECORDING = /^raw\.txt\.gz\.[0-9a-f-]{36}\.tmp$/;
const MANIFEST = 'raw-storage.json';
export const agentStoragePolicySchema = z.object({
  autoCompress: z.boolean().default(true),
  compressAfterDays: z.number().int().min(1).max(36500).default(7),
  autoPurge: z.boolean().default(false),
  purgeAfterDays: z.number().int().min(7).max(36500).default(90),
}).strict();
export const agentStorageFilterSchema = z.object({
  action: z.enum(['compress', 'purge']).default('compress'),
  olderThanDays: z.number().int().min(1).max(36500).default(7),
  model: z.string().max(300).default(''),
  outcome: z.enum(['all', 'success', 'failure']).default('all'),
}).strict();
const previews = new Map();
let job = null;
let controller = null;
const changed = () => cosEvents.emit('storage:changed', {});
const missing = err => { if (err.code === 'ENOENT') return null; throw err; };
const info = path => lstat(path).catch(missing);
const fingerprint = st => st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` : null;
const json = async path => {
  const st = await lstat(path);
  if (!st.isFile()) throw new Error('Non-regular metadata file');
  return JSON.parse(await readFile(path, 'utf8'));
};
async function manifest(dir) {
  const value = await json(join(dir, MANIFEST)).catch(missing);
  if (value === null) return { version: 1, pinned: false };
  if (value.version !== 1 || typeof value.pinned !== 'boolean') throw new Error('Recording manifest is invalid');
  return value;
}
function location(date, id) {
  if (!DATE.test(date) || !SAFE_ID.test(id)) throw new ServerError('Invalid run locator', { status: 400, code: 'VALIDATION_ERROR' });
  return join(AGENTS_DIR, date, id);
}
async function safeDirectory(date, id) {
  const dir = location(date, id);
  for (const path of [AGENTS_DIR, join(AGENTS_DIR, date), dir]) {
    if (!(await info(path))?.isDirectory()) throw new Error('Recording directory unavailable');
  }
  return dir;
}
async function inspect(date, id, filter, now, liveState) {
  const dir = await safeDirectory(date, id);
  const record = await json(join(dir, 'metadata.json'));
  const storage = await manifest(dir);
  const raw = await info(join(dir, 'raw.txt'));
  const gzip = await info(join(dir, 'raw.txt.gz'));
  const output = await info(join(dir, 'output.txt'));
  const prompt = await info(join(dir, 'prompt.txt'));
  const metadataFile = await info(join(dir, 'metadata.json'));
  const metadata = record.metadata || {};
  const model = String(metadata.model || metadata.modelName || record.model || 'Unknown');
  const success = record.result?.success === true;
  const matches = (!filter.model || model === filter.model) && (filter.outcome === 'all' || (filter.outcome === 'success') === success);
  const completed = Date.parse(record.completedAt);
  const state = liveState || await readAgentsStateForSafetyCheck();
  let reason = null;
  if (!state.trusted || !state.agents) reason = 'Live state unavailable';
  else if (state.agents[id]) reason = 'Still in live state';
  else if (Object.values(state.agents).some(agent => JSON.stringify(agent.metadata || {}).includes(id))) reason = 'Referenced by a live run';
  else if (record.id !== id || record.status !== 'completed' || !Number.isFinite(completed)) reason = 'Not a finalized run';
  else if (storage.pinned) reason = 'Pinned';
  else if (metadata.pipeline || metadata.pipelineId || metadata.resumeSessionId || metadata.resumeFromAgentId || metadata.resumedFromAgentId || record.result?.worktreePreserved) reason = 'Pipeline or resumable run';
  else if (completed > now - Math.max(1, filter.olderThanDays) * DAY) reason = 'Too recent';
  else if ([raw, gzip, output].some(st => st && !st.isFile())) reason = 'Non-regular artifact';
  else if ([raw, gzip, output].some(st => st && st.mtimeMs > now - DAY)) reason = 'Recently modified';
  else if (filter.action === 'compress' && raw && storage.compressionSkippedFingerprint === fingerprint(raw)) reason = 'Compression would not save space';
  else if (filter.action === 'compress' && !raw) reason = 'No uncompressed recording';
  else if (filter.action === 'purge' && !raw && !gzip) reason = 'No recording';
  else if (filter.action === 'purge' && (!output?.size || typeof metadata.taskSummary !== 'string' || !metadata.taskSummary.trim())) reason = 'Missing retained output or summary';
  // Preserved worktrees carry potential resumable work, even after state eviction.
  const worktree = metadata.worktreePath || metadata.worktreeInfo?.path || (metadata.isWorktree && metadata.workspacePath);
  if (!reason && worktree && await info(worktree)) reason = 'Preserved worktree';
  return { dir, storage, raw, gzip, record, matches, row: {
    date, id, model, outcome: success ? 'success' : 'failure', completedAt: record.completedAt,
    retainedBytes: { metadata: metadataFile?.size || 0, output: output?.size || 0, prompt: prompt?.size || 0 },
    bytes: (raw?.size || 0) + (gzip?.size || 0), pinned: storage.pinned,
    state: raw ? 'plain' : gzip ? 'compressed' : storage.disposition === 'purged' ? 'purged' : 'absent',
    eligible: matches && !reason, reason: !matches ? 'Outside filter' : reason,
    fingerprint: `${fingerprint(raw)}|${fingerprint(gzip)}`,
  } };
}
async function* locators() {
  const dates = await readdir(AGENTS_DIR, { withFileTypes: true }).catch(err => { if (err.code === 'ENOENT') return []; throw err; });
  for (const date of dates.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!date.isDirectory() || !DATE.test(date.name)) continue;
    for (const entry of (await readdir(join(AGENTS_DIR, date.name), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && SAFE_ID.test(entry.name)) yield { date: date.name, id: entry.name };
    }
  }
}
export async function getAgentStorageStatus() {
  const config = await loadConfig();
  return { policy: agentStoragePolicySchema.parse(config.agentStorage || {}), job: job ? { ...job } : config.lastAgentStorageJob || null };
}
export async function updateAgentStoragePolicy(input) {
  const policy = agentStoragePolicySchema.parse(input);
  await withConfigLock(async () => {
    const current = await loadConfig();
    await saveConfig({ ...current, agentStorage: policy });
  });
  changed();
  // Reconcile immediately; the same gates are read again between auto-job files.
  void runAutomaticAgentStorage().catch(() => console.error('❌ CoS recording maintenance could not start'));
  return getAgentStorageStatus();
}
export async function previewAgentStorage(input, { limit = 1000, offset = 0 } = {}) {
  const filter = agentStorageFilterSchema.parse(input);
  const now = Date.now();
  const liveState = await readAgentsStateForSafetyCheck();
  const candidates = [];
  const models = new Set();
  let matching = 0;
  const rows = [];
  const reasons = {};
  const totals = { recordingBytes: 0, eligibleBytes: 0, eligibleRuns: 0, scanned: 0, unreadable: 0, metadataBytes: 0, outputBytes: 0, promptBytes: 0 };
  for await (const { date, id } of locators()) {
    const entry = await inspect(date, id, filter, now, liveState).catch(() => null);
    totals.scanned++;
    if (!entry) { totals.unreadable++; continue; }
    const row = entry.row;
    models.add(row.model);
    if (!entry.matches) continue;
    totals.recordingBytes += row.bytes;
    totals.metadataBytes += row.retainedBytes.metadata;
    totals.outputBytes += row.retainedBytes.output;
    totals.promptBytes += row.retainedBytes.prompt;
    if (row.eligible && candidates.length < limit) {
      candidates.push(row);
      totals.eligibleBytes += row.bytes;
      totals.eligibleRuns++;
    } else {
      const reason = row.reason || 'Next batch';
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
    if (matching++ >= offset && rows.length < 25) rows.push(row);
  }
  for (const [key, value] of previews) if (now - value.createdAt > 15 * 60000) previews.delete(key);
  while (previews.size >= 5) previews.delete(previews.keys().next().value);
  const token = randomUUID();
  previews.set(token, { createdAt: now, filter, candidates });
  return { token, filter, totals, reasons, rows, models: [...models].sort(), matching, offset, batchLimit: limit };
}
async function hashStream(stream, signal) {
  const hash = createHash('sha256');
  await pipeline(stream, new Writable({ write(chunk, encoding, done) { hash.update(chunk); done(); } }), { signal });
  return hash.digest('hex');
}
async function compress(entry, signal, revalidate) {
  const source = join(entry.dir, 'raw.txt');
  const target = `${source}.gz`;
  const temporary = `${target}.${randomUUID()}.tmp`;
  // Recover only our reserved, old temporary files after an interrupted process.
  for (const name of await readdir(entry.dir)) {
    if (!TEMP_RECORDING.test(name)) continue;
    const path = join(entry.dir, name);
    const st = await info(path);
    if (st?.isFile() && st.mtimeMs < Date.now() - DAY) await unlinkGuarded(path);
  }
  const hash = createHash('sha256');
  const tap = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); done(null, chunk); } });
  // The old plain file remains authoritative until a verified gzip is published.
  return (async () => {
    await pipeline(createReadStream(source), tap, createGzip(), await createWriteStreamGuarded(temporary, { flags: 'wx' }), { signal });
    const expected = hash.digest('hex');
    const gunzip = createGunzip();
    const verifying = pipeline(createReadStream(temporary), gunzip, { signal });
    const [actual] = await Promise.all([hashStream(gunzip, signal), verifying]);
    if (actual !== expected) throw new Error('Recording verification failed');
    return withStateLock(async () => {
      const fresh = await revalidate();
      if (!fresh || signal.aborted) return 0;
      const zipped = await info(temporary);
      if (zipped.size >= fresh.raw.size) {
        await atomicWrite(join(entry.dir, MANIFEST), { ...fresh.storage, compressionSkippedFingerprint: fingerprint(fresh.raw) });
        return 0;
      }
      await rename(temporary, target);
      await atomicWrite(join(entry.dir, MANIFEST), { ...fresh.storage, disposition: 'compressed', sha256: expected, originalBytes: fresh.raw.size, compressedAt: new Date().toISOString() });
      await unlinkGuarded(source);
      return Math.max(0, fresh.raw.size + (fresh.gzip?.size || 0) - zipped.size);
    });
  })().finally(() => unlinkGuarded(temporary).catch(err => { if (err.code !== 'ENOENT') throw err; }));
}
async function purge(entry, signal, revalidate) {
  return withStateLock(async () => {
    const fresh = await revalidate();
    if (!fresh || signal.aborted) return 0;
    // Persist intent before unlink. A crash leaves an explicit disposition and
    // surviving bytes visible; retries remove only the same allowlisted files.
    await atomicWrite(join(entry.dir, MANIFEST), { ...fresh.storage, disposition: 'purged', purgedAt: new Date().toISOString(), removedFiles: ['raw.txt', 'raw.txt.gz'] });
    let reclaimed = 0;
    return (async () => {
      for (const [name, st] of [['raw.txt', fresh.raw], ['raw.txt.gz', fresh.gzip]]) {
        if (st) { await unlinkGuarded(join(entry.dir, name)); reclaimed += st.size; }
      }
      return reclaimed;
    })().catch(err => { err.reclaimedBytes = reclaimed; throw err; });
  });
}
export async function startAgentStorage({ token, confirmation }, { automatic = false } = {}) {
  if (controller) throw new ServerError('Recording maintenance already running', { status: 409, code: 'CONFLICT' });
  const preview = previews.get(token);
  if (!preview || Date.now() - preview.createdAt > 15 * 60000) throw new ServerError('Preview expired; preview again', { status: 409, code: 'STALE_PREVIEW' });
  if (preview.filter.action === 'purge' && !automatic && confirmation !== 'PURGE RAW RECORDINGS') throw new ServerError('Confirm raw recording deletion', { status: 400, code: 'VALIDATION_ERROR' });
  previews.delete(token);
  controller = new AbortController();
  job = { id: randomUUID(), action: preview.filter.action, state: 'running', total: preview.candidates.length, processed: 0, skipped: 0, failed: 0, reclaimedBytes: 0, startedAt: new Date().toISOString() };
  const signal = controller.signal;
  changed();
  void (async () => {
    for (const candidate of preview.candidates) {
      if (signal.aborted) break;
      const revalidate = async () => {
        if (automatic) {
          const { policy } = await getAgentStorageStatus();
          if (!(preview.filter.action === 'compress' ? policy.autoCompress : policy.autoPurge)) return null;
          if ((preview.filter.action === 'compress' ? policy.compressAfterDays : policy.purgeAfterDays) !== preview.filter.olderThanDays) return null;
        }
        const fresh = await inspect(candidate.date, candidate.id, preview.filter, preview.createdAt);
        return fresh.row.eligible && fresh.row.fingerprint === candidate.fingerprint ? fresh : null;
      };
      await (async () => {
        const entry = await revalidate();
        if (!entry) { job.skipped++; return; }
        const reclaimed = await (preview.filter.action === 'compress' ? compress : purge)(entry, signal, revalidate);
        job.reclaimedBytes += reclaimed;
        if (!reclaimed) job.skipped++;
      })().catch(err => {
        job.reclaimedBytes += err.reclaimedBytes || 0;
        if (!signal.aborted) job.failed++;
      });
      job.processed++;
      changed();
    }
    job.state = signal.aborted ? 'cancelled' : job.failed ? 'completed-with-errors' : 'completed';
  })().catch(() => { job.state = 'failed'; }).finally(async () => {
    job.finishedAt = new Date().toISOString();
    // Small latest-operation audit lives in the existing machine-local config.
    await withConfigLock(async () => {
      const current = await loadConfig();
      await saveConfig({ ...current, lastAgentStorageJob: { ...job } });
    }).catch(() => { job.state = 'audit-write-failed'; });
    controller = null;
    changed();
  });
  return getAgentStorageStatus();
}
export function cancelAgentStorage() {
  controller?.abort();
  return getAgentStorageStatus();
}
export async function pinAgentRecording({ date, id, pinned }) {
  await withStateLock(async () => {
    const dir = await safeDirectory(date, id);
    const value = await manifest(dir);
    await atomicWrite(join(dir, MANIFEST), { ...value, pinned });
  });
  changed();
  return { date, id, pinned };
}
export async function runAutomaticAgentStorage() {
  if (controller) return;
  const { policy } = await getAgentStorageStatus();
  const action = policy.autoPurge ? 'purge' : 'compress';
  if (!policy.autoPurge && !policy.autoCompress) return;
  const preview = await previewAgentStorage({ action, olderThanDays: action === 'purge' ? policy.purgeAfterDays : policy.compressAfterDays }, { limit: 25 });
  if (preview.totals.eligibleRuns) return startAgentStorage({ token: preview.token }, { automatic: true });
  if (policy.autoPurge && policy.autoCompress) {
    const compression = await previewAgentStorage({ action: 'compress', olderThanDays: policy.compressAfterDays }, { limit: 25 });
    if (compression.totals.eligibleRuns) return startAgentStorage({ token: compression.token }, { automatic: true });
  }
}

export async function getAgentRecordingDownload(date, id) {
  const dir = await safeDirectory(date, id);
  for (const name of ['raw.txt', 'raw.txt.gz']) {
    if ((await info(join(dir, name)))?.isFile()) return { path: join(dir, name), name };
  }
  throw new ServerError('Raw recording was purged or was never captured; parsed output remains in run history', { status: 404, code: 'NOT_FOUND' });
}
