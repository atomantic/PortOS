import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../lib/fileCore.js';
import { codexRenderReceipt, readRenderReceipts, recordRenderReceipt, publishAccountingFile } from './imageRenderUsage.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Reads only PortOS's authoritative sidecars and completed queue metadata.
// Never consults provider session directories, filesystem mtimes, or prompts.
export async function planImageRenderBackfill(dataDir) {
  const directory = join(dataDir, 'image-render-usage');
  const existing = new Map((await readRenderReceipts({ directory })).map(row => [row.id, row]));
  const candidates = new Map();
  const coverage = { sidecars: 0, codexSidecars: 0, unattributedSidecars: 0, derived: 0, unrecoverable: 0, unreadable: 0, queueOnly: 0, duplicates: 0 };
  const representedFiles = new Set();
  const add = meta => {
    const receipt = codexRenderReceipt(meta);
    if (!receipt) { coverage.unrecoverable++; return; }
    if (candidates.has(receipt.id)) { coverage.duplicates++; return; }
    candidates.set(receipt.id, receipt);
  };
  const entries = await readdir(join(dataDir, 'images'), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.metadata.json')) continue;
    coverage.sidecars++;
    let meta;
    try { meta = JSON.parse(await readFile(join(dataDir, 'images', entry.name), 'utf8')); }
    catch (err) {
      // Permission failures stop this inventory; they are never an empty source.
      if (!(err instanceof SyntaxError)) throw err;
      coverage.unreadable++;
      continue;
    }
    representedFiles.add(entry.name.replace(/\.metadata\.json$/, '.png'));
    if (meta?.filename) representedFiles.add(meta.filename);
    if (!meta?.mode) coverage.unattributedSidecars++;
    if (meta?.mode !== 'codex') continue;
    coverage.codexSidecars++;
    if (meta.cleanedFrom || meta.filmLookFrom || meta.sourceFilename) { coverage.derived++; continue; }
    add(meta);
  }
  const queue = await readFile(join(dataDir, 'media-jobs.json'), 'utf8').then(JSON.parse).catch(err => {
    if (err.code === 'ENOENT') return { jobs: [] };
    throw err;
  });
  if (!Array.isArray(queue.jobs)) throw new Error('Invalid media queue history');
  for (const job of queue.jobs) {
    if (job.kind !== 'image' || job.status !== 'completed' || job.params?.mode !== 'codex' || !job.result?.filename || representedFiles.has(job.result.filename)) continue;
    coverage.queueOnly++;
    add({ mode: 'codex', id: job.result.generationId, model: job.params.model, createdAt: job.startedAt || job.completedAt });
  }
  const receipts = [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id));
  const pending = receipts.filter(row => !existing.has(row.id));
  return {
    version: 1, inventoryHash: hash(receipts), receipts,
    coverage: {
      ...coverage, eligibleOutputs: receipts.length,
      renderGroups: new Set(receipts.map(row => row.renderKey)).size,
      codexSessions: new Set(receipts.filter(row => row.identitySource === 'codex-session').map(row => row.renderKey)).size,
      jobIdentityGroups: new Set(receipts.filter(row => row.identitySource === 'portos-job').map(row => row.renderKey)).size,
      jobIdentityOutputs: receipts.filter(row => row.identitySource === 'portos-job').length,
      alreadyRecorded: receipts.length - pending.length, additiveOutputs: pending.length,
      earliest: receipts.map(row => row.occurredAt).sort()[0] || null,
      latest: receipts.map(row => row.occurredAt).sort().at(-1) || null,
    },
    unknown: ['image tokens', 'image cost', 'subscription allowance units', 'driver tokens', 'unsaved/failed image-tool calls', 'execution machine for historical sidecars without local queue evidence'],
  };
}

export async function applyImageRenderBackfill(dataDir, reviewedPlan, journalPath) {
  const current = await planImageRenderBackfill(dataDir);
  if (reviewedPlan.version !== 1 || current.inventoryHash !== reviewedPlan.inventoryHash || hash(reviewedPlan.receipts) !== current.inventoryHash) {
    throw new Error('Image inventory changed; create and review a new dry-run plan');
  }
  const batch = randomUUID();
  // Written BEFORE receipts: after interruption the batch marker identifies
  // precisely our additions, even if the final journal update did not land.
  const journal = { version: 1, batch, inventoryHash: current.inventoryHash, status: 'applying', plannedIds: current.receipts.map(row => row.id), inserted: 0 };
  if (!await publishAccountingFile(journalPath, journal)) throw new Error('Journal already exists; choose a new journal path');
  for (const receipt of current.receipts) {
    if (await recordRenderReceipt({ ...receipt, backfillBatch: batch }, { directory: join(dataDir, 'image-render-usage') })) journal.inserted++;
  }
  journal.status = 'complete';
  await atomicWrite(journalPath, journal);
  return { ...current.coverage, inserted: journal.inserted, batch };
}
