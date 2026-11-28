/**
 * The on-disk store for project-specific trained jev heads.
 *
 * Three states a decision can be in, and they are never collapsed:
 *
 *   no candidate           — nothing has been trained for this decision
 *   candidate, not adopted — trained and scored, awaiting an operator's call
 *   adopted                — in use by `runJevDecision` for this decision
 *
 * TRAINING NEVER ADOPTS. A run writes a candidate and stops; adoption is a
 * separate explicit action, and `adoptJevHead` refuses one whose measured
 * accuracy does not beat BOTH baselines. That refusal is server-side on
 * purpose: a UI that merely hides the button is a suggestion, and the number it
 * hides the button over came from this machine's own private history.
 *
 * ## Layout, and why it is where it is
 *
 *   data/jev/heads/<decisionId>.json            adopted — BACKED UP
 *   data/jev/heads/<decisionId>.candidate.json  awaiting a decision — BACKED UP
 *   data/jev/corpora/                           regenerable — excluded
 *   data/jev/embeddings/                        regenerable cache — excluded
 *
 * A head is NOT regenerable once the corpus behind it is gone: the forge moves
 * on, issues close, and the exact query that produced a corpus a month ago
 * returns something else today. It is also the only artifact here an operator
 * made a decision about. Corpora and cached embeddings are bulk that re-derives
 * — see `DEFAULT_EXCLUDES` in `services/backup.js` and `docs/BACKUP.md`.
 *
 * ## Privacy
 *
 * Every byte under `data/jev/` is a derived record of this install's private
 * repository history and the operator's own judgement calls. It is
 * MACHINE-LOCAL: never federated, never in a peer sync, never in a status or
 * capability payload. The ADR
 * [privacy records machine-local](../../docs/decisions/2026-08-08-privacy-records-machine-local.md)
 * covers the path, and `sharing/jevNeverFederates.test.js` is the guard.
 */

