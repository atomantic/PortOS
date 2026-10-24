import { createHash, randomUUID } from 'node:crypto';
import { link, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite, ensureDir, unlinkGuarded, syncDirectory } from '../lib/fileCore.js';
import { PATHS } from '../lib/paths.js';

const ledgerDir = () => join(PATHS.data, 'image-render-usage');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const digest = value => createHash('sha256').update(value).digest('hex');

// Project only accounting evidence. Never persist prompts, filenames, paths or
// session contents. A driver session may produce several image-tool outputs.
export function codexRenderReceipt(meta) {
  if (meta?.mode !== 'codex' || meta.cleanedFrom || meta.filmLookFrom || meta.sourceFilename) return null;
  const session = uuid.test(meta.codexSessionId) ? meta.codexSessionId : null;
  const job = [meta.id, meta.jobId].find(value => typeof value === 'string' && uuid.test(value));
  if (!session && !job) return null;
  const occurredAt = timestamp(meta.renderStartedAt) || timestamp(meta.createdAt);
  if (!occurredAt) return null;
  const renderKey = digest(`codex:${session || job}`);
  // Without a job id, a recovered tool call supplies a stable output identity.
  const outputKey = digest(`${renderKey}:${job || meta.codexCallId || 'saved-output'}`);
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
    if (receipt.version !== 1 || receipt.id !== entry.name.slice(0, -5) || !timestamp(receipt.occurredAt) || !/^[a-f0-9]{64}$/.test(receipt.renderKey)) {
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
    await syncDirectory(dirname(path));
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  } finally {
    await unlinkGuarded(staging);
  }
}

export async function recordRenderReceipt(receipt, { directory = ledgerDir() } = {}) {
  if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.id)) throw new Error('Invalid image render receipt identity');
  const path = join(directory, `${receipt.id}.json`);
  let existing = await readFile(path, 'utf8').then(JSON.parse).catch(err => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  if (existing === undefined) {
    if (await publishAccountingFile(path, receipt)) return true;
    existing = JSON.parse(await readFile(path, 'utf8'));
  }
  if (existing?.id !== receipt.id || existing.renderKey !== receipt.renderKey || existing.version !== 1) throw new Error('Conflicting image render receipt');
  return false;
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

export async function getImageRenderUsage({ from = null, to = null, directory } = {}) {
  const receipts = await readRenderReceipts({ directory });
  // Filter sessions by their first observed output so a session spanning UTC
  // midnight is not counted twice in adjacent reporting windows.
  const sessions = new Map();
  for (const receipt of receipts) {
    const session = sessions.get(receipt.renderKey) || { occurredAt: receipt.occurredAt, outputs: 0, fallback: false, driverTotal: null };
    if (receipt.occurredAt < session.occurredAt) session.occurredAt = receipt.occurredAt;
    session.outputs++;
    if (receipt.driverTokens?.source === 'codex-cli-footer' && Number.isSafeInteger(receipt.driverTokens.reportedTotal)) {
      session.driverTotal = Math.max(session.driverTotal ?? 0, receipt.driverTokens.reportedTotal);
    }
    session.fallback ||= receipt.identitySource === 'portos-job';
    sessions.set(receipt.renderKey, session);
  }
  let renderSessions = 0, savedOutputs = 0, jobIdentitySessions = 0, driverSessionsMeasured = 0, driverReportedTotal = 0;
  for (const session of sessions.values()) {
    const day = session.occurredAt.slice(0, 10);
    if ((from && day < from) || (to && day > to)) continue;
    renderSessions++;
    savedOutputs += session.outputs;
    if (session.fallback) jobIdentitySessions++;
    if (session.driverTotal !== null) { driverSessionsMeasured++; driverReportedTotal += session.driverTotal; }
  }
  return {
    scope: 'local-codex-saved-renders', renderSessions, savedOutputs, jobIdentitySessions,
    driverTokens: driverSessionsMeasured ? { reportedTotal: driverReportedTotal, sessionsMeasured: driverSessionsMeasured } : null,
    driverSessionsUnknown: renderSessions - driverSessionsMeasured,
    imageTokens: null, imageCostUsd: null, allowanceUnits: null,
  };
}
