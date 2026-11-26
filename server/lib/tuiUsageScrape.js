/**
 * `scrapeTuiUsage({ command, slashCommand, … })` + `USAGE_SANDBOX_DIR`.
 *
 * drive an agy/grok TUI in a sandbox PTY, send a slash command and return the ANSI-stripped screen (for quota panels `--print` can't reach).
 */

import { spawn as ptySpawn } from 'node-pty';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { stripAnsi } from './ansiStrip.js';
import { sleep } from './fileUtils.js';
import { buildCliChildEnv } from './cliChildEnv.js';
import { SUBMIT_KEY } from './tuiHandshake.js';
import { killProcessTree } from './bufferedSpawn.js';

/**
 * Drive an interactive coding-agent TUI (Antigravity `agy`, Grok Build `grok`) in a throwaway PTY, type a slash command, and return the ANSI-stripped screen text.
 *
 * Some CLIs expose subscription quota ONLY through an interactive slash command (`/usage` for agy, `/usage show` for grok); their `--print` mode treats `/usage` as an LLM prompt (wrong data, burns tokens).
 * This is the headless-TUI analogue of `claudeCodeUsage.js` (Claude Code honors `/usage` in print mode). It runs in a dedicated **sandbox cwd** under the OS temp dir, never the user's project, and the dir is
 * stable on purpose: agy/grok remember "trusted folder" per path, so it is trusted once (via the primer Enter) and later scrapes skip to the prompt.
 * A slash command renders synchronously and runs NO LLM turn, so it is 0-token (the "user-triggered usage read" carve-out in the AI Provider Usage Policy). Capture is read-only: the PTY buffer is read from a
 * variable and the child killed (no response file; that is `tuiPromptRunner` for LLM tasks).
 */

// Fixed, reused sandbox cwd so the "trust this folder?" gate is answered once.
export const USAGE_SANDBOX_DIR = join(tmpdir(), 'portos-provider-usage-sandbox');

// Wide PTY so quota panels/meters don't wrap and split a value across lines.
const PTY_COLS = 200;
const PTY_ROWS = 50;

// Timing defaults (ms): the TUI needs a moment to sign in and paint before accepting input; after the command we wait for output-idle rather than a fixed sleep, bounded by a hard cap.
const DEFAULT_READY_CAP_MS = 15000;  // cap on waiting for the banner/gate to paint + go idle
const DEFAULT_PRIMER_CAP_MS = 3000;  // cap on waiting for the trust/menu dismissal to repaint
const DEFAULT_IDLE_MS = 2500;        // "screen finished rendering" = no output for this long
const DEFAULT_RENDER_CAP_MS = 12000; // hard cap on waiting for the panel after the command
const DEFAULT_HARD_TIMEOUT_MS = 45000; // absolute backstop for the whole scrape

// Bounded tail for the PTY capture: slice back to CAP once it exceeds HEADROOM (not every chunk, avoiding repeated reallocations). 512KB holds many repaints of a quota panel.
const RAW_BUFFER_CAP = 512 * 1024;
const RAW_BUFFER_HEADROOM = RAW_BUFFER_CAP * 2;

