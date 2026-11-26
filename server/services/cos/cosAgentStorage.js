/**
 * Machine-local maintenance of raw terminal recordings. History is never deleted.
 *
 * Storage: `file-primary` — `raw.txt.gz` is a lossless local asset alternative to
 * `raw.txt`, and its same-directory `raw-storage.json` is asset lifecycle metadata
 * (pin, checksum, disposition), not a relational history store. Both stay
 * machine-local; peer CoS sync keeps its metadata/output/prompt allowlist.
 * Filesystem backups include them and restore needs no conversion. History has no
 * age expiry: maintenance only compresses raw recordings (default after seven days)
 * and deletes them only when opted in; parsed output, prompts and metadata are never
 * removed. Policy lives in
 * the machine-local CoS config (`agentStorage`, `lastAgentStorageJob`).
 */
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createGzip, createGunzip, gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Writable, Transform } from 'node:stream';
import { z } from 'zod';
import { atomicWrite, createWriteStreamGuarded, unlinkGuarded } from '../../lib/fileUtils.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { publishRuntimeFiles, withRuntimeFileTurn } from '../../lib/runtimeFilePublication.js';
import { ServerError } from '../../lib/errorHandler.js';
import { scrubPlainRecording, scrubTerminalRecording } from '../../lib/privacyRecording.js';
import { AGENTS_DIR, loadConfig, saveConfig, withConfigLock, withStateLock, readAgentsStateForSafetyCheck } from './cosState.js';
import { cosEvents } from './cosEvents.js';
import { RECORDING_STAGE_NAME } from './recordingStages.js';

const DAY = 86400000;
const SCAN_CONCURRENCY = 16;
const AUTOMATIC_LIMIT = 25;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MANIFEST = 'raw-storage.json';
const recordingStageTurn = createKeyCachedQueue();
const zipRecording = promisify(gzip);
const unzipRecording = promisify(gunzip);
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
const json = async (path, stat = lstat(path)) => {
  if (!(await stat).isFile()) throw new Error('Non-regular metadata file');
  return JSON.parse(await readFile(path, 'utf8'));
};
async function readManifest(dir) {
  const value = await json(join(dir, MANIFEST)).catch(missing);
  if (value === null) return null;
  if (value.version !== 1 || typeof value.pinned !== 'boolean') throw new Error('Recording manifest is invalid');
  return value;
}
async function manifest(dir) {
  return await readManifest(dir) ?? { version: 1, pinned: false };
}

async function retireRecordingStages(dir, before = Infinity) {
  for (const name of await readdir(dir).catch(missing) ?? []) {
    if (!RECORDING_STAGE_NAME.test(name)) continue;
    const path = join(dir, name);
    const st = await info(path);
    if (st?.isFile() && st.mtimeMs < before) await unlinkGuarded(path).catch(missing);
  }
}