import { notifyJevChanged } from './jevEvents.js';
import { readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, ensureDir, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { JEV_MODEL } from '../lib/jev.js';
import { JEV_DECISION_IDS } from '../lib/jevDecisions.js';
import { headAdoptionBlocker, isHeadCompatible, jevHeadFileName, jevHeadSlug, parseJevHead } from '../lib/jevHead.js';
import { jevHeadsDir } from '../lib/jevPaths.js';

const failure = (code) => ({ ok: false, code });

// Filenames come from `jevHeadFileName`, the one owner of the decision-id ↔
// slug mapping. Spelling `${decisionId}.json` here would be a fourth
// independent derivation of it.
const headPath = (decisionId, options) => join(jevHeadsDir(), jevHeadFileName(decisionId, options));

/**
 * Which decisions have an applicable adopted head, by id. The VERDICT, not the head: the
 * sidecar reads weights from disk, so caching the artifact would pin megabytes in module
 * scope to answer a boolean. `false` entries are cached too (no-head is the common case).
 * Invalidated by every write path here and by the test seam below.
 */
let adoptedCache = null;
const queueHeadWork = createFileWriteQueue();

/** Test seam, mirroring the cache resets on the sibling local-model services. */
export const resetJevHeadCache = () => { adoptedCache = null; };

export const withLiveRestore = restore => queueHeadWork(() => restore(resetJevHeadCache));

async function readHeadFile(path) {
  const content = await tryReadFile(path);
  if (content === null) return failure('jev-head-not-found');
  const parsed = safeJSONParse(content, null, { allowArray: false, logError: false });
  if (parsed === null) return failure('jev-head-unreadable');
  return parseJevHead(parsed);
}

/**
 * The head slug `decisionId` is currently scored with, or null. The slug IS the decision id
 * (`jevHeadSlug`); the sidecar resolves it in the heads directory, so callers never hold
 * the weights. Null, never a failure, for every reason a head might not apply (none
 * adopted, unreadable, different encoder revision): scoring falls back to the stock
 * zero-shot classifier. `describeJevHeads` explains why.
 */
export async function getAdoptedJevHeadSlug(decisionId) {
  if (!JEV_DECISION_IDS.includes(decisionId)) return null;
  if (adoptedCache?.has(decisionId)) return adoptedCache.get(decisionId);
  return queueHeadWork(async () => {
    if (adoptedCache?.has(decisionId)) return adoptedCache.get(decisionId);
    const result = await readHeadFile(headPath(decisionId));
    const slug = result.ok && isHeadCompatible(result.head, JEV_MODEL) ? jevHeadSlug(decisionId) : null;
    adoptedCache ??= new Map();
    adoptedCache.set(decisionId, slug);
    return slug;
  });
}

/**
 * Operator-facing state for every decision with an artifact on disk: metrics and the
 * adoption blocker, never a corpus row, premise or path. `compatible: false` is stated, not
 * hidden: a head that stopped applying because the pinned model revision moved is a fact.
 */
export async function describeJevHeads() {
  const dir = jevHeadsDir();
  const entries = await readdir(dir).catch(() => []);
  const rows = [];
  for (const decisionId of JEV_DECISION_IDS) {
    for (const candidate of [false, true]) {
      const name = jevHeadFileName(decisionId, { candidate });
      if (name === null || !entries.includes(name)) continue;
      const result = await readHeadFile(join(dir, name));
      if (!result.ok) {
        rows.push({ decisionId, adopted: !candidate, ok: false, code: result.code });
        continue;
      }
      const { head } = result;
      // Blocker computed ONCE; `beatsBaselines` derived from it (`headBeatsBaselines`
      // would re-validate the same metrics).
      const blocker = headAdoptionBlocker(head.metrics);
      rows.push({
        decisionId,
        adopted: !candidate,
        ok: true,
        architecture: head.architecture,
        metrics: head.metrics,
        corpusHash: head.corpusHash,
        corpusSources: head.corpusSources,
        trainedAt: head.trainedAt,
        baseRevision: head.baseModel.revision,
        compatible: isHeadCompatible(head, JEV_MODEL),
        beatsBaselines: blocker === null,
        blocker,
      });
    }
  }
  return { heads: rows };
}

/** Persist a freshly trained head as a CANDIDATE. Never adopts. */
export const saveCandidateJevHead = (decisionId, raw) => queueHeadWork(() => saveCandidate(decisionId, raw));

async function saveCandidate(decisionId, raw) {
  if (!JEV_DECISION_IDS.includes(decisionId)) return failure('jev-head-invalid');
  const parsed = parseJevHead(raw);
  if (!parsed.ok) return parsed;
  if (parsed.head.decisionId !== decisionId) return failure('jev-head-invalid');
  if (!isHeadCompatible(parsed.head, JEV_MODEL)) return failure('jev-head-revision-mismatch');
  await ensureDir(jevHeadsDir());
  await atomicWrite(headPath(decisionId, { candidate: true }), parsed.head);
  notifyJevChanged('heads');
  return { ok: true, head: parsed.head };
}

/**
 * Promote the candidate for `decisionId` into the adopted slot. THE GATE LIVES HERE: a head
 * that does not beat both the stock zero-shot classifier and the majority class on the
 * held-out gold set cannot be adopted through any surface; the refusal names the baseline.
 */
export const adoptJevHead = decisionId => queueHeadWork(() => adoptCandidate(decisionId));

async function adoptCandidate(decisionId) {
  if (!JEV_DECISION_IDS.includes(decisionId)) return failure('jev-head-invalid');
  const result = await readHeadFile(headPath(decisionId, { candidate: true }));
  if (!result.ok) return result;
  const { head } = result;
  if (!isHeadCompatible(head, JEV_MODEL)) return failure('jev-head-revision-mismatch');
  const blocker = headAdoptionBlocker(head.metrics);
  if (blocker) return failure(blocker);
  await ensureDir(jevHeadsDir());
  await atomicWrite(headPath(decisionId), head);
  // The candidate is consumed, not kept: a copy beside the adopted head would show the
  // same artifact twice in two states.
  await unlink(headPath(decisionId, { candidate: true })).catch(() => null);
  resetJevHeadCache();
  notifyJevChanged('heads');
  return { ok: true, head };
}

/**
 * Discard an artifact. Discarding the ADOPTED head returns the decision to the stock
 * zero-shot classifier, the state every install ships in.
 */
export const discardJevHead = (decisionId, options) => queueHeadWork(() => discardHead(decisionId, options));

async function discardHead(decisionId, { candidate = true } = {}) {
  if (!JEV_DECISION_IDS.includes(decisionId)) return failure('jev-head-invalid');
  const removed = await unlink(headPath(decisionId, { candidate })).then(() => true, () => false);
  resetJevHeadCache();
  if (removed) notifyJevChanged('heads');
  return { ok: true, removed };
}
