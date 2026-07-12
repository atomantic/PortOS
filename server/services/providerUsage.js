import { open, readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { getAllProviders } from './providers.js';
import { getClaudeCodeUsage } from './claudeCodeUsage.js';
import { commandBasename, isClaudeCommand } from '../lib/providerModels.js';
import { isGrokCommand } from '../lib/grok.js';

/**
 * Provider subscription-quota adapters for /devtools/usage — one card per
 * enabled provider *family* (claude, codex, agy, grok), each answering "how
 * much usage do I have left." Every adapter returns the common shape:
 *
 *   { family, label, supported, plan?, limits[], activity[], approximate,
 *     fetchedAt, note?, error? }
 *
 * `supported: false` means the provider has no queryable usage surface at all
 * (the UI renders a muted "not available" note, never an error). A supported
 * adapter that fails transiently returns `error` instead of throwing so one
 * broken CLI can't 500 the whole endpoint.
 *
 * AI Provider Usage Policy: these fetches run only on user request from the
 * usage page — never at server boot — and none of them consume tokens (the
 * Claude `/usage` print-mode call is 0-token; the Codex adapter only reads
 * local session logs).
 *
 * No registry-level cache: the claude adapter already carries its own 60s
 * cache + single-flight inside claudeCodeUsage.js, and the codex adapter is a
 * bounded local-file tail read (1-2 leaf dirs on a typical layout).
 */

// --- Codex: parse rate-limit telemetry out of local session logs -----------
//
// The Codex CLI has no queryable usage command, but every session appends
// `token_count` events carrying `rate_limits` (used %, window minutes, reset
// epoch, plan type) to its rollout log. Reading the newest event costs zero
// tokens; the numbers are "as of the last Codex session activity."

const CODEX_SCAN_FILE_LIMIT = 15;
const CODEX_TAIL_BYTES = 256 * 1024;

const codexHomeDir = () => process.env.CODEX_HOME || join(homedir(), '.codex');

function humanizeWindowMinutes(minutes) {
  if (!Number.isFinite(minutes)) return 'window';
  if (minutes % 10080 === 0) return minutes === 10080 ? 'week' : `${minutes / 10080} weeks`;
  if (minutes % 1440 === 0) return minutes === 1440 ? 'day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}

/**
 * Pure: extract the newest `rate_limits` payload from rollout-JSONL content.
 * Scans lines from the end. Returns `{ rateLimits, timestamp }` or null.
 * Exported for tests.
 */
export function parseCodexRateLimits(jsonlText) {
  const lines = String(jsonlText || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // tail-read can clip the oldest line in the chunk mid-JSON
    }
    const rateLimits = parsed?.payload?.rate_limits ?? parsed?.rate_limits;
    if (rateLimits && typeof rateLimits === 'object') {
      return { rateLimits, timestamp: parsed.timestamp || null };
    }
  }
  return null;
}

function codexLimitEntry(scopeKey, window) {
  if (!window || typeof window.used_percent !== 'number') return null;
  const windowLabel = humanizeWindowMinutes(window.window_minutes);
  const percentUsed = Math.round(window.used_percent);
  return {
    key: scopeKey,
    label: `Current ${windowLabel}`,
    scope: scopeKey,
    model: null,
    percentUsed,
    percentRemaining: Math.max(0, 100 - percentUsed),
    resetsAt: Number.isFinite(window.resets_at) ? new Date(window.resets_at * 1000).toISOString() : null,
    timezone: null
  };
}

/**
 * Pure: map a codex `rate_limits` payload + event timestamp to the common
 * quota shape. Exported for tests.
 */
export function mapCodexQuota(rateLimits, timestamp) {
  const limits = [
    codexLimitEntry('session', rateLimits.primary),
    codexLimitEntry('week', rateLimits.secondary)
  ].filter(Boolean);
  return {
    family: 'codex',
    label: 'Codex',
    supported: true,
    plan: rateLimits.plan_type || 'unknown',
    limits,
    activity: [],
    approximate: true,
    note: timestamp
      ? `As of the last Codex session activity (${timestamp}). Local telemetry only.`
      : 'As of the last Codex session activity. Local telemetry only.',
    fetchedAt: new Date().toISOString()
  };
}

/**
 * Newest-first rollout log paths under <codexHome>/sessions. Codex lays
 * sessions out as `sessions/YYYY/MM/DD/rollout-<ISO-timestamp>-<uuid>.jsonl`,
 * so directory and file names both sort chronologically — walk them in
 * descending lexicographic order and stop as soon as the scan limit is hit
 * (typically 1-2 leaf dirs touched, zero stat calls).
 */
async function listCodexRolloutFiles(codexHome) {
  const sessionsDir = join(codexHome, 'sessions');
  const newestFirstDirs = async (dir) =>
    (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();

  const files = [];
  for (const year of await newestFirstDirs(sessionsDir)) {
    for (const month of await newestFirstDirs(join(sessionsDir, year))) {
      for (const day of await newestFirstDirs(join(sessionsDir, year, month))) {
        const dayDir = join(sessionsDir, year, month, day);
        const names = (await readdir(dayDir).catch(() => []))
          .filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
          .sort()
          .reverse();
        for (const name of names) {
          files.push(join(dayDir, name));
          if (files.length >= CODEX_SCAN_FILE_LIMIT) return files;
        }
      }
    }
  }
  return files;
}

async function readFileTail(file, bytes) {
  const info = await stat(file);
  if (info.size <= bytes) return readFile(file, 'utf-8');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, info.size - bytes);
    return buffer.toString('utf-8');
  } finally {
    await handle.close();
  }
}

