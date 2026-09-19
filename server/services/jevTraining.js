/**
 * Run one project-head training job, entirely on this machine.
 *
 *     buildScopeAdherenceCorpus()   ← forge reads + the operator's own clauses
 *       ↓ train.jsonl / gold.jsonl, split disjointness already REFUSED on overlap
 *     scripts/train_jev_head.py     ← venv-jev, frozen encoder, offline
 *       ↓ candidate head + three gold scores
 *     saveCandidateJevHead()        ← a CANDIDATE. Never adopted here.
 *
 * Three properties this module exists to hold:
 *
 *  1. **No provider call and no second download.** The trainer runs in the
 *     dedicated `venv-jev` under the same hardened environment the sidecar gets
 *     — `HF_HUB_OFFLINE=1`, no API keys, no forge token, no PYTHONPATH — over
 *     the snapshot that is already on disk. The one network-touching step is
 *     the corpus build's `gh` reads, which happen before Python starts and get
 *     an environment of their own.
 *  2. **Training never promotes.** The run ends with a candidate and three
 *     numbers. `adoptJevHead` is a separate operator action, and it refuses a
 *     head that does not beat both baselines.
 *  3. **One run at a time.** A 4B encoder is loaded twice over if two runs
 *     overlap, on a machine that may already be holding the sidecar's copy
 *     resident — so a second request joins the first rather than starting one.
 */

