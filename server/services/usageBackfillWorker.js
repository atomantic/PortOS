import { isMainThread, parentPort, workerData } from 'worker_threads';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { estimateTokens, estimateTokensFromChars } from '../lib/contextBudget.js';
import { readJSONFile, tryReadFile } from '../lib/fileUtils.js';
import {
  mergeUsageClaims,
  readMeasuredUsage,
  reconcileRunUsage,
  resolveFamilyProvider,
  snapshotUsageClaims,
  TRANSCRIPT_FAMILIES,
  transcriptFamily,
  WINDOW_SLACK_MS
} from './usageReconciler.js';

const listRunIds = async (runsDir) => readdir(runsDir, { withFileTypes: true })
  .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  .catch(() => []);

const asList = (records) => (Array.isArray(records) ? records.flat(Infinity) : [records]);

/**
 * Is this correction worth persisting?
 *
 * A `measured` parent record is the original #3124 case. A `source: 'estimate'`
 * record from a TRANSCRIPT is not the same thing as the prompt/stdout estimate
 * it replaces — Antigravity writes no token counts at all, so every one of its
 * rows is chars/4 of the real transcript, which is still far closer to the truth
 * than chars/4 of the task description. Dropping those would leave `agy` spend
 * permanently invisible, so a sibling record counts regardless of its source.
 */
const isWorthRecording = (records, siblings) => siblings.length > 0
  || records.some((entry) => entry?.source === 'measured' || entry?.source === 'mixed');

const runWindow = (metadata) => ({
  from: Date.parse(metadata.startTime) - WINDOW_SLACK_MS,
  to: Date.parse(metadata.endTime) + WINDOW_SLACK_MS
});

// Transcript readers match a cwd or any subdirectory of it, so runs whose
// workspaces nest inside one another can read the same session.
const workspaceAncestors = (path) => {
  const ancestors = [];
  for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
    ancestors.push(path.slice(0, cut));
  }
  return ancestors;
};

/**
 * Re-claim what settled runs already billed, before any pending run is read.
 *
 * Every message inside a settled pass's window was billed — by that run or by
 * an earlier overlapping one — so re-reading the window and discarding the
 * counts claims exactly what is already on the books. The live ledger handed
 * over in `claimsSeed` cannot carry that alone: it is empty after a restart
 * and prunes claims past its retention bound, while this scan reaches runs of
 * any age. Only settled runs that can overlap a pending one are re-read, and
 * only for the families each settled pass actually covered. Each re-read stops
 * at the moment that pass was reconciled: a message written later (inside the
 * trailing slack) was never seen, so it still belongs to whichever run owns it.
 * A run marked only in usage.json carries no such moment and is re-read whole.
 */
async function claimSettledUsage(runs, candidates, { home, providers }) {
  const below = new Map();
  const at = new Map();
  const index = (map, key, window) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(window);
  };
  for (const { metadata } of candidates) {
    const window = runWindow(metadata);
    index(at, metadata.workspacePath, window);
    index(below, metadata.workspacePath, window);
    for (const ancestor of workspaceAncestors(metadata.workspacePath)) index(below, ancestor, window);
  }
  const canScanSiblings = Array.isArray(providers) && providers.length > 0;
  for (const { metadata, parentSettled, siblingSettled } of runs) {
    const { workspacePath } = metadata;
    const window = runWindow(metadata);
    const pending = [
      ...(below.get(workspacePath) || []),
      ...workspaceAncestors(workspacePath).flatMap((ancestor) => at.get(ancestor) || [])
    ];
    if (!pending.some((other) => other.from <= window.to && window.from <= other.to)) continue;
    const parentFamily = transcriptFamily(metadata);
    const reads = parentSettled && parentFamily
      ? [{ family: parentFamily, seenUntil: metadata.usageReconciledAt }]
      : [];
    if (siblingSettled && canScanSiblings) {
      const seenUntil = metadata.usageSiblingsReconciledAt ?? metadata.usageReconciledAt;
      for (const family of TRANSCRIPT_FAMILIES) {
        if (family !== parentFamily && resolveFamilyProvider(providers, family)) reads.push({ family, seenUntil });
      }
    }
    for (const { family, seenUntil } of reads) {
      await readMeasuredUsage({
        workspacePath,
        startTime: metadata.startTime,
        endTime: metadata.endTime,
        family,
        home,
        seenUntil: typeof seenUntil === 'string' ? seenUntil : null
      }).catch(() => null);
    }
  }
}

/**
 * Read historical run artifacts and produce estimate→measurement corrections.
 * This function runs inside a worker in production so parsing large JSONL files
 * never blocks the server event loop; it is exported for fixture-based tests.
 *
 * Two independent passes share one walk of the run directory:
 *
 *   parent  — replace a run's own prompt/stdout estimate with its CLI's measured
 *             counts. Runs once per run (`reconciledRunIds` / `usageReconciled`).
 *   sibling — attribute a nested reviewer CLI's session (a `--review-with`
 *             grok/antigravity pass leaves a session but never a PortOS run) to
 *             ITS provider. This must run even on a run whose parent pass is
 *             already done, so it carries its own marker
 *             (`siblingReconciledRunIds` / `usageSiblingsReconciled`) — without
 *             a separate one, either every already-measured Claude run stays
 *             blind to its nested grok spend, or the parent swap re-applies.
 *
 * @param {{ providers?: Array<object> }} args `providers` is the install's
 *   provider list, passed in from the main thread: the toolkit singleton this
 *   worker would need to resolve it itself is never initialized here.
 */
