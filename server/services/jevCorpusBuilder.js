/**
 * Build a weakly-labelled training corpus from one checkout's own forge history.
 *
 * The signal this install already has, and what each piece is worth:
 *
 *   merged PR on the default branch   → the maintainer wanted it  → `aligned`
 *   closed-unmerged PR                → they did not              → `unrelated`
 *   issue closed `not planned`        → they did not              → `unrelated`
 *   issue labelled `future`/`needs-input` → parked, not refused    → `unrelated`
 *
 * Every one of those is WEAK. A merged pull request is evidence the maintainer
 * wanted it, not an annotation that it advances the specific clause the
 * retriever paired it with. Nothing here pretends otherwise — the held-out
 * split, the two baselines and the strictly-better adoption gate in
 * `lib/jevHead.js` exist precisely because these labels cannot be trusted on
 * their own.
 *
 * ## Two sources that are deliberately NOT here
 *
 * **The #7642 shadow counters.** `recordJevObservations` records counts only —
 * decision id, bucket, agreement flag, never a premise. That is exactly what
 * makes shadow mode safe to leave on, and it also means the counters contain no
 * labelled example and never will. They are carried on the manifest as a
 * readiness signal an operator can read beside the corpus, not folded in as
 * rows.
 *
 * **`messageTriageRules.js`.** Those corrections are email-sender keyed and
 * belong to the `message-triage` decision, whose cutover the issue that
 * introduced this module puts out of scope. The builder is decision-generic so
 * that caller can be added without reshaping anything; only the forge sources
 * ship wired.
 *
 * ## Privacy
 *
 * A corpus is this install's private repository history, rendered as premises.
 * It is written under `data/jev/corpora/`, is machine-local, and never crosses
 * the federation layer — see `services/jevHeads.js` and the ADR
 * [privacy records machine-local](../../docs/decisions/2026-08-08-privacy-records-machine-local.md).
 * Nothing here contacts a provider: the forge queries are `gh` reads against
 * the operator's own repository.
 */

import { promisify } from 'util';
import { join } from 'path';
import { execFile } from '../lib/childProcess.js';
import { atomicWrite, ensureDir, safeJSONParse } from '../lib/fileUtils.js';
import {
  assertSplitDisjoint,
  buildCorpusExample,
  corpusHash,
  JEV_CORPUS_MIN_EXAMPLES,
  JEV_CORPUS_SCHEMA_VERSION,
  majorityClassAccuracy,
  splitCorpus,
  summarizeCorpusSources,
  toCorpusJsonl,
} from '../lib/jevCorpus.js';
import { getJevDecision, jevHypotheses } from '../lib/jevDecisions.js';
import {
  composeAdherencePremise,
  formatChangeEvidence,
  SCOPE_ADHERENCE_DECISION_ID,
  SCOPE_ADHERENCE_TOP_K,
  selectCandidateClauses,
} from '../lib/scopeAdherence.js';
import { jevCorporaDir } from './jevHeads.js';

const execFileAsync = promisify(execFile);
const FORGE_TIMEOUT_MS = 60_000;
// One `gh` page per query. Large enough that a busy repository yields a usable
// corpus in four reads, bounded so a decade-old repository cannot turn a
// button press into a multi-minute paginated crawl.
const FORGE_PAGE_LIMIT = 300;
const failure = (code) => ({ ok: false, code });

/**
 * Run one `gh` read.
 *
 * Fixed argv, never a shell string: every value that varies is a separate
 * argument, so nothing a forge returns can become a command. Returns null on
 * any failure — a repository with no `gh`, no auth, or no network is a corpus
 * that cannot be built, which the caller reports as one code.
 */
