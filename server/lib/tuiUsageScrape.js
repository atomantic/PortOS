import { spawn as ptySpawn } from 'node-pty';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { stripAnsi } from './ansiStrip.js';
import { sleep } from './fileUtils.js';

/**
 * Drive an interactive coding-agent TUI (Antigravity `agy`, Grok Build `grok`)
 * in a throwaway PTY, type a slash command, and return the ANSI-stripped screen
 * text so a caller can parse it.
 *
 * Why this exists: some CLIs expose subscription-quota usage ONLY through an
 * interactive slash command (`/usage` for agy, `/usage show` for grok) — their
 * non-interactive `--print` mode treats `/usage` as an LLM prompt (wrong data,
 * and it burns tokens). So the only way to read that panel is to spawn the real
 * TUI over a PTY, send the command, and scrape the rendered screen. This is the
 * headless-TUI-scrape analogue of `claudeCodeUsage.js` (which gets to use the
 * cheaper `echo /usage | claude -p` because Claude Code DOES honor `/usage` in
 * print mode).
 *
 * The scrape runs in a dedicated **sandbox cwd** (a fixed dir under the OS temp
 * dir) — never the user's project — so it can't read or mutate real work. The
 * dir is stable (not per-call) on purpose: agy/grok remember "trusted folder"
 * per path, so a stable sandbox is trusted once (via the primer Enter below)
 * and every later scrape skips straight to the prompt.
 *
 * This drives a slash command that renders synchronously — it does NOT run an
 * LLM turn — so it is 0-token and consumes no quota, matching the
 * "user-triggered usage read" carve-out in the AI Provider Usage Policy.
 *
 * Read-only capture: we read the PTY output buffer from a variable and kill the
 * child; the TUI never writes a response file (that pattern is `tuiPromptRunner`
 * for LLM tasks — not applicable to a slash command).
 */

// Fixed, reused sandbox cwd so the "trust this folder?" gate is answered once.
export const USAGE_SANDBOX_DIR = join(tmpdir(), 'portos-provider-usage-sandbox');

// Wide PTY so quota panels/meters don't wrap and split a value across lines.
const PTY_COLS = 200;
const PTY_ROWS = 50;

// Timing defaults (ms). The TUI needs a moment to sign in and paint its banner
// before it accepts input; after the command we wait for the rendered panel to
// stop changing (output-idle) rather than a fixed sleep, bounded by a hard cap.
const DEFAULT_READY_MS = 6000;       // banner + sign-in settle before first keystroke
const DEFAULT_PRIMER_CAP_MS = 3000;  // cap on waiting for the trust/menu dismissal to repaint
const DEFAULT_IDLE_MS = 2500;        // "screen finished rendering" = no output for this long
const DEFAULT_RENDER_CAP_MS = 12000; // hard cap on waiting for the panel after the command
const DEFAULT_HARD_TIMEOUT_MS = 45000; // absolute backstop for the whole scrape

/**
 * Spawn a TUI, send `slashCommand`, and resolve with the ANSI-stripped screen.
 *
 * @param {object} opts
 * @param {string} opts.command — TUI binary (`agy`, `grok`).
 * @param {string[]} [opts.args] — extra argv (default none).
 * @param {string} opts.slashCommand — e.g. `/usage` or `/usage show`.
 * @param {object} [opts.env] — extra env vars merged over `process.env` (the
 *   matched provider's `envVars`, so a provider that authenticates via env
 *   scrapes with the same config a normal run uses).
 * @param {RegExp} [opts.readyMarker] — when set, the render phase does not
 *   treat output-idle as "done" until this pattern appears in the captured
 *   screen. Guards against a TUI that renders a loading row (which would arm
 *   the plain idle heuristic) before its real panel arrives — completion then
 *   requires the panel itself, not merely "some output then quiet."
 * @param {string} [opts.sandboxDir] — cwd override (default USAGE_SANDBOX_DIR).
 * @param {number} [opts.readyMs] @param {number} [opts.primerCapMs]
 * @param {number} [opts.idleMs] @param {number} [opts.renderCapMs]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>} ANSI-stripped captured output.
 */