async function fetchCodexQuota({ codexHome = codexHomeDir() } = {}) {
  const files = await listCodexRolloutFiles(codexHome);
  for (const file of files) {
    const tail = await readFileTail(file, CODEX_TAIL_BYTES).catch(() => null);
    if (!tail) continue;
    const found = parseCodexRateLimits(tail);
    if (found) return mapCodexQuota(found.rateLimits, found.timestamp);
  }
  return {
    family: 'codex',
    label: 'Codex',
    supported: true,
    plan: 'unknown',
    limits: [],
    activity: [],
    approximate: true,
    fetchedAt: new Date().toISOString(),
    error: files.length
      ? 'No rate-limit telemetry found in recent Codex session logs.'
      : 'No Codex session logs found — run Codex once to populate usage telemetry.'
  };
}

// --- Claude: wrap the existing /usage CLI parser ---------------------------

async function fetchClaudeQuota({ refresh = false } = {}) {
  const data = await getClaudeCodeUsage({ refresh });
  return {
    family: 'claude',
    label: 'Claude Code',
    supported: true,
    plan: data.plan,
    limits: data.limits,
    activity: data.activity,
    approximate: data.approximate,
    note: data.approximate ? 'Local sessions only — does not include other devices or claude.ai.' : null,
    fetchedAt: data.fetchedAt
  };
}

// --- Unsupported families ---------------------------------------------------

const unsupported = (family, label, reason) => async () => ({
  family,
  label,
  supported: false,
  limits: [],
  activity: [],
  approximate: false,
  note: reason,
  fetchedAt: new Date().toISOString()
});

// --- Family registry --------------------------------------------------------

/**
 * A provider config belongs to at most one family. CLI/TUI commands are
 * matched by binary basename; the Grok/Kimi-style API providers by id or
 * endpoint. Ollama-backed CLI wrappers are local/free and have no
 * subscription quota, so they map to no family.
 */
const FAMILIES = [
  {
    id: 'claude',
    label: 'Claude Code',
    matches: (p) => (p.type === 'cli' || p.type === 'tui') && isClaudeCommand(p.command),
    fetch: fetchClaudeQuota
  },
  {
    id: 'codex',
    label: 'Codex',
    matches: (p) => commandBasename(p.command) === 'codex',
    fetch: () => fetchCodexQuota()
  },
  {
    id: 'agy',
    label: 'Antigravity',
    matches: (p) => commandBasename(p.command) === 'agy' || /antigravity/i.test(p.id || ''),
    fetch: unsupported('agy', 'Antigravity', 'The Antigravity CLI does not expose usage or quota telemetry.')
  },
  {
    id: 'grok',
    label: 'Grok',
    matches: (p) => isGrokCommand(p.command) || /grok/i.test(p.id || ''),
    fetch: unsupported('grok', 'Grok', 'The Grok CLI and xAI API do not expose remaining-quota telemetry.')
  }
];

/**
 * Distinct quota families among the enabled providers, in registry order.
 * Ollama-backed wrappers are excluded up front regardless of which CLI binary
 * they launch — a local model has no subscription quota, so e.g. an enabled
 * `claude-ollama` must not surface a Claude Code card (nor a codex/agy/grok
 * wrapper its family's card).
 */
export function resolveEnabledFamilies(providers) {
  const enabled = (providers || []).filter((p) => p?.enabled && p.ollamaBacked !== true);
  return FAMILIES.filter((family) => enabled.some((p) => family.matches(p)));
}

const fetchFamilyQuota = (family, { refresh }) =>
  Promise.resolve(family.fetch({ refresh })).catch((err) => ({
    family: family.id,
    label: family.label,
    supported: true,
    limits: [],
    activity: [],
    approximate: false,
    fetchedAt: new Date().toISOString(),
    error: err?.message || String(err)
  }));

/**
 * Quota status for every enabled provider family. `refresh: true` bypasses
 * the claude adapter's 60s cache. Never rejects — per-family failures surface
 * as `error` entries.
 */
export async function getProviderQuotas({ refresh = false } = {}) {
  const providers = await getAllProviders();
  const families = resolveEnabledFamilies(providers);
  return Promise.all(families.map((family) => fetchFamilyQuota(family, { refresh })));
}
