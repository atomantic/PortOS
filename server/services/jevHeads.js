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

import { readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, ensureDir, PATHS, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { JEV_MODEL } from '../lib/jev.js';
import { JEV_DECISION_IDS } from '../lib/jevDecisions.js';
import { headAdoptionBlocker, headBeatsBaselines, isHeadCompatible, parseJevHead } from '../lib/jevHead.js';

/** The one directory every jev artifact lives under. Machine-local, always. */
export const jevDataDir = () => join(PATHS.data, 'jev');
export const jevHeadsDir = () => join(jevDataDir(), 'heads');
export const jevCorporaDir = () => join(jevDataDir(), 'corpora');
export const jevEmbeddingsDir = () => join(jevDataDir(), 'embeddings');

const failure = (code) => ({ ok: false, code });

const headPath = (decisionId, { candidate = false } = {}) => join(
  jevHeadsDir(),
  `${decisionId}${candidate ? '.candidate' : ''}.json`,
);

/**
 * Adopted heads by decision id, so a per-clause scoring loop does not re-read
 * and re-validate the same file on every forward pass. Invalidated by every
 * write path in this module, and by the test seam below.
 */
let adoptedCache = null;

/** Test seam, mirroring the cache resets on the sibling local-model services. */
export const resetJevHeadCache = () => { adoptedCache = null; };

async function readHeadFile(path) {
  const content = await tryReadFile(path);
  if (content === null) return failure('jev-head-not-found');
  const parsed = safeJSONParse(content, null, { allowArray: false, logError: false });
  if (parsed === null) return failure('jev-head-unreadable');
  return parseJevHead(parsed);
}

/**
 * The head `decisionId` is currently scored with, or null.
 *
 * Returns null — never a failure — for every reason a head might not apply:
 * none adopted, an unreadable file, a head fit on a different encoder
 * revision. Scoring falls back to the stock zero-shot classifier in all three
 * cases, because that is what the install did before any head existed and it
 * is always correct. An operator who wants to know WHY sees it in the panel,
 * which calls `describeJevHeads` instead.
 */
export async function getAdoptedJevHead(decisionId) {
  if (!JEV_DECISION_IDS.includes(decisionId)) return null;
  if (adoptedCache?.has(decisionId)) return adoptedCache.get(decisionId);
  const result = await readHeadFile(headPath(decisionId));
  const head = result.ok && isHeadCompatible(result.head, JEV_MODEL) ? result.head : null;
  adoptedCache ??= new Map();
  adoptedCache.set(decisionId, head);
  return head;
}

/**
 * Operator-facing state for every decision that has an artifact on disk.
 *
 * Reports the metrics and the adoption blocker, never a corpus row, a premise
 * or a path. `compatible: false` is stated rather than silently hidden: a head
 * that stopped applying because the pinned model revision moved is a fact the
 * operator needs, not an absence.
 */
export async function describeJevHeads() {
  const dir = jevHeadsDir();
  const entries = await readdir(dir).catch(() => []);
  const rows = [];
  for (const decisionId of JEV_DECISION_IDS) {
    for (const candidate of [false, true]) {
      const name = `${decisionId}${candidate ? '.candidate' : ''}.json`;
      if (!entries.includes(name)) continue;
      const result = await readHeadFile(join(dir, name));
      if (!result.ok) {
        rows.push({ decisionId, adopted: !candidate, ok: false, code: result.code });
        continue;
      }
      const { head } = result;
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
        beatsBaselines: headBeatsBaselines(head.metrics),
        blocker: headAdoptionBlocker(head.metrics),
      });
    }
  }
  return { heads: rows };
}

/** Persist a freshly trained head as a CANDIDATE. Never adopts. */
export async function saveCandidateJevHead(decisionId, raw) {
  if (!JEV_DECISION_IDS.includes(decisionId)) return failure('jev-head-invalid');
  const parsed = parseJevHead(raw);
  if (!parsed.ok) return parsed;
  if (parsed.head.decisionId !== decisionId) return failure('jev-head-invalid');
  if (!isHeadCompatible(parsed.head, JEV_MODEL)) return failure('jev-head-revision-mismatch');
  await ensureDir(jevHeadsDir());
  await atomicWrite(headPath(decisionId, { candidate: true }), parsed.head);
  return { ok: true, head: parsed.head };
}

/**
 * Promote the candidate for `decisionId` into the adopted slot.
 *
 * THE GATE LIVES HERE. A head that does not beat both the stock zero-shot
 * classifier and the majority class on the held-out gold set cannot be adopted
 * through any surface, and the refusal names which baseline it lost to.
 */
export async function adoptJevHead(decisionId) {
  if (!JEV_DECISION_IDS.includes(decisionId)) return failure('jev-head-invalid');
  const result = await readHeadFile(headPath(decisionId, { candidate: true }));
  if (!result.ok) return result;
  const { head } = result;
  if (!isHeadCompatible(head, JEV_MODEL)) return failure('jev-head-revision-mismatch');
  const blocker = headAdoptionBlocker(head.metrics);
  if (blocker) return failure(blocker);
  await ensureDir(jevHeadsDir());
  await atomicWrite(headPath(decisionId), head);
  // The candidate is consumed, not kept: leaving a byte-identical copy beside
  // the adopted head would make the panel show the same artifact twice, in two
  // states, with no way to tell which one is answering.
  await unlink(headPath(decisionId, { candidate: true })).catch(() => null);
  resetJevHeadCache();
  return { ok: true, head };
}

/**
 * Discard an artifact.
 *
 * Discarding the ADOPTED head returns the decision to the stock zero-shot
 * classifier immediately — which is the state every install ships in, so there
 * is nothing to restore and nothing to warn about.
 */
export async function discardJevHead(decisionId, { candidate = true } = {}) {
  if (!JEV_DECISION_IDS.includes(decisionId)) return failure('jev-head-invalid');
  const removed = await unlink(headPath(decisionId, { candidate })).then(() => true, () => false);
  resetJevHeadCache();
  return { ok: true, removed };
}