async function ghJson(args, { cwd, env }) {
  const result = await execFileAsync('gh', args, {
    cwd,
    env: env || process.env,
    timeout: FORGE_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  }).catch(() => null);
  if (!result) return null;
  const parsed = safeJSONParse(result.stdout, null, { allowArray: true, logError: false });
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * The forge rows this corpus draws from, each already carrying its weak verdict.
 *
 * `--search` narrows on the SERVER. A client-side filter over a fetched page
 * would silently drop the older half of a busy repository's history, which is
 * the half a young corpus most needs.
 */
async function fetchForgeRows({ cwd, env }) {
  const [merged, closedPrs, notPlanned, parked] = await Promise.all([
    ghJson(['pr', 'list', '--state', 'merged', '--limit', String(FORGE_PAGE_LIMIT),
      '--json', 'number,title,body'], { cwd, env }),
    ghJson(['pr', 'list', '--state', 'closed', '--limit', String(FORGE_PAGE_LIMIT),
      '--json', 'number,title,body,mergedAt'], { cwd, env }),
    ghJson(['issue', 'list', '--state', 'closed', '--search', 'reason:"not planned"',
      '--limit', String(FORGE_PAGE_LIMIT), '--json', 'number,title,body'], { cwd, env }),
    ghJson(['issue', 'list', '--state', 'open', '--label', 'future',
      '--limit', String(FORGE_PAGE_LIMIT), '--json', 'number,title,body'], { cwd, env }),
  ]);
  // Every query failing means the forge is unreachable. One failing on a
  // repository that simply has no such rows is an empty list, which is fine —
  // `null` and `[]` are kept apart for exactly this reason.
  if ([merged, closedPrs, notPlanned, parked].every((rows) => rows === null)) return null;

  const rows = [];
  for (const row of merged || []) rows.push({ ...row, kind: 'pr', source: 'merged-pr', verdict: 'aligned' });
  // `gh pr list --state closed` includes merged ones; the merged query already
  // claimed those, and a PR counted as both evidence for and against would be
  // pure noise with a label on it.
  for (const row of closedPrs || []) {
    if (row?.mergedAt) continue;
    rows.push({ ...row, kind: 'pr', source: 'closed-unmerged-pr', verdict: 'unrelated' });
  }
  for (const row of notPlanned || []) rows.push({ ...row, kind: 'issue', source: 'closed-not-planned-issue', verdict: 'unrelated' });
  for (const row of parked || []) rows.push({ ...row, kind: 'issue', source: 'parked-issue', verdict: 'unrelated' });
  return rows;
}

/**
 * Turn forge rows into Route A examples against the repository's own clauses.
 *
 * The premise is composed by the SAME helpers inference uses
 * (`formatChangeEvidence` + `composeAdherencePremise`), and the retriever picks
 * the clauses the same way. A corpus built with different wording would train a
 * head on questions the scorer is never asked.
 */
function toExamples({ rows, clauses, index, options, verdicts, topK }) {
  const examples = [];
  for (const row of rows) {
    const change = {
      kind: row.kind,
      title: String(row.title || '').trim(),
      body: String(row.body || '').trim(),
      diffSummary: '',
    };
    if (!change.title && !change.body) continue;
    const evidence = formatChangeEvidence(change);
    for (const clause of selectCandidateClauses(clauses, change, { k: topK, index })) {
      const context = composeAdherencePremise({ clause, evidence });
      if (!context) continue;
      const example = buildCorpusExample({
        context,
        options,
        chosen: verdicts[row.verdict],
        source: row.source,
      });
      if (example) examples.push(example);
    }
  }
  return examples;
}

/**
 * Build, split and persist a corpus for `scope-adherence`.
 *
 * Returns the manifest — counts, hashes, per-source balance and the majority
 * baseline — never a single example. The corpus itself is on disk; what a
 * caller and the panel get back is a description of it.
 *
 * @param {object} options
 * @param {string} options.repoPath Checkout holding `PRD.md` / `GOALS.md` and the forge remote.
 * @param {object} [options.env] Environment for the `gh` reads (a resolved forge token overlay).
 */
export async function buildScopeAdherenceCorpus({ repoPath, env = null, topK = SCOPE_ADHERENCE_TOP_K } = {}) {
  if (typeof repoPath !== 'string' || !repoPath.trim()) return failure('jev-corpus-no-clauses');

  // Deferred: the scope-adherence service reaches the untrusted-content ladder
  // and, through it, the sidecar lifecycle. Corpus building needs only its
  // clause parser (`server/lib/importScoping.test.js`).
  const { loadClauseCorpus } = await import('./scopeAdherence.js');
  const corpus = await loadClauseCorpus(repoPath);
  if (!corpus.ok) return failure('jev-corpus-no-clauses');

  const rows = await fetchForgeRows({ cwd: repoPath, env });
  if (rows === null) return failure('jev-corpus-forge-unavailable');

  const options = jevHypotheses(SCOPE_ADHERENCE_DECISION_ID);
  // The hypothesis each weak verdict stands for, resolved from the registry
  // rather than restated: a re-worded hypothesis must move the corpus with it,
  // or a head trained today would be scored against a different question
  // tomorrow.
  const decisionOptions = getJevDecision(SCOPE_ADHERENCE_DECISION_ID).options;
  const verdicts = Object.fromEntries(decisionOptions.map((option) => [option.value, option.hypothesis]));

  const examples = toExamples({ rows, clauses: corpus.clauses, index: corpus.index, options, verdicts, topK });
  const { train, gold } = splitCorpus(examples);
  // THE REFUSAL. A gold set sharing rows with the training split reports a
  // score that is partly memorization, and that score is the only evidence the
  // adoption gate reads — so this is a hard stop before anything is written,
  // not a warning beside a corpus somebody might still train on.
  //
  // The total-size floor is checked FIRST, so a young repository is told it has
  // no history to learn from rather than being handed the narrower "gold set
  // too small" — which describes a split problem it cannot act on.
  if (train.length + gold.length < JEV_CORPUS_MIN_EXAMPLES) return failure('jev-corpus-too-small');
  const split = assertSplitDisjoint({ train, gold });
  if (!split.ok) return failure(split.code);

  const hash = corpusHash([...train, ...gold]);
  const dir = join(jevCorporaDir(), `${SCOPE_ADHERENCE_DECISION_ID}-${hash}`);
  await ensureDir(dir);
  // Strings, so `atomicWrite` passes them through unchanged rather than
  // re-encoding them as a JSON document.
  await atomicWrite(join(dir, 'train.jsonl'), toCorpusJsonl(train));
  await atomicWrite(join(dir, 'gold.jsonl'), toCorpusJsonl(gold));

  const manifest = {
    schemaVersion: JEV_CORPUS_SCHEMA_VERSION,
    decisionId: SCOPE_ADHERENCE_DECISION_ID,
    corpusHash: hash,
    trainSize: train.length,
    goldSize: gold.length,
    majorityClass: majorityClassAccuracy(gold),
    sources: summarizeCorpusSources([...train, ...gold]),
    // The exact reads that produced it, so a corpus can be rebuilt — or
    // disputed — without reading this file's source.
    queries: [
      'gh pr list --state merged',
      'gh pr list --state closed (unmerged only)',
      'gh issue list --state closed --search reason:"not planned"',
      'gh issue list --state open --label future',
    ],
    // Counts only, and only for context: the shadow counters carry no premise,
    // so they inform whether this decision has been measured at all — never a
    // training row.
    shadow: await readShadowContext(),
    builtAt: new Date().toISOString(),
  };
  await atomicWrite(join(dir, 'manifest.json'), manifest);
  return { ok: true, ...manifest, corpusDir: dir };
}

async function readShadowContext() {
  const { readJevDecisionStats } = await import('./jevRouter.js');
  const stats = await readJevDecisionStats().catch(() => null);
  const row = stats?.decisions?.find((entry) => entry.decisionId === SCOPE_ADHERENCE_DECISION_ID);
  if (!row) return { observed: 0, compared: 0, agreementRate: null };
  return { observed: row.observed, compared: row.compared, agreementRate: row.agreementRate };
}