/**
 * Spawn a TUI, send `slashCommand`, and resolve with the ANSI-stripped screen.
 *
 * @param {object} opts
 * @param {string} opts.command — TUI binary (`agy`, `grok`).
 * @param {string[]} [opts.args] — extra argv (default none).
 * @param {string} opts.slashCommand — e.g. `/usage` or `/usage show`.
 * @param {object} [opts.env] — extra env merged over `process.env` (the matched provider's `envVars`, so env-authenticated providers scrape with their normal config).
 * @param {RegExp} [opts.readyMarker] — when set, output-idle isn't "done" until this pattern appears in the screen, guarding a TUI that renders a loading row before its real panel.
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
  readyCapMs = DEFAULT_READY_CAP_MS,
  primerCapMs = DEFAULT_PRIMER_CAP_MS,
  idleMs = DEFAULT_IDLE_MS,
  renderCapMs = DEFAULT_RENDER_CAP_MS,
  timeoutMs = DEFAULT_HARD_TIMEOUT_MS,
  // True when `command` is a credential-bootstrap WRAPPER, not the harness: node-pty's `kill()` signals its direct child's pid alone, so a forking wrapper would leave the harness rendering into an unread PTY
  // (every exit runs through killPty, #7496). forkpty makes the child a session leader whose descendants share its group, so the group signal is exact.
  processGroup = false,
} = {}) {
  if (!command || typeof command !== 'string') throw new Error('scrapeTuiUsage: command is required');
  if (!slashCommand || typeof slashCommand !== 'string') throw new Error('scrapeTuiUsage: slashCommand is required');

  mkdirSync(sandboxDir, { recursive: true });

  // TERM/COLORTERM go in `extra` so the PTY is always a truecolor xterm (mirrors tuiPromptRunner.js); the PWD pin keeps the scrape in the sandbox, not the PortOS checkout. No provider record: this drives a slash command, not a model.
  const env = buildCliChildEnv({
    before: extraEnv,
    cwd: sandboxDir,
    extra: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  let pty;
  try {
    pty = ptySpawn(command, args, {
      name: 'xterm-256color', cols: PTY_COLS, rows: PTY_ROWS, cwd: sandboxDir, env,
    });
  } catch (err) {
    throw new Error(`Failed to spawn TUI '${command}': ${err.message}`);
  }

  // Keep a bounded tail: the quota panel renders near the end and parsers take the latest value per key; a noisy TUI repainting continuously could otherwise grow `raw` to hundreds of MB and trip PM2's memory restart (mirrors tuiPromptRunner's cap).
  let raw = '';
  let lastDataAt = Date.now();
  let exited = false;
  pty.onData((d) => {
    raw += d;
    if (raw.length > RAW_BUFFER_HEADROOM) raw = raw.slice(-RAW_BUFFER_CAP);
    lastDataAt = Date.now();
  });
  pty.onExit(() => { exited = true; });

  // 'SIGHUP' is node-pty's POSIX default for `kill()`; naming it keeps the signal identical while letting killProcessTree take the group path.
  const killPty = () => { try { if (!exited) killProcessTree(pty, 'SIGHUP', { processGroup }); } catch { /* already gone */ } };

  // Absolute backstop so a wedged TUI can't hang the request forever.
  let hardTimer = null;
  const hardStop = new Promise((resolve) => { hardTimer = setTimeout(resolve, timeoutMs); });
  let timedOut = false;
  hardStop.then(() => { timedOut = true; });
  const isActive = () => !exited && !timedOut;

  // Wait until the screen stops changing (no PTY output for `idleMs`), bounded by `capMs`; each await also races the hard timeout. Callers reset `lastDataAt` after a keystroke so idle is measured from that input.
  // `requireOutput` guards the render phase: a slow sign-in/quota lookup can stay silent for >idleMs, and the initial silence would read as "done" and kill the TUI before its panel renders; when set, idle counts
  // only after at least one chunk arrived since the wait began (else wait out `capMs`, then the hard-timeout backstop). The primer phase leaves it off so an already-trusted sandbox (which emits nothing) returns promptly.
  // `ready` (optional) is a final predicate on the screen that must also hold (the actual quota panel, not any post-submit output); evaluated only once idle is reached, so its stripAnsi cost is paid at most once per poll.
  const waitForIdle = async (capMs, { requireOutput = false, ready = null } = {}) => {
    const start = Date.now();
    const deadline = start + capMs;
    while (isActive() && Date.now() < deadline) {
      const sawOutput = lastDataAt > start;
      const idle = Date.now() - lastDataAt >= idleMs;
      if ((!requireOutput || sawOutput) && idle && (!ready || ready())) return;
      await Promise.race([sleep(250), hardStop]);
    }
  };

  try {
    // Wait for the initial paint (banner, sign-in spinner, trust/menu gate) to go input-idle before touching the keyboard: a fixed sleep could fire the primer Enter before a slow startup's gate rendered and drop it.
    await waitForIdle(readyCapMs, { requireOutput: true });

    // Dismiss the first-run gate (agy: "Do you trust this folder?", grok: start menu): one Enter clears either, and on a trusted sandbox it is a harmless empty submit. Wait for the repaint.
    if (isActive()) { pty.write(SUBMIT_KEY); lastDataAt = Date.now(); }
    await waitForIdle(primerCapMs);

    // Bracketed-paste the command so multi-word input (`/usage show`) lands atomically, then submit and wait for the panel.
    if (isActive()) {
      pty.write(`\x1b[200~${slashCommand}\x1b[201~`);
      await Promise.race([sleep(400), hardStop]);
      if (isActive()) { pty.write(SUBMIT_KEY); lastDataAt = Date.now(); }
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
