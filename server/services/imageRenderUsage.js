/**
 * Codex image render accounting: immutable per-output receipts grouped by Codex session.
 * 
 * Storage: `file-primary` (`data/image-render-usage/<sha256>.json`) — machine-local accounting log,
 * rsync-backed-up, never federated. Receipts publish via exclusive hard link so live completion and
 * backfill never double-count. Hashed identities only, no prompts or image bytes; absent until the
 * first receipt, so no seed or migration.
 *
 * Reads never scan receipts. `aggregates/` beside them is DERIVED: one compact row file per UTC day
 * (feeds the peer projection) and an `index.json` of per-day output counts and per-session first
 * output, driver-token maximum and job-identity flag (feeds the Usage totals). Receipts stay the
 * source of truth; a missing, unreadable or stale aggregate (its receipt-file count disagrees with the
 * directory listing, which also catches a lost cross-process update) is rebuilt from receipts on the
 * next read, so there is no seed and no migration. A damaged receipt is skipped and counted.
 */
import { createHash, randomUUID } from 'node:crypto';
import { link, open, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { atomicWrite, ensureDir, unlinkGuarded } from '../lib/fileCore.js';
import { createMutex } from '../lib/asyncMutex.js';
import { PATHS } from '../lib/paths.js';

const ledgerDir = () => join(PATHS.data, 'image-render-usage');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const day = value.slice(0, 10);
  const calendar = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== day) return null;
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
};
const digest = value => createHash('sha256').update(value).digest('hex');
const hashIdentity = z.string().regex(/^[a-f0-9]{64}$/);
// Missing evidence must fail the ledger read rather than imply a known session
// or a measured zero. Use the same contract for new and existing receipts.
const receiptSchema = z.object({
  version: z.literal(1), id: hashIdentity, renderKey: hashIdentity,
  occurredAt: z.string().refine(value => timestamp(value) === value),
  timestampSource: z.enum(['renderStartedAt', 'createdAt']),
  identitySource: z.enum(['codex-session', 'portos-job']),
  driverModel: z.string().nullable(),
  driverTokens: z.object({
    reportedTotal: z.number().int().nonnegative().safe(),
    source: z.literal('codex-cli-footer'),
  }).nullable(),
  imageTokens: z.null(), imageCostUsd: z.null(), allowanceUnits: z.null(),
  source: z.literal('portos-saved-render'),
  backfillBatch: z.string().regex(uuid).optional(),
});

// Project only accounting evidence. Never persist prompts, filenames, paths or
// session contents. A driver session may produce several image-tool outputs.
export function codexRenderReceipt(meta) {
  if (meta?.mode !== 'codex' || meta.cleanedFrom || meta.filmLookFrom || meta.sourceFilename) return null;
  const session = uuid.test(meta.codexSessionId) ? meta.codexSessionId : null;
  const job = [meta.id, meta.jobId].find(value => typeof value === 'string' && uuid.test(value));
  if (!session && !job) return null;
  const occurredAt = timestamp(meta.renderStartedAt) || timestamp(meta.createdAt);
  if (!occurredAt) return null;
  const renderKey = digest(`codex:${(session || job).toLowerCase()}`);
  // Without a job id, a recovered tool call supplies a stable output identity.
  const outputKey = digest(job ? `codex-job:${job.toLowerCase()}` : `${renderKey}:${meta.codexCallId || 'saved-output'}`);
  return {
    version: 1, id: outputKey, renderKey, occurredAt,
    timestampSource: timestamp(meta.renderStartedAt) ? 'renderStartedAt' : 'createdAt',
    identitySource: session ? 'codex-session' : 'portos-job',
    driverModel: typeof meta.model === 'string' ? meta.model : null,
    driverTokens: Number.isSafeInteger(meta.driverReportedTokens) && meta.driverReportedTokens >= 0
      ? { reportedTotal: meta.driverReportedTokens, source: 'codex-cli-footer' } : null,
    imageTokens: null, imageCostUsd: null, allowanceUnits: null,
    source: 'portos-saved-render',
  };
}

export async function readRenderReceipts({ directory = ledgerDir() } = {}) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(err => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const receipts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const receipt = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
    if (!receiptSchema.safeParse(receipt).success || receipt.id !== entry.name.slice(0, -5)) {
      throw new Error('Invalid image render usage receipt');
    }
    receipts.push(receipt);
  }
  return receipts;
}

