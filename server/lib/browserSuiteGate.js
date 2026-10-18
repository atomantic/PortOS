import { spawn } from './childProcess.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Keep cross-workspace browser suites as visible skips on machines without
 * Chrome, ffmpeg or the client workspace, while letting the one CI job that
 * provisions them fail fast instead of passing green on a skip.
 *
 * `prerequisites` maps a human label to whatever was discovered (a path, a
 * resolved bundler list, or undefined/null when absent; `chromeWithH264` may
 * also report `{ probeFailure }` for a probe that ran and failed). `onUnavailable` runs
 * before the skip or the throw: prerequisite discovery can initialize mocked
 * path fixtures, and Vitest runs no cleanup hooks for a skipped (or failed) file.
 */
export function browserSuiteCanRun(label, prerequisites, { onUnavailable } = {}) {
  const entries = Object.entries(prerequisites);
  // A probe that ran but failed is a distinct verdict from an absent prerequisite.
  const failed = entries.filter(([, found]) => found?.probeFailure);
  const missing = entries.filter(([, found]) => !found).map(([name]) => name);
  if (missing.length === 0 && failed.length === 0) return true;

  onUnavailable?.();
  const reason = [
    ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
    ...failed.map(([name, found]) => `${name} probe failed (${found.probeFailure})`),
  ].join('; ');
  if (process.env.PORTOS_REQUIRE_BROWSER_SUITES) {
    throw new Error(`${label}: browser suite skipped but PORTOS_REQUIRE_BROWSER_SUITES is set — ${reason}`);
  }

  console.log(`⏭️ ${label}: skipping suite — ${reason}`);
  return false;
}

const H264_PROBE_PAGE = `data:text/html,<body><script>document.body.textContent='H264:'+document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"')</script></body>`;

// Kept free of bufferedSpawn.js on purpose: this module is imported ahead of
// `vi.mock('./paths.js')` factories, and that import graph reaches paths.js.
const IS_WIN32 = process.platform === 'win32';
const MAX_OUTPUT_BYTES = 64 * 1024;

// Signals the probe's whole process group (it was spawned detached) so Chrome's
// helper processes go with it; Windows takes the tree down with taskkill.
function killProbeTree(child, signal, processGroup) {
  if (IS_WIN32 && child.pid) {
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }).on('error', () => {}).unref();
    return;
  }
  if (processGroup && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* group already gone */ }
  }
  child.kill(signal);
}

const PROBE_TIMEOUT_MS = 20000;
const PROBE_KILL_GRACE_MS = 5000;

// Runs the probe as an owned child: its own process group on POSIX, a bounded
// deadline, and a SIGTERM -> SIGKILL ladder that waits for `close` so the
// outcome says whether cleanup was actually observed. stderr is discarded, so
// no raw browser output (paths, PIDs) can reach a caller.
function runOwnedProbe(file, args, { timeoutMs, graceMs }) {
  return new Promise((resolve) => {
    const processGroup = !IS_WIN32;
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: processGroup });
    const timers = [];
    let stdout = '';
    let timedOut = false;
    let settled = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      // Reap renderer/GPU helpers a slow-exiting Chrome may have left behind.
      killProbeTree(child, 'SIGKILL', processGroup);
      child.stdout?.destroy();
      resolve({ stdout, timedOut, ...outcome });
    };

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-MAX_OUTPUT_BYTES);
    });
    child.on('error', (error) => finish({ spawnErrorCode: error.code ?? 'UNKNOWN', cleanupVerified: true }));
    child.on('close', (code, signal) => finish({ code, signal, cleanupVerified: true }));

    timers.push(setTimeout(() => {
      timedOut = true;
      killProbeTree(child, 'SIGTERM', processGroup);
      timers.push(setTimeout(() => {
        killProbeTree(child, 'SIGKILL', processGroup);
        timers.push(setTimeout(() => finish({ cleanupVerified: false }), graceMs));
      }, graceMs));
    }, timeoutMs));
  });
}