export async function scanHistoricalUsage({
  runsDir,
  home,
  reconciledRunIds = [],
  siblingReconciledRunIds = [],
  providers = null,
  claimsSeed = null,
  onProgress = () => {}
}) {
  // This function runs inside a worker thread, which gets its own empty copy
  // of usageReconciler.js's module-level claim ledger — seed it from the main
  // thread's ledger so a message the live completion path already billed is
  // not billed again here. The caller merges this scan's final ledger state
  // back into the main thread's ledger once this resolves (see `home`'s
  // sibling `claimsSnapshot` in the return value).
  if (claimsSeed) mergeUsageClaims(claimsSeed);
  const reconciled = new Set(reconciledRunIds);
  const siblingReconciled = new Set(siblingReconciledRunIds);
  const canScanSiblings = Array.isArray(providers) && providers.length > 0;
  const candidates = [];
  const settled = [];

  for (const runId of await listRunIds(runsDir)) {
    const metadataPath = join(runsDir, runId, 'metadata.json');
    const metadata = await readJSONFile(metadataPath, null);
    if (!metadata || !metadata.providerId || typeof metadata.workspacePath !== 'string' || !metadata.workspacePath
      || typeof metadata.startTime !== 'string' || typeof metadata.endTime !== 'string'
      || !Number.isFinite(Date.parse(metadata.startTime)) || !Number.isFinite(Date.parse(metadata.endTime))) continue;
    const parentPending = !reconciled.has(runId) && !metadata.usageReconciled
      && Boolean(transcriptFamily(metadata));
    // The sibling pass has no parent-family precondition: an Ollama-backed run
    // that bash-launched `grok` for its review leaves a grok session and writes
    // no transcript of its own.
    const siblingPending = canScanSiblings
      && !siblingReconciled.has(runId) && !metadata.usageSiblingsReconciled;
    const parentSettled = reconciled.has(runId) || metadata.usageReconciled === true;
    const siblingSettled = siblingReconciled.has(runId) || metadata.usageSiblingsReconciled === true;
    if (parentSettled || siblingSettled) settled.push({ metadata, parentSettled, siblingSettled });
    if (!parentPending && !siblingPending) continue;
    candidates.push({ runId, metadataPath, metadata, parentPending, siblingPending });
  }
  if (candidates.length) await claimSettledUsage(settled, candidates, { home, providers });
  candidates.sort((a, b) => Date.parse(a.metadata.startTime) - Date.parse(b.metadata.startTime));

  const corrections = [];
  let processed = 0;
  onProgress({ processed, total: candidates.length, found: corrections.length });
  for (const candidate of candidates) {
    const output = await tryReadFile(join(runsDir, candidate.runId, 'output.txt'));
    const estimate = {
      messages: 1,
      tokensIn: estimateTokensFromChars(candidate.metadata.promptLength),
      tokensOut: estimateTokens(output || ''),
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    };
    const records = asList(await reconcileRunUsage(candidate.metadata, estimate, {
      home,
      providers: candidate.siblingPending ? providers : null
    }));
    const siblings = records.filter((entry) => entry?.role === 'sibling');
    // A run whose parent pass already ran still gets its transcript re-read (the
    // sibling scan shares one reconcile call), but those parent records must be
    // discarded — re-applying the swap would subtract an estimate that is no
    // longer in the bucket.
    const parentRecords = candidate.parentPending
      ? records.filter((entry) => entry?.role !== 'sibling')
      : [];
    if (isWorthRecording(parentRecords, siblings)) {
      corrections.push({
        runId: candidate.runId,
        metadataPath: candidate.metadataPath,
        day: candidate.metadata.endTime.slice(0, 10),
        providerId: candidate.metadata.providerId,
        model: candidate.metadata.model ?? null,
        // Null when the parent pass already ran — the day bucket holds measured
        // counts by then, and there is no estimate left to remove.
        estimate: parentRecords.length ? estimate : null,
        measured: parentRecords.length ? parentRecords : null,
        siblings,
        siblingScanned: candidate.siblingPending
      });
    }
    processed++;
    onProgress({ processed, total: candidates.length, found: corrections.length });
  }

  return { corrections, processed, total: candidates.length, claimsSnapshot: snapshotUsageClaims() };
}

if (!isMainThread) {
  scanHistoricalUsage({
    ...workerData,
    onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress })
  })
    .then((result) => parentPort.postMessage({ type: 'complete', result }))
    .catch((error) => parentPort.postMessage({ type: 'error', error: error.message }));
}