// The scrubber holds backup admission and the CoS state lock across directory
// discovery and this rewrite so maintenance cannot republish an older recording.
export async function scrubAgentRecordings(dir, values) {
  const plainPath = join(dir, 'raw.txt');
  await recordingStageTurn(dir, () => withRuntimeFileTurn(plainPath, async () => {
    // Let any staging and verification finish, then invalidate its unpublished
    // copy along with residue from earlier runs. Publication checks for absence.
    if (DATE.test(basename(dirname(dir)))) await retireRecordingStages(dir);
    const stat = await info(plainPath);
    if (stat && !stat.isFile()) return;
    const original = stat ? await readFile(plainPath, 'utf8') : '';
    await scrubPlainRecording(plainPath, original, values, cleaned => atomicWrite(plainPath, cleaned));
  }));

  const gzipPath = `${plainPath}.gz`;
  if (!(await info(gzipPath))?.isFile()) return;
  const original = (await unzipRecording(await readFile(gzipPath))).toString('utf8');
  const cleaned = scrubTerminalRecording(original, values);
  if (cleaned === original) return;

  const bytes = Buffer.from(cleaned);
  const compressed = await zipRecording(bytes);
  const storage = await readManifest(dir);
  if (!storage) {
    await atomicWrite(gzipPath, compressed);
    return;
  }
  const manifestPath = join(dir, MANIFEST);
  await publishRuntimeFiles([gzipPath, manifestPath], async () => {
    await atomicWrite(gzipPath, compressed);
    await atomicWrite(manifestPath, {
      ...storage, sha256: createHash('sha256').update(bytes).digest('hex'), originalBytes: bytes.length,
    });
  });
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
async function readLiveReferences() {
  const { trusted, agents } = await readAgentsStateForSafetyCheck();
  if (!trusted || !agents) return null;
  return { agents, metadataStrings: Object.values(agents).map(agent => JSON.stringify(agent.metadata || {})) };
}
async function inspect(dir, date, id, filters, now, live) {
  const metadataPath = join(dir, 'metadata.json');
  const metadataStat = lstat(metadataPath);
  const [record, storage, raw, gzip, output, prompt, metadataFile] = await Promise.all([
    json(metadataPath, metadataStat),
    manifest(dir),
    info(join(dir, 'raw.txt')),
    info(join(dir, 'raw.txt.gz')),
    info(join(dir, 'output.txt')),
    info(join(dir, 'prompt.txt')),
    metadataStat,
  ]);
  const metadata = record.metadata || {};
  const model = String(metadata.model || metadata.modelName || record.model || 'Unknown');
  const success = record.result?.success === true;
  const completed = Date.parse(record.completedAt);
  let commonReason = null;
  if (!live) commonReason = 'Live state unavailable';
  else if (live.agents[id]) commonReason = 'Still in live state';
  else if (live.metadataStrings.some(text => text.includes(id))) commonReason = 'Referenced by a live run';
  else if (record.id !== id || record.status !== 'completed' || !Number.isFinite(completed)) commonReason = 'Not a finalized run';
  else if (storage.pinned) commonReason = 'Pinned';
  else if (metadata.pipeline || metadata.pipelineId || metadata.resumeSessionId || metadata.resumeFromAgentId || metadata.resumedFromAgentId || record.result?.worktreePreserved) commonReason = 'Pipeline or resumable run';

  // Preserved worktrees carry potential resumable work, even after state eviction.
  const worktree = metadata.worktreePath || metadata.worktreeInfo?.path || (metadata.isWorktree && metadata.workspacePath);
  let worktreeInfo;
  const baseRow = {
    date, id, model, outcome: success ? 'success' : 'failure', completedAt: record.completedAt,
    retainedBytes: { metadata: metadataFile.size, output: output?.size || 0, prompt: prompt?.size || 0 },
    bytes: (raw?.size || 0) + (gzip?.size || 0), pinned: storage.pinned,
    state: raw ? 'plain' : gzip ? 'compressed' : storage.disposition === 'purged' ? 'purged' : 'absent',
    fingerprint: `${fingerprint(raw)}|${fingerprint(gzip)}`,
  };
  const results = await Promise.all(filters.map(async filter => {
    const matches = (!filter.model || model === filter.model) && (filter.outcome === 'all' || (filter.outcome === 'success') === success);
    let reason = commonReason;
    if (!reason) {
      if (completed > now - filter.olderThanDays * DAY) reason = 'Too recent';
      else if ([raw, gzip, output].some(st => st && !st.isFile())) reason = 'Non-regular artifact';
      else if ([raw, gzip, output].some(st => st && st.mtimeMs > now - DAY)) reason = 'Recently modified';
      else if (filter.action === 'compress' && raw && storage.compressionSkippedFingerprint === fingerprint(raw)) reason = 'Compression would not save space';
      else if (filter.action === 'compress' && !raw) reason = 'No uncompressed recording';
      else if (filter.action === 'purge' && !raw && !gzip) reason = 'No recording';
      else if (filter.action === 'purge' && (!output?.size || typeof metadata.taskSummary !== 'string' || !metadata.taskSummary.trim())) reason = 'Missing retained output or summary';
      else if (worktree && await (worktreeInfo ??= info(worktree))) reason = 'Preserved worktree';
    }
    return { filter, matches, row: { ...baseRow, eligible: matches && !reason, reason: !matches ? 'Outside filter' : reason } };
  }));
  return { dir, storage, raw, gzip, results };
}
async function* scanArchive(now, planForDate) {
  const live = await readLiveReferences();
  if (!(await info(AGENTS_DIR))?.isDirectory()) return;
  const dates = await readdir(AGENTS_DIR, { withFileTypes: true }).catch(missing) ?? [];
  for (const date of dates.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!date.isDirectory() || !DATE.test(date.name)) continue;
    if (!planForDate(date.name)) return;
    const bucket = join(AGENTS_DIR, date.name);
    if (!(await info(bucket))?.isDirectory()) continue;
    const entries = (await readdir(bucket, { withFileTypes: true }).catch(missing) ?? [])
      .filter(entry => entry.isDirectory() && SAFE_ID.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (let offset = 0; offset < entries.length;) {
      const plan = planForDate(date.name);
      if (!plan) return;
      const batch = entries.slice(offset, offset + Math.min(SCAN_CONCURRENCY, plan.limit));
      offset += batch.length;
      yield* await Promise.all(batch.map(async entry => {
        const dir = join(bucket, entry.name);
        if (!(await info(dir))?.isDirectory()) return null;
        return inspect(dir, date.name, entry.name, plan.filters, now, live);
      }).map(pending => pending.catch(() => null)));
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
  const candidates = [];
  const models = new Set();
  let matching = 0;
  const rows = [];
  const reasons = {};
  const totals = { recordingBytes: 0, eligibleBytes: 0, eligibleRuns: 0, scanned: 0, unreadable: 0, metadataBytes: 0, outputBytes: 0, promptBytes: 0 };
  for await (const entry of scanArchive(now, () => ({ filters: [filter], limit: SCAN_CONCURRENCY }))) {
    totals.scanned++;
    if (!entry) { totals.unreadable++; continue; }
    const [{ matches, row }] = entry.results;
    models.add(row.model);
    if (!matches) continue;
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
  const token = savePreview(now, filter, candidates);
  return { token, filter, totals, reasons, rows, models: [...models].sort(), matching, offset, batchLimit: limit };
}
function savePreview(now, filter, candidates) {
  for (const [key, value] of previews) if (now - value.createdAt > 15 * 60000) previews.delete(key);
  while (previews.size >= 5) previews.delete(previews.keys().next().value);
  const token = randomUUID();
  previews.set(token, { createdAt: now, filter, candidates });
  return token;
}
async function hashStream(stream, signal) {
  const hash = createHash('sha256');
  await pipeline(stream, new Writable({ write(chunk, encoding, done) { hash.update(chunk); done(); } }), { signal });
  return hash.digest('hex');
}
async function compress(signal, revalidate) {
  const entry = await revalidate();
  if (!entry || signal.aborted) return 0;
  const source = join(entry.dir, 'raw.txt');
  const target = `${source}.gz`;
  const temporary = `${target}.${randomUUID()}.tmp`;
  // The old plain file remains authoritative until a verified gzip is published.
  try {
    // Release the staging turn before acquiring backup admission or the state
    // lock, which a revocation can already hold while waiting for staging.
    const expected = await recordingStageTurn(entry.dir, async () => {
      await retireRecordingStages(entry.dir, Date.now() - DAY);
      const hash = createHash('sha256');
      const tap = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); done(null, chunk); } });
      await pipeline(createReadStream(source), tap, createGzip(), await createWriteStreamGuarded(temporary, { flags: 'wx' }), { signal });
      const expected = hash.digest('hex');
      const gunzip = createGunzip();
      const verifying = pipeline(createReadStream(temporary), gunzip, { signal });
      const [actual] = await Promise.all([hashStream(gunzip, signal), verifying]);
      if (actual !== expected) throw new Error('Recording verification failed');
      return expected;
    });
    return await withBackupAssetPublication(() => withStateLock(async () => {
      const fresh = await revalidate();
      if (!fresh || signal.aborted) return 0;
      const zipped = await info(temporary);
      if (!zipped) return 0;
      if (zipped.size >= fresh.raw.size) {
        await atomicWrite(join(entry.dir, MANIFEST), { ...fresh.storage, compressionSkippedFingerprint: fingerprint(fresh.raw) });
        return 0;
      }
      await rename(temporary, target);
      await atomicWrite(join(entry.dir, MANIFEST), { ...fresh.storage, disposition: 'compressed', sha256: expected, originalBytes: fresh.raw.size, compressedAt: new Date().toISOString() });
      await unlinkGuarded(source);
      return Math.max(0, fresh.raw.size + (fresh.gzip?.size || 0) - zipped.size);
    }));
  } finally {
    await unlinkGuarded(temporary).catch(missing);
  }
}
async function purge(signal, revalidate) {
  return withBackupAssetPublication(() => withStateLock(async () => {
    const fresh = await revalidate();
    if (!fresh || signal.aborted) return 0;
    // Persist intent before unlink. A crash leaves an explicit disposition and
    // surviving bytes visible; retries remove only the same allowlisted files.
    await atomicWrite(join(fresh.dir, MANIFEST), { ...fresh.storage, disposition: 'purged', purgedAt: new Date().toISOString(), removedFiles: ['raw.txt', 'raw.txt.gz'] });
    let reclaimed = 0;
    return (async () => {
      for (const [name, st] of [['raw.txt', fresh.raw], ['raw.txt.gz', fresh.gzip]]) {
        if (st) { await unlinkGuarded(join(fresh.dir, name)); reclaimed += st.size; }
      }
      return reclaimed;
    })().catch(err => { err.reclaimedBytes = reclaimed; throw err; });
  }));
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
        const dir = await safeDirectory(candidate.date, candidate.id);
        const live = await readLiveReferences();
        const fresh = await inspect(dir, candidate.date, candidate.id, [preview.filter], preview.createdAt, live);
        const [{ row }] = fresh.results;
        return row.eligible && row.fingerprint === candidate.fingerprint ? fresh : null;
      };
      await (async () => {
        const reclaimed = await (preview.filter.action === 'compress' ? compress : purge)(signal, revalidate);
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
  if (!policy.autoPurge && !policy.autoCompress) return;
  const now = Date.now();
  const actions = [];
  function addAction(action, olderThanDays) {
    // Archive buckets follow the completion date. Leave one day for timezone offsets.
    const cutoff = new Date(now - (olderThanDays - 1) * DAY).toISOString().slice(0, 10);
    actions.push({ filter: { action, olderThanDays, model: '', outcome: 'all' }, cutoff, candidates: [] });
  }
  if (policy.autoPurge) addAction('purge', policy.purgeAfterDays);
  if (policy.autoCompress) addAction('compress', policy.compressAfterDays);

  // Reuse the same artifact reads for compression fallback while looking for purge
  // candidates. Once the purge window ends, an available purge takes precedence.
  const purgeAction = actions.find(action => action.filter.action === 'purge');
  const planForDate = date => {
    if (purgeAction?.candidates.length && (purgeAction.candidates.length === AUTOMATIC_LIMIT || date > purgeAction.cutoff)) return null;
    const pending = actions.filter(action => date <= action.cutoff && action.candidates.length < AUTOMATIC_LIMIT);
    return pending.length ? {
      filters: pending.map(action => action.filter),
      limit: AUTOMATIC_LIMIT - pending[0].candidates.length,
    } : null;
  };
  for await (const entry of scanArchive(now, planForDate)) {
    for (const { filter, row } of entry?.results ?? []) {
      const action = actions.find(action => action.filter === filter);
      if (row.eligible && action.candidates.length < AUTOMATIC_LIMIT) action.candidates.push(row);
    }
  }
  const next = actions.find(action => action.candidates.length);
  if (next && !controller) return startAgentStorage({ token: savePreview(now, next.filter, next.candidates) }, { automatic: true });
}

export async function getAgentRecordingDownload(date, id) {
  const dir = await safeDirectory(date, id);
  for (const name of ['raw.txt', 'raw.txt.gz']) {
    if ((await info(join(dir, name)))?.isFile()) return { path: join(dir, name), name };
  }
  throw new ServerError('Raw recording was purged or was never captured; parsed output remains in run history', { status: 404, code: 'NOT_FOUND' });
}