// Publish a complete inode without replacing an existing receipt. Unlike a
// read/modify/write ledger this also serializes live renders against a separate
// backfill process. A crash leaves at most an ignored staging file.
export async function publishAccountingFile(path, value) {
  await ensureDir(dirname(path));
  const staging = join(dirname(path), `.${randomUUID()}.tmp`);
  await atomicWrite(staging, value);
  try {
    await link(staging, path);
    // The file bytes were flushed by atomicWrite. Flush the new directory
    // entry too; Windows does not support opening directories for fsync.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  } finally {
    await unlinkGuarded(staging);
  }
}

export async function recordRenderReceipt(receipt, { directory = ledgerDir(), aggregate = true } = {}) {
  if (!receiptSchema.safeParse(receipt).success) throw new Error('Invalid image render receipt');
  const path = join(directory, `${receipt.id}.json`);
  let existing = await readFile(path, 'utf8').then(JSON.parse).catch(err => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  if (existing === undefined) {
    if (await publishAccountingFile(path, receipt)) {
      // The receipt is already durable; a derived-aggregate failure must not fail the render.
      // The next read notices the stale count and rebuilds.
      if (aggregate) await addToAggregate(directory, receipt).catch(err => console.warn(`⚠️ Image usage aggregate update failed; it will rebuild on next read: ${err.message}`));
      return true;
    }
    existing = JSON.parse(await readFile(path, 'utf8'));
  }
  if (!receiptSchema.safeParse(existing).success || existing.id !== receipt.id) throw new Error('Conflicting image render receipt');
  return false;
}

const AGGREGATE_VERSION = 1;
const RECEIPT_NAME = /^[a-f0-9]{64}\.json$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const aggregateDir = directory => join(directory, 'aggregates');
const dayPath = (directory, day) => join(aggregateDir(directory), `${day}.json`);
const indexPath = directory => join(aggregateDir(directory), 'index.json');
const locks = new Map();
const withAggregateLock = (directory, work) => {
  if (!locks.has(directory)) locks.set(directory, createMutex());
  return locks.get(directory)(work);
};
const dayOf = receipt => receipt.occurredAt.slice(0, 10);
const compactRow = receipt => ({ id: receipt.id, renderKey: receipt.renderKey, occurredAt: receipt.occurredAt,
  identitySource: receipt.identitySource, driverTokens: receipt.driverTokens ?? null });
const rowOrder = (a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id);

const indexSchema = z.object({
  version: z.literal(AGGREGATE_VERSION),
  receiptFiles: z.number().int().nonnegative(), damaged: z.number().int().nonnegative(),
  days: z.record(z.string().regex(DAY), z.number().int().positive()),
  sessions: z.record(hashIdentity, z.object({
    first: z.string(), driver: z.number().int().nonnegative().safe().nullable(), job: z.boolean(),
  })),
});
const daySchema = z.object({ version: z.literal(AGGREGATE_VERSION), rows: z.array(z.object({
  id: hashIdentity, renderKey: hashIdentity, occurredAt: z.string(), identitySource: z.enum(['codex-session', 'portos-job']),
  driverTokens: receiptSchema.shape.driverTokens,
})) });

const emptyIndex = () => ({ version: AGGREGATE_VERSION, receiptFiles: 0, damaged: 0, days: {}, sessions: {} });
function countInto(index, receipt) {
  const day = dayOf(receipt);
  index.days[day] = (index.days[day] || 0) + 1;
  const session = index.sessions[receipt.renderKey] || { first: receipt.occurredAt, driver: null, job: false };
  if (receipt.occurredAt < session.first) session.first = receipt.occurredAt;
  const tokens = receipt.driverTokens;
  if (tokens?.source === 'codex-cli-footer' && Number.isSafeInteger(tokens.reportedTotal)) {
    session.driver = Math.max(session.driver ?? 0, tokens.reportedTotal);
  }
  session.job ||= receipt.identitySource === 'portos-job';
  index.sessions[receipt.renderKey] = session;
}

async function receiptNames(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(err => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  return entries.filter(entry => entry.isFile() && RECEIPT_NAME.test(entry.name)).map(entry => entry.name);
}

// Lenient scan used only to rebuild the aggregate: a receipt that cannot be
// parsed or fails the schema is skipped and counted rather than failing the report.
async function scanReceipts(directory, names) {
  const receipts = [];
  let damaged = 0;
  for (const name of names) {
    const raw = await readFile(join(directory, name), 'utf8');
    let receipt = null;
    try { receipt = JSON.parse(raw); } catch { /* counted below */ }
    if (receipt && receiptSchema.safeParse(receipt).success && receipt.id === name.slice(0, -5)) receipts.push(receipt);
    else damaged++;
  }
  return { receipts, damaged };
}

async function loadIndex(directory) {
  try {
    const parsed = indexSchema.safeParse(JSON.parse(await readFile(indexPath(directory), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
async function loadDay(directory, day) {
  try {
    const parsed = daySchema.safeParse(JSON.parse(await readFile(dayPath(directory, day), 'utf8')));
    return parsed.success ? parsed.data.rows : null;
  } catch { return null; }
}

async function rebuildAggregate(directory, names) {
  const { receipts, damaged } = await scanReceipts(directory, names);
  const index = { ...emptyIndex(), receiptFiles: names.length, damaged };
  const byDay = new Map();
  for (const receipt of receipts) {
    countInto(index, receipt);
    const day = dayOf(receipt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(compactRow(receipt));
  }
  if (!names.length) return index;
  await ensureDir(aggregateDir(directory));
  for (const [day, rows] of byDay) await atomicWrite(dayPath(directory, day), { version: AGGREGATE_VERSION, rows: rows.sort(rowOrder) });
  // Drop day files with no receipts left, then publish the index last: until it
  // lands, the stale count keeps the next read rebuilding.
  for (const file of await readdir(aggregateDir(directory))) {
    const day = file.slice(0, -5);
    if (file.endsWith('.json') && DAY.test(day) && !byDay.has(day)) await rm(join(aggregateDir(directory), file), { force: true });
  }
  await atomicWrite(indexPath(directory), index);
  return index;
}

async function addToAggregate(directory, receipt) {
  return withAggregateLock(directory, async () => {
    const index = await loadIndex(directory);
    const day = dayOf(receipt);
    const existing = index ? (index.days[day] ? await loadDay(directory, day) : []) : null;
    if (!index || !existing) return rebuildAggregate(directory, await receiptNames(directory));
    if (existing.some(row => row.id === receipt.id)) return index;
    await ensureDir(aggregateDir(directory));
    await atomicWrite(dayPath(directory, day), { version: AGGREGATE_VERSION, rows: [...existing, compactRow(receipt)].sort(rowOrder) });
    index.receiptFiles += 1;
    countInto(index, receipt);
    await atomicWrite(indexPath(directory), index);
    return index;
  });
}

/**
 * Current aggregate index, rebuilt from receipts when it is missing, unreadable or its
 * receipt-file count disagrees with the directory listing. Reads no receipt otherwise.
 */
export async function ensureRenderAggregate({ directory = ledgerDir() } = {}) {
  return withAggregateLock(directory, async () => {
    const names = await receiptNames(directory);
    const index = await loadIndex(directory);
    if (index && index.receiptFiles === names.length) return index;
    return rebuildAggregate(directory, names);
  });
}

/** Newest-first compact rows for the peer projection, read from at most the newest days needed. */
export async function readRenderProjectionRows({ directory = ledgerDir(), limit = Infinity } = {}) {
  const index = await ensureRenderAggregate({ directory });
  const rows = [];
  for (const day of Object.keys(index.days).sort().reverse()) {
    if (rows.length >= limit) break;
    let dayRows = await loadDay(directory, day);
    if (!dayRows) {
      await ensureRenderAggregate({ directory });
      dayRows = await loadDay(directory, day) ?? [];
    }
    rows.push(...dayRows);
  }
  const total = index.receiptFiles - index.damaged;
  return { receipts: rows.slice(0, limit), total, damaged: index.damaged, complete: total <= limit && index.damaged === 0 };
}

// Human-mode Codex prints a token footer, not image usage or a directional
// breakdown. Retain exactly that reported driver total without pricing it or
// adding it again to the independently reconciled text-token ledger.
export function codexDriverReportedTokens(output) {
  const match = output.match(/(?:^|\n)tokens used\r?\n([\d,]+)\s*$/);
  const value = match ? Number(match[1].replaceAll(',', '')) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function recordCodexRender(meta) {
  const receipt = codexRenderReceipt(meta);
  if (!receipt) throw new Error('Codex render lacks accounting identity or original timestamp');
  return recordRenderReceipt(receipt);
}

export function summarizeRenderReceipts(receipts, { from = null, to = null } = {}) {
  // Receipts can be mirrored between instances. Their output IDs are stable;
  // keep one output and preserve the largest reported footer for that output.
  const unique = new Map();
  let conflicts = false;
  for (const receipt of receipts) {
    const previous = unique.get(receipt.id);
    if (!previous) { unique.set(receipt.id, receipt); continue; }
    if (previous.renderKey !== receipt.renderKey || previous.occurredAt !== receipt.occurredAt || previous.identitySource !== receipt.identitySource) conflicts = true;
    const previousTokens = previous.driverTokens?.reportedTotal ?? -1;
    const tokens = receipt.driverTokens?.reportedTotal ?? -1;
    if (tokens > previousTokens) unique.set(receipt.id, { ...previous, driverTokens: receipt.driverTokens });
  }
  const inRange = (day) => (!from || day >= from) && (!to || day <= to);
  const savedOutputs = [...unique.values()].filter((receipt) => inRange(receipt.occurredAt.slice(0, 10))).length;
  // Filter sessions by their first observed output so a session spanning UTC
  // midnight is not counted twice in adjacent reporting windows.
  const sessions = new Map();
  for (const receipt of unique.values()) {
    const session = sessions.get(receipt.renderKey) || { occurredAt: receipt.occurredAt, fallback: false, driverTotal: null };
    if (receipt.occurredAt < session.occurredAt) session.occurredAt = receipt.occurredAt;
    if (receipt.driverTokens?.source === 'codex-cli-footer' && Number.isSafeInteger(receipt.driverTokens.reportedTotal)) {
      session.driverTotal = Math.max(session.driverTotal ?? 0, receipt.driverTokens.reportedTotal);
    }
    session.fallback ||= receipt.identitySource === 'portos-job';
    sessions.set(receipt.renderKey, session);
  }
  let renderSessions = 0, jobIdentitySessions = 0, driverSessionsMeasured = 0, driverReportedTotal = 0;
  for (const session of sessions.values()) {
    const day = session.occurredAt.slice(0, 10);
    if (!inRange(day)) continue;
    renderSessions++;
    if (session.fallback) jobIdentitySessions++;
    if (session.driverTotal !== null) { driverSessionsMeasured++; driverReportedTotal += session.driverTotal; }
  }
  return {
    scope: 'local-codex-saved-renders', renderGroups: renderSessions, codexSessions: renderSessions - jobIdentitySessions, savedOutputs, jobIdentityGroups: jobIdentitySessions,
    driverTokens: driverSessionsMeasured ? { reportedTotal: driverReportedTotal, sessionsMeasured: driverSessionsMeasured } : null,
    driverSessionsUnknown: renderSessions - driverSessionsMeasured,
    imageTokens: null, imageCostUsd: null, allowanceUnits: null, conflicts,
  };
}

export async function getImageRenderUsage({ from = null, to = null, directory } = {}) {
  const index = await ensureRenderAggregate({ directory });
  const inRange = day => (!from || day >= from) && (!to || day <= to);
  const savedOutputs = Object.entries(index.days).reduce((sum, [day, count]) => sum + (inRange(day) ? count : 0), 0);
  // Same rule as summarizeRenderReceipts: a session belongs to the day of its first output.
  let renderSessions = 0, jobIdentitySessions = 0, driverSessionsMeasured = 0, driverReportedTotal = 0;
  for (const session of Object.values(index.sessions)) {
    if (!inRange(session.first.slice(0, 10))) continue;
    renderSessions++;
    if (session.job) jobIdentitySessions++;
    if (session.driver !== null) { driverSessionsMeasured++; driverReportedTotal += session.driver; }
  }
  return {
    scope: 'local-codex-saved-renders', renderGroups: renderSessions, codexSessions: renderSessions - jobIdentitySessions, savedOutputs, jobIdentityGroups: jobIdentitySessions,
    driverTokens: driverSessionsMeasured ? { reportedTotal: driverReportedTotal, sessionsMeasured: driverSessionsMeasured } : null,
    driverSessionsUnknown: renderSessions - driverSessionsMeasured,
    imageTokens: null, imageCostUsd: null, allowanceUnits: null, conflicts: false, damaged: index.damaged,
  };
}