/**
 * Probes whether a Chrome binary can decode H.264 and says why when it cannot.
 * Resolves `{ ok: true, chromePath }` or `{ ok: false, cause, ... }` with cause:
 * - `missing-executable` — no path, or the file does not exist
 * - `codec-unavailable` — Chrome answered cleanly and reported no H.264
 * - `probe-timeout` — no exit within the deadline (`cleanupVerified` says whether
 *   the child was observed to close after the kill ladder)
 * - `teardown-failed` — Chrome answered but then exited nonzero or by signal;
 *   the codec answer is NOT trusted from a probe that did not shut down cleanly
 * - `no-answer` — Chrome did not report a codec verdict at all
 * Never rejects; the profile directory is removed once the child is settled.
 */
export async function probeChromeH264(chromePath, { timeoutMs = PROBE_TIMEOUT_MS, graceMs = PROBE_KILL_GRACE_MS } = {}) {
  if (!chromePath) return { ok: false, cause: 'missing-executable' };
  const profile = mkdtempSync(join(tmpdir(), 'portos-h264-probe-'));
  try {
    const run = await runOwnedProbe(chromePath, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update',
      '--disable-sync', '--disable-breakpad',
      '--password-store=basic', '--use-mock-keychain',
      `--user-data-dir=${profile}`, '--virtual-time-budget=2000', '--dump-dom', H264_PROBE_PAGE,
    ], { timeoutMs, graceMs });
    if (run.spawnErrorCode) {
      return { ok: false, cause: ['ENOENT', 'ENOTDIR'].includes(run.spawnErrorCode) ? 'missing-executable' : 'no-answer' };
    }
    if (run.timedOut) return { ok: false, cause: 'probe-timeout', timeoutMs, cleanupVerified: run.cleanupVerified };
    const answer = /H264:(\w*)/.exec(run.stdout);
    if (run.code !== 0) {
      return { ok: false, cause: answer ? 'teardown-failed' : 'no-answer', exit: run.code ?? run.signal };
    }
    if (!answer) return { ok: false, cause: 'no-answer', exit: 0 };
    return answer[1] ? { ok: true, chromePath } : { ok: false, cause: 'codec-unavailable' };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

/** One-line, path/PID-free description of a failed `probeChromeH264` result. */
export function describeH264Probe({ cause, exit, timeoutMs, cleanupVerified }) {
  switch (cause) {
    case 'missing-executable': return 'Chrome executable not found';
    case 'codec-unavailable': return 'Chrome reports no H.264 decode support';
    case 'probe-timeout':
      return `Chrome H.264 probe timed out after ${Math.round(timeoutMs / 1000)}s; child cleanup ${cleanupVerified ? 'verified' : 'unverified'}`;
    case 'teardown-failed':
      return `Chrome answered the H.264 probe but then failed to shut down cleanly (exit ${exit}); a browser lifecycle failure, not a missing codec`;
    default: return `Chrome H.264 probe produced no codec answer${exit === undefined ? '' : ` (exit ${exit})`}`;
  }
}

/**
 * Whether a Chrome binary can decode H.264 (Playwright's bundled Chromium has
 * no proprietary codecs). Resolves the binary path when it can, null when the
 * executable or the codec is genuinely absent — so it drops straight into a
 * `browserSuiteCanRun` prerequisite map — and `{ probeFailure }` when the probe
 * itself failed, which `browserSuiteCanRun` reports as a lifecycle failure
 * rather than a missing prerequisite.
 */
export async function chromeWithH264(chromePath, options) {
  const result = await probeChromeH264(chromePath, options);
  if (result.ok) return result.chromePath;
  if (result.cause === 'missing-executable' || result.cause === 'codec-unavailable') return null;
  return { probeFailure: result.cause === 'probe-timeout' && !result.cleanupVerified
    ? 'probe-timeout, cleanup unverified' : result.cause };
}
