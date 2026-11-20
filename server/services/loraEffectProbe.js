/**
 * User-triggered LoRA adapter-effect diagnostic.
 *
 * Spawns `scripts/ml/lora_effect_probe.py` against one installed LoRA to answer whether
 * the adapter actually changes anything. See `server/lib/loraEffect.js` for the
 * verdict policy and `scripts/ml/lora_effect_probe.py` for the measurement.
 *
 * 1. **Never on a passive read.** `listLoras()` surfaces a CACHED report and never
 *    calls in here. The probe runs only from the explicit inspection route or from
 *    the render path about to spend GPU minutes on the adapter.
 *
 * 2. **Cached in the sidecar, keyed by probe version + file size + mtime.** Bumping
 *    the probe or rewriting the file re-measures. An `unmeasurable` result is NOT
 *    cached (it describes this machine's Python, not the adapter) with one exception:
 *    our own timeout, which describes the cost of reading this file on this storage
 *    (what the key already scopes); without caching a slow adapter re-burns the
 *    budget before every render.
 *
 * 3. **Never fatal.** Every PROBE failure (no interpreter, no numpy, spawn error,
 *    timeout, malformed output) resolves to an `unmeasurable` report. Two caller
 *    errors still throw: an unsafe filename, and a LoRA that isn't on disk (404).
 *    A render is refused only on a positive measurement of zero effect
 *    (`loraEffectIssue`).
 */

import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { createSingleFlight } from '../lib/singleFlight.js';
import { runSidecarProcess, parseSidecarResult } from '../lib/sidecarProcess.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { killWithEscalation } from '../lib/killWithEscalation.js';
import {
  LORA_EFFECT_PROBE_VERSION,
  LORA_EFFECT_STATUSES,
  normalizeLoraEffectReport,
  readCachedLoraEffectReport,
} from '../lib/loraEffect.js';
import { detectPython, NUMPY_PYTHON_RESOLVERS } from '../lib/pythonSetup.js';
import { LTX2_VENV_PYTHON, LTX25_VENV_PYTHON } from './videoGen/runtimes.js';
import { assertSafeLoraFilename, patchLoraSidecar, readSidecar } from './loras.js';

export const LORA_EFFECT_PROBE_SCRIPT = join(PATHS.root, 'scripts', 'ml', 'lora_effect_probe.py');

// The measurement is I/O-bound: the rank matrices are scattered through the file, so a
// cold-cache read touches most of it (a 12 GB LoRA took ~55s cold on a local SSD). The
// bound is sized to catch a wedged interpreter, NOT to cap a slow read: timing out a
// legitimate measurement would report 'unmeasurable' for the largest adapters, where a
// wasted render costs the most.
//
// It is a budget for the WHOLE candidate walk, not per interpreter: this runs inline
// ahead of a render, so N installed venvs must not multiply the stall.
export const LORA_EFFECT_PROBE_BUDGET_MS = 300_000;
const PROBE_TIMEOUT_MS = LORA_EFFECT_PROBE_BUDGET_MS;

const installedCandidates = (paths) => [
  ...new Set(paths.filter((p) => typeof p === 'string' && p && existsSync(p))),
];

// The probe needs only numpy, so it runs on whichever provisioned venv exists;
// NUMPY_PYTHON_RESOLVERS (lib/pythonSetup.js) owns that roster. The LTX-2.x video venvs
// go first because they actually fuse video LoRAs (paths in videoGen/runtimes.js).
//
// Ordered rather than single because a venv can exist without numpy; the probe reports
// that with a distinct exit code so the loop advances to the next interpreter.
const probeInterpreterCandidates = async () => {
  // `existsSync` here (rather than trusting the resolvers) keeps a spawn ENOENT
  // out of the common path; a resolver that already checked pays only a stat.
  const installed = installedCandidates([
    LTX2_VENV_PYTHON,
    LTX25_VENV_PYTHON,
    ...NUMPY_PYTHON_RESOLVERS.map((resolve) => resolve()),
  ]);
  // detectPython() is awaited ONLY when no provisioned venv exists: it execs every
  // system interpreter, wasted on a machine that has one of the venvs above.
  if (installed.length) return installed;
  return installedCandidates([await detectPython()]);
};

