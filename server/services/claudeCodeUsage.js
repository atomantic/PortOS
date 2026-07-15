import { spawn } from 'child_process';
import { existsSync, lstatSync, readlinkSync } from 'fs';
import { stripAnsi } from '../lib/ansiStrip.js';

/**
 * Claude Code SUBSCRIPTION usage — the plan rate-limit numbers surfaced by the
 * `/usage` slash command (session %, weekly %, per-model weekly %, reset times).
 *
 * This is DISTINCT from `server/services/usage.js`, which is PortOS's own
 * accounting of AI-toolkit provider runs. Here we shell out to the Claude Code
 * CLI in print mode and parse its human-readable `/usage` output into JSON:
 *
 *   echo "/usage" | claude -p
 *
 * The CLI has no structured usage endpoint — the text output is the only
 * surface — so the parser below is deliberately tolerant of missing lines and
 * strips ANSI. Running `/usage` is read-only and consumes 0 tokens, so it is
 * safe to call on page load (does NOT violate the no-cold-bootstrap-LLM policy:
 * it's a direct user action and no provider call is made).
 *
 * The numbers are a per-machine local approximation — the CLI itself notes they
 * "do not include other devices or claude.ai" — which is preserved verbatim in
 * `raw` for display.
 */

const CLI_COMMAND = 'claude';
const CLI_ARGS = ['-p'];
const STDIN_INPUT = '/usage\n';
const SPAWN_TIMEOUT_MS = 60_000;
const CACHE_TTL_MS = 60_000;

const toInt = (s) => (s == null ? null : parseInt(String(s).replace(/,/g, ''), 10));

/**
 * Pull the IANA zone (e.g. `America/Los_Angeles`) out of an `/etc/localtime`
 * symlink target (`.../zoneinfo/America/Los_Angeles`). Returns null if the path
 * doesn't look like a zoneinfo link. Pure — unit-tested.
 */
export function zoneFromLocaltimeLink(link) {
  const m = (link || '').match(/zoneinfo\/(.+)$/);
  return m ? m[1] : null;
}

// Claude Code renders /usage reset times in the child process's timezone (and
// labels them with it). A server started under PM2/systemd/Docker commonly runs
// in UTC, which would shift every reset time away from what the user sees in an
// interactive terminal. Resolve the machine's real timezone from the OS —
// independent of this process's own (possibly UTC) TZ env — and pass it to the
// child so headless output matches the interactive TUI. Memoized; best-effort
// (null → inherit the process env unchanged).
let cachedSystemTz;
export function systemTimeZone() {
  if (cachedSystemTz !== undefined) return cachedSystemTz;
  cachedSystemTz = existsSync('/etc/localtime') && lstatSync('/etc/localtime').isSymbolicLink()
    ? zoneFromLocaltimeLink(readlinkSync('/etc/localtime'))
    : null;
  return cachedSystemTz;
}

/**
 * Parse one `Current …: N% used · resets <when> (<tz>)` limit line.
 * Returns null when the line isn't a limit line.
 */
function parseLimitLine(line) {
  const match = line.match(/^(Current [^:]+):\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+?))?$/i);
  if (!match) return null;
  const label = match[1].trim();
  const percentUsed = toInt(match[2]);
  let resetsAt = match[3] ? match[3].trim() : null;
  let timezone = null;
  if (resetsAt) {
    const tz = resetsAt.match(/\(([^)]+)\)\s*$/);
    if (tz) {
      timezone = tz[1];
      resetsAt = resetsAt.slice(0, tz.index).trim();
    }
  }
  // Derive a stable key + optional model from the label.
  // "Current session" → session; "Current week (all models)" → week (model: all models);
  // "Current week (Fable)" → week (model: Fable).
  const scopeMatch = label.match(/^Current\s+(\w+)(?:\s*\(([^)]+)\))?/i);
  const scope = scopeMatch ? scopeMatch[1].toLowerCase() : label.toLowerCase();
  const model = scopeMatch && scopeMatch[2] ? scopeMatch[2].trim() : null;
  const key = model ? `${scope}:${model.toLowerCase().replace(/\s+/g, '-')}` : scope;
  return {
    key,
    label,
    scope,
    model,
    percentUsed,
    percentRemaining: percentUsed == null ? null : Math.max(0, 100 - percentUsed),
    resetsAt,
    timezone,
  };
}