import { promisify } from 'util';
import { dirname, join } from 'path';
import { execFile } from '../lib/childProcess.js';
import { PATHS, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { findCachedRepoFiles } from '../lib/hfCache.js';
import { JEV_MODEL, JEV_REQUIRED_FILES } from '../lib/jev.js';
import { jevDecisionEmbeddingsDir } from '../lib/jevPaths.js';
import { SCOPE_ADHERENCE_DECISION_ID } from '../lib/scopeAdherence.js';
import { saveCandidateJevHead } from './jevHeads.js';

// Deferred into `runTraining`, not imported at module scope: `./jev.js` carries
// the whole sidecar lifecycle (the pinned model contract, the venv installer,
// the HF cache and download stack) and `./jevCorpusBuilder.js` carries the forge
// reads. An install that never trains a head must not pay for either in its
// static import closure (`server/lib/importScoping.test.js`), and a training run
// pays a single dynamic hop against a job measured in minutes. Vitest's mock
// registry covers dynamic imports, so the suites that double these still do.
//
// What the deferral must NOT lose: the trainer runs under the SAME interpreter
// AND the SAME hardened spawn options the sidecar runs under, resolved as ONE
// value from the module that owns both. Recomposing either here is how the
// "offline, no provider call" guarantee drifts from the process it describes.
const jevLifecycle = () => import('./jev.js');
const corpusBuilder = () => import('./jevCorpusBuilder.js');

const execFileAsync = promisify(execFile);
const TRAINER_SCRIPT = join(PATHS.root, 'scripts', 'train_jev_head.py');
// Generous: the dominant cost is one forward pass per (clause, change) pair on
// a cold cache, which on a CPU-only host is minutes. A warm cache is seconds.
const TRAIN_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TRAINER_OUTPUT = 64 * 1024 * 1024;

const failure = (code, extra = {}) => ({ ok: false, code, ...extra });

let trainingInFlight = null;

/** Whether a training run is currently occupying the machine. */
export const isJevTrainingRunning = () => trainingInFlight !== null;

/**
 * Train a candidate head for `scope-adherence` against one checkout.
 *
 * `repoPath` defaults to THIS install's own checkout and has no route-level
 * override: a project head learns the product the operator is actually running,
 * and a caller-supplied path would turn a training button into an
 * arbitrary-directory reader with a forge token beside it — the same reasoning
 * that keeps `repoPath` out of `scopeAdherenceRequestSchema`.
 *
 * @param {object} [options]
 * @param {string} [options.repoPath] Checkout holding `PRD.md` / `GOALS.md` and the forge remote.
 * @param {'linear'|'mlp1'} [options.architecture]
 * @returns {Promise<{ok: true, metrics: object, corpus: object} | {ok: false, code: string}>}
 */
export function trainScopeAdherenceHead({ repoPath = PATHS.root, architecture = 'linear' } = {}) {
  // Single in-flight run, cleared in `finally` so one failure does not pin
  // every later request to the same rejection.
  if (trainingInFlight) return trainingInFlight;
  trainingInFlight = runTraining({ repoPath, architecture })
    .finally(() => { trainingInFlight = null; });
  return trainingInFlight;
}

async function runTraining({ repoPath, architecture }) {
  const { getJevStatus, jevVenvSpawnTarget } = await jevLifecycle();
  const status = await getJevStatus();
  // The trainer loads the same snapshot through the same venv the sidecar
  // uses. An install that has not finished the scorer install cannot train,
  // and saying so is more useful than a Python import error.
  if (!status.ready) return failure('jev-head-runtime-unavailable');

  const files = await findCachedRepoFiles(JEV_MODEL.repository, JEV_REQUIRED_FILES, { revision: JEV_MODEL.revision });
  if (!files?.[0]) return failure('jev-head-runtime-unavailable');
  const modelDir = dirname(files[0]);
  const target = jevVenvSpawnTarget({ timeout: TRAIN_TIMEOUT_MS, maxBuffer: MAX_TRAINER_OUTPUT });
  if (!target) return failure('jev-head-runtime-unavailable');

  // The forge token overlay for the corpus reads, and ONLY for those: the
  // trainer below gets `buildJevEnv`, which carries no credential at all.
  // Deferred because `forgeAuth.js` reaches the git/forge stack this module has
  // no other use for.
  const { resolveForgeForRepo } = await import('./forgeAuth.js');
  const forge = await resolveForgeForRepo(repoPath).catch(() => null);
  const { buildScopeAdherenceCorpus } = await corpusBuilder();
  const corpus = await buildScopeAdherenceCorpus({ repoPath, env: forge?.env || null });
  if (!corpus.ok) return corpus;

  const outPath = join(corpus.corpusDir, 'head.json');
  const args = [
    TRAINER_SCRIPT,
    '--model-dir', modelDir,
    '--corpus', join(corpus.corpusDir, 'train.jsonl'),
    '--gold', join(corpus.corpusDir, 'gold.jsonl'),
    '--out', outPath,
    // Per-decision, so the trainer can prune the keys this run did not use
    // without deleting a cache another decision depends on. A flat shared pool
    // would make that prune unsafe, and the cache therefore unbounded.
    '--cache-dir', jevDecisionEmbeddingsDir(SCOPE_ADHERENCE_DECISION_ID),
    '--decision-id', SCOPE_ADHERENCE_DECISION_ID,
    '--model-id', JEV_MODEL.id,
    '--repository', JEV_MODEL.repository,
    '--revision', JEV_MODEL.revision,
    '--corpus-hash', corpus.corpusHash,
    '--corpus-sources', Object.keys(corpus.sources).filter((key) => corpus.sources[key] > 0).join(','),
    '--architecture', architecture,
  ];

  // `target.options` carries the hardened environment the sidecar runs under:
  // no API keys, no forge token, no MCP or provider variables, no arbitrary
  // PYTHONPATH, and `HF_HUB_OFFLINE=1` so a missing file fails rather than
  // downloading. The forge token that built the corpus is deliberately not in
  // scope here.
  const result = await execFileAsync(target.pythonPath, args, target.options)
    .catch((error) => ({ failed: true, stdout: error?.stdout || '' }));

  // The trainer writes exactly one JSON line to stdout, so the report is the
  // last line whether or not the process exited cleanly — a failing run still
  // names its own code rather than collapsing into "training failed".
  const report = safeJSONParse(String(result.stdout || '').trim().split('\n').pop(), null, { allowArray: false, logError: false });
  if (!report?.ok) return failure(report?.code || 'jev-head-training-failed');

  const written = await tryReadFile(outPath);
  const head = written === null ? null : safeJSONParse(written, null, { allowArray: false, logError: false });
  if (!head) return failure('jev-head-training-failed');

  // Both sides compute the majority-class baseline — Node over the gold rows it
  // wrote (`majorityClassAccuracy`), Python over the gold rows it read — and
  // the gate reads the Python one. A disagreement means the two are not looking
  // at the same gold set, which would make the adoption evidence meaningless,
  // so it fails the run rather than shipping a head scored against an unknown.
  if (!Number.isFinite(head.metrics?.majorityClass)
    || Math.abs(head.metrics.majorityClass - corpus.majorityClass) > 1e-9) {
    return failure('jev-head-training-failed');
  }

  const saved = await saveCandidateJevHead(SCOPE_ADHERENCE_DECISION_ID, head);
  if (!saved.ok) return saved;
  return {
    ok: true,
    decisionId: SCOPE_ADHERENCE_DECISION_ID,
    metrics: saved.head.metrics,
    architecture: saved.head.architecture,
    corpus: {
      corpusHash: corpus.corpusHash,
      trainSize: corpus.trainSize,
      goldSize: corpus.goldSize,
      sources: corpus.sources,
      shadow: corpus.shadow,
    },
  };
}