const timeoutReport = () => unmeasurable(
  `the effect probe ran out of its ${PROBE_TIMEOUT_MS / 1000}s budget reading this adapter`,
);

// Stamped with the CURRENT probe version because we are BUILDING this report: without
// the stamp it normalizes to version 0 and the freshness check rejects its own
// freshly-written value, silently defeating timeout caching. The shared normalizer
// deliberately does NOT infer this; an absent version in a SIDECAR stays untrusted.
const unmeasurable = (reason) => normalizeLoraEffectReport({
  probeVersion: LORA_EFFECT_PROBE_VERSION,
  status: LORA_EFFECT_STATUSES.UNMEASURABLE,
  reason,
});

// One measurement per file at a time: repeated clicks or a LoRA selected twice share one
// child rather than spawning a pile of interpreters against the same weights.
const inFlight = createSingleFlight();

// Returns `{ report, timedOut }`. `timedOut` stops the candidate walk: a timeout says the
// FILE is slow to read, so every interpreter would be equally slow. Every other failure
// is about this interpreter and is worth another candidate.
const runProbeOnce = async (bin, filePath, budgetMs) => {
  // try/catch is warranted despite the repo's no-try/catch rule: this runs outside the
  // Express lifecycle, and runSidecarProcess only models failures as resolutions; the
  // underlying `spawn` can still throw synchronously on a malformed argv. Letting that
  // escape would take down a render over a diagnostic. withAbortTimeout clears its timer
  // on both settle paths.
  let result;
  // runSidecarProcess's abort handler only SIGTERMs. A python child blocked in an
  // uninterruptible read (network or iCloud-backed volume) never reaches its signal
  // handler, so escalate to SIGKILL like every other runSidecarProcess caller.
  let child = null;
  // OUR timeout, specifically: `result.canceled` is set for ANY SIGTERM/SIGKILL death
  // (OOM kill, stray pkill, shutdown), and only our own budget expiring may be reported
  // and cached as a timeout, or an unrelated kill would permanently badge an adapter
  // "Not measurable".
  let didTimeout = false;
  try {
    result = await withAbortTimeout(budgetMs, (signal) => {
      signal.addEventListener('abort', () => {
        didTimeout = true;
        if (child) killWithEscalation(child, { label: 'LoRA effect probe', stillRunning: () => true });
      }, { once: true });
      return runSidecarProcess({
        bin,
        args: [LORA_EFFECT_PROBE_SCRIPT, filePath],
        signal,
        onProcess: (proc) => { child = proc; },
      });
    });
  } catch (err) {
    return { report: unmeasurable(`the effect probe could not be started (${err?.message || err})`) };
  }
  // The probe prints RESULT: even on a non-zero exit (missing numpy), so parse stdout
  // before judging the exit code.
  const parsed = parseSidecarResult(result.stdout);
  // `parsed` is whatever JSON.parse produced; a `RESULT:[1,2]` line is truthy but not a
  // report, and normalizeLoraEffectReport answers null for it.
  const report = parsed ? normalizeLoraEffectReport(parsed) : null;
  if (report) return { report };
  if (didTimeout) return { report: timeoutReport(), timedOut: true };
  if (result.canceled) {
    // Killed by something that isn't us — report it honestly and let the walk
    // try another interpreter; nothing about the adapter has been learned.
    return { report: unmeasurable(`the effect probe was killed (${result.reason || 'signal'})`) };
  }
  return { report: unmeasurable(`the effect probe produced no result (${result.reason || 'no output'})`) };
};