export async function scrapeTuiUsage({
  command,
  args = [],
  slashCommand,
  env: extraEnv = {},
  readyMarker = null,
  sandboxDir = USAGE_SANDBOX_DIR,
  readyMs = DEFAULT_READY_MS,
  primerCapMs = DEFAULT_PRIMER_CAP_MS,
  idleMs = DEFAULT_IDLE_MS,
  renderCapMs = DEFAULT_RENDER_CAP_MS,
  timeoutMs = DEFAULT_HARD_TIMEOUT_MS,
} = {}) {
  if (!command || typeof command !== 'string') throw new Error('scrapeTuiUsage: command is required');
  if (!slashCommand || typeof slashCommand !== 'string') throw new Error('scrapeTuiUsage: slashCommand is required');

  mkdirSync(sandboxDir, { recursive: true });

  // Provider envVars (auth/config) merged over process.env, then the PTY hints.
  // CLAUDECODE leaks when PortOS itself runs under Claude Code; strip it so a
  // spawned TUI doesn't think it's nested (mirrors tuiPromptRunner.js).
  const env = { ...process.env, ...extraEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete env.CLAUDECODE;

  let pty;
  try {
    pty = ptySpawn(command, args, {
      name: 'xterm-256color', cols: PTY_COLS, rows: PTY_ROWS, cwd: sandboxDir, env,
    });
  } catch (err) {
    throw new Error(`Failed to spawn TUI '${command}': ${err.message}`);
  }

  let raw = '';
  let lastDataAt = Date.now();
  let exited = false;
  pty.onData((d) => { raw += d; lastDataAt = Date.now(); });
  pty.onExit(() => { exited = true; });

  const killPty = () => { try { if (!exited) pty.kill(); } catch { /* already gone */ } };

  // Absolute backstop so a wedged TUI can't hang the request forever.
  let hardTimer = null;
  const hardStop = new Promise((resolve) => { hardTimer = setTimeout(resolve, timeoutMs); });
  let timedOut = false;
  hardStop.then(() => { timedOut = true; });

  // Wait until the screen stops changing — no PTY output for `idleMs` — bounded
  // by `capMs`. Each await also races the hard timeout, so a TUI that never goes
  // idle still returns when hardStop resolves. Callers reset `lastDataAt` right
  // after a keystroke so this measures idle relative to that input, not to stale
  // banner output from an earlier phase.
  //
  // `requireOutput` guards the render phase: after submitting the command, a
  // slow sign-in / quota lookup can stay silent for >idleMs, and without this
  // the initial silence would read as "done" and kill the TUI before its panel
  // ever renders. When set, idle can only mean completion once at least one
  // chunk has arrived since the wait began (else we wait out `capMs`, then the
  // hard-timeout backstop). The primer phase leaves it off so an already-trusted
  // sandbox (which emits nothing) returns promptly.
  // `ready` (optional) is a final predicate on the captured screen that must
  // also hold before idle counts as done — used to require the actual quota
  // panel, not just any post-submit output. Only evaluated when idle is already
  // reached, so its stripAnsi cost is paid at most once per idle poll.
  const waitForIdle = async (capMs, { requireOutput = false, ready = null } = {}) => {
    const start = Date.now();
    const deadline = start + capMs;
    while (!exited && !timedOut && Date.now() < deadline) {
      const sawOutput = lastDataAt > start;
      const idle = Date.now() - lastDataAt >= idleMs;
      if ((!requireOutput || sawOutput) && idle && (!ready || ready())) return;
      await Promise.race([sleep(250), hardStop]);
    }
  };

  try {
    await Promise.race([sleep(readyMs), hardStop]);

    // Dismiss the first-run gate: agy shows "Do you trust this folder?" (default
    // "Yes, I trust"), grok shows a start menu (default highlighted item). One
    // Enter clears either. On an already-trusted sandbox there is no gate and
    // this is a harmless empty-prompt submit. Wait for the dismissal to repaint.
    if (!exited) { pty.write('\r'); lastDataAt = Date.now(); }
    await waitForIdle(primerCapMs);

    // Bracketed-paste the command so multi-word input (`/usage show`) lands
    // atomically, then submit and wait for the panel to render.
    if (!exited) {
      pty.write(`\x1b[200~${slashCommand}\x1b[201~`);
      await Promise.race([sleep(400), hardStop]);
      pty.write('\r');
      lastDataAt = Date.now();
    }
    await waitForIdle(renderCapMs, {
      requireOutput: true,
      ready: readyMarker ? () => readyMarker.test(stripAnsi(raw)) : null,
    });
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    killPty();
  }

  return stripAnsi(raw);
}