/**
 * Parse a `Last 24h · 1700 requests · 18 sessions` activity header.
 */
function parseActivityHeader(line) {
  const match = line.match(/^(Last\s+\S+)\s*·\s*([\d,]+)\s*requests\s*·\s*([\d,]+)\s*sessions/i);
  if (!match) return null;
  return { period: match[1].trim(), requests: toInt(match[2]), sessions: toInt(match[3]), notes: [] };
}

/**
 * Pure parser: `/usage` text → structured object. Tolerant of absent lines so a
 * future CLI format tweak degrades gracefully instead of throwing.
 */
export function parseUsageOutput(text) {
  const raw = (text || '').trim();
  const lines = stripAnsi(raw).split('\n');

  let plan = 'unknown';
  if (/using your subscription/i.test(raw)) plan = 'subscription';
  else if (/pay[- ]as[- ]you[- ]go|api\b/i.test(raw)) plan = 'api';

  const limits = [];
  const activity = [];
  let currentActivity = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();

    const limit = parseLimitLine(trimmed);
    if (limit) {
      limits.push(limit);
      currentActivity = null;
      continue;
    }

    const activityHeader = parseActivityHeader(trimmed);
    if (activityHeader) {
      currentActivity = activityHeader;
      activity.push(currentActivity);
      continue;
    }

    // Indented detail lines belong to the most recent activity block.
    if (currentActivity && /^\s{2,}\S/.test(rawLine) && trimmed) {
      currentActivity.notes.push(trimmed);
    } else if (trimmed === '') {
      // blank line ends an activity block's detail run
      currentActivity = null;
    }
  }

  const approximate = /does not include other devices/i.test(raw);

  return { plan, limits, activity, approximate, raw };
}

// --- fetch + cache -------------------------------------------------------

let cache = null; // { data, at }
let inflight = null;

/**
 * Spawn the Claude Code CLI in print mode, feed `/usage` on stdin, and resolve
 * with the buffered stdout. Rejects on spawn error, timeout, or non-zero exit
 * with no usable output. Runs outside the Express request lifecycle, so the
 * child's error/timeout paths are handled explicitly here rather than bubbling.
 */
function runUsageCli() {
  return new Promise((resolve, reject) => {
    const tz = systemTimeZone();
    const env = tz ? { ...process.env, TZ: tz } : process.env;
    const child = spawn(CLI_COMMAND, CLI_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Claude Code /usage timed out after ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    // Same crash class as the stdin guard below: a pipe read error (e.g. the
    // child is SIGKILL'd mid-stream) would otherwise go unhandled and crash the
    // process. The 'close'/'error'/timeout handlers still settle the promise.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint = err.code === 'ENOENT'
        ? 'Claude Code CLI (`claude`) not found on PATH'
        : err.message;
      reject(new Error(`Failed to run Claude Code /usage: ${hint}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdout.trim()) return resolve(stdout);
      reject(new Error(`Claude Code /usage exited ${code} with no output${stderr ? `: ${stderr.trim()}` : ''}`));
    });

    // If the binary is missing (ENOENT) or the child dies before reading stdin,
    // writing here emits an 'error' (EPIPE/ENOENT) on the stdin stream. Without
    // this listener that unhandled stream error crashes the process; the
    // meaningful rejection still comes from the child 'error' handler above.
    child.stdin.on('error', () => {});
    child.stdin.write(STDIN_INPUT);
    child.stdin.end();
  });
}

/**
 * Get parsed Claude Code subscription usage, cached for 60s. Concurrent callers
 * share one in-flight CLI run. `refresh: true` bypasses the cache.
 */
export async function getClaudeCodeUsage({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  if (inflight) return inflight;

  inflight = runUsageCli()
    .then((stdout) => {
      const parsed = parseUsageOutput(stdout);
      const data = { ...parsed, fetchedAt: new Date().toISOString() };
      // Only cache a read that actually produced rate-limit lines. A transient
      // degraded /usage (e.g. the live-limit lines dropped by a hiccup) would
      // otherwise poison the panel with an empty state for the full 60s TTL; not
      // caching it lets the next view self-heal. A subscription always has limit
      // lines — an API-key user legitimately has none, but re-reading on each
      // view for that minority is cheap (the call is 0-token).
      if (data.limits.length > 0) cache = { data, at: Date.now() };
      return data;
    })
    .finally(() => { inflight = null; });

  return inflight;
}