// The measurement proper, after the cache miss. Split out so the never-fatal guarantee
// is one `.catch` at the single call site below.
const measureLoraEffect = async (filename, filePath, { sizeBytes, mtimeMs, deadline }) => {
  const candidates = await probeInterpreterCandidates();
  if (!candidates.length) {
    return unmeasurable('no Python interpreter with numpy is installed — set up a Video Gen or Image Gen runtime first');
  }
  // A cold read of a multi-GB adapter takes real time (see PROBE_TIMEOUT_MS) and runs
  // inline ahead of a render; log it so the pause doesn't look like a hang.
  console.log(`🔬 Measuring LoRA effect for ${filename} (${Math.round(sizeBytes / 1e6)} MB)`);
  let last = null;
  let timedOut = false;
  for (const bin of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { timedOut = true; break; }
    const attempt = await runProbeOnce(bin, filePath, remaining);
    last = attempt.report;
    timedOut = attempt.timedOut === true;
    // Only an unmeasurable verdict is worth another interpreter; every other status is a
    // real answer about the file. A timeout stops the walk (see runProbeOnce).
    if (timedOut || last.status !== LORA_EFFECT_STATUSES.UNMEASURABLE) break;
  }
  // The budget can run out BETWEEN candidates, leaving `last` holding a previous
  // interpreter's verdict (possibly "numpy is not installed", never cacheable). Rebuild
  // the report from the timeout so what is stored describes what happened.
  if (timedOut) last = timeoutReport();
  if (last === null) last = timeoutReport();
  if (last.status === LORA_EFFECT_STATUSES.UNMEASURABLE) {
    console.log(`⚠️ LoRA effect probe unavailable for ${filename}: ${last.reason || 'unknown'}`);
    // A timeout is cached, unlike other unmeasurable verdicts (which describe this
    // machine's Python and may be fixed in a minute): it describes the cost of READING
    // THIS FILE on this storage, which the size+mtime key already scopes. Without it a
    // slow adapter re-burns the full budget ahead of every render.
    if (!timedOut) return last;
    // NOT named `timeoutReport`: that is a module-level helper, and shadowing it would
    // turn an earlier call to it in this block into a TDZ ReferenceError.
    const cachedTimeout = normalizeLoraEffectReport(last, { sizeBytes, mtimeMs, measuredAt: new Date().toISOString() });
    await patchLoraSidecar(filename, { effectReport: cachedTimeout }).catch(() => {});
    return cachedTimeout;
  }
  const report = normalizeLoraEffectReport(last, { sizeBytes, mtimeMs, measuredAt: new Date().toISOString() });
  console.log(`🔬 LoRA effect ${filename}: ${report.status} (${report.measured}/${report.modules} modules)`);
  // Best-effort cache — a sidecar we can't write is a slower diagnostic, not a
  // failed one.
  await patchLoraSidecar(filename, { effectReport: report }).catch((err) => {
    console.log(`⚠️ Could not cache LoRA effect report for ${filename}: ${err?.message || err}`);
  });
  return report;
};

/**
 * Measure one installed LoRA's adapter effect.
 *
 * Returns a normalized report (never throws for a probe failure; see the module
 * header). `force: true` re-measures even when a fresh cached report exists.
 *
 * `deadline` (epoch ms) lets a caller measuring SEVERAL adapters share one budget, so a
 * 4-LoRA render cannot stall for four full budgets back to back.
 */
export const probeLoraEffect = async (filename, { force = false, deadline = null } = {}) => {
  assertSafeLoraFilename(filename);
  const filePath = join(PATHS.loras, filename);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    // NOT a soft `unmeasurable`: that word means "this machine could not run the probe".
    // A missing file is a caller-visible 404 as for getLora/patch/delete, outside the
    // never-fatal contract like the filename assertion above.
    throw new ServerError(`LoRA not found: ${filename}`, { status: 404, code: 'NOT_FOUND' });
  }
  // The cache key: both stamps come from the stat we already did, so verifying a
  // stored report costs nothing and a same-size rewrite still invalidates it.
  const stamps = { sizeBytes: fileStat.size, mtimeMs: fileStat.mtimeMs };

  if (!force) {
    const cached = readCachedLoraEffectReport((await readSidecar(filename))?.effectReport, stamps);
    if (cached) return cached;
  }

  // The one catch that makes "never fatal" true downstream of the cache check.
  // `assertSafeLoraFilename` above is deliberately OUTSIDE it: a path-traversal attempt
  // is a caller bug that must surface as a 400.
  // A caller-supplied deadline can only SHORTEN the budget, never extend it.
  const ownDeadline = Date.now() + PROBE_TIMEOUT_MS;
  const effectiveDeadline = deadline == null ? ownDeadline : Math.min(deadline, ownDeadline);

  return inFlight.run(filePath, () => measureLoraEffect(filename, filePath, { ...stamps, deadline: effectiveDeadline })
    .catch((err) => {
      console.log(`⚠️ LoRA effect probe failed for ${filename}: ${err?.message || err}`);
      return unmeasurable(`the effect probe failed unexpectedly (${err?.message || err})`);
    }));
};
