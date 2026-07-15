import { open, readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { getAllProviders } from './providers.js';
import { getClaudeCodeUsage } from './claudeCodeUsage.js';
import { commandBasename, isClaudeCommand } from '../lib/providerModels.js';
import { isGrokCommand } from '../lib/grok.js';
import { scrapeTuiUsage } from '../lib/tuiUsageScrape.js';

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
 * local session logs; the Antigravity/Grok adapters drive an interactive
 * `/usage` slash command that renders synchronously, with no LLM turn).
 *
 * Caching: the claude adapter carries its own 60s cache + single-flight inside
 * claudeCodeUsage.js; the codex adapter is a bounded local-file tail read (1-2
 * leaf dirs on a typical layout); the Antigravity/Grok adapters carry a 5-min
 * cache + single-flight here (`cachedScrape`) because each TUI scrape costs
 * ~10-15s (spawn + sign-in + render), too slow to repeat per page poll.
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

// --- Antigravity + Grok: scrape the interactive TUI `/usage` panel ----------
//
// Neither CLI exposes quota in non-interactive `--print` mode (there, `/usage`
// is treated as an LLM prompt — wrong data, and it burns tokens). Their only
// usage surface is an interactive slash command, so we drive the real TUI in a
// sandbox PTY (see lib/tuiUsageScrape.js) and parse the rendered screen. The
// slash command renders synchronously (no LLM turn) → 0-token, user-triggered.

// A short TTL cache: a TUI scrape costs ~10-15s (spawn + sign-in + render), far
// too slow to repeat on every page poll. `refresh: true` bypasses it. Single-
// user install, single process — a plain module-level map is sufficient.
const SCRAPE_CACHE_TTL_MS = 5 * 60 * 1000;
const scrapeCache = new Map(); // familyId -> { at, value } | { inflight }

/** Test-only: clear the TUI-scrape TTL cache so a suite isn't order-dependent. */
export function __resetUsageScrapeCache() {
  scrapeCache.clear();
}

async function cachedScrape(familyId, { refresh }, produce) {
  const hit = scrapeCache.get(familyId);
  if (!refresh && hit?.value && Date.now() - hit.at < SCRAPE_CACHE_TTL_MS) return hit.value;
  if (hit?.inflight) return hit.inflight; // fold concurrent callers into one scrape
  const inflight = (async () => {
    const value = await produce();
    scrapeCache.set(familyId, { at: Date.now(), value });
    return value;
  })().catch((err) => {
    scrapeCache.delete(familyId);
    throw err;
  });
  scrapeCache.set(familyId, { inflight });
  return inflight;
}

/**
 * Render an acronym-preserving title label from an ALL-CAPS token: long words
 * become Title Case (`GEMINI` → `Gemini`), short all-caps tokens stay as-is
 * (`GPT` → `GPT`). Pure.
 */
function titleizeToken(token) {
  if (token.length <= 4) return token; // GPT, GPU, etc. — keep the acronym
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/** `GEMINI MODELS` → `Gemini`; `CLAUDE AND GPT MODELS` → `Claude/GPT`. Pure. */
function agyGroupLabel(header) {
  const core = header.replace(/\s*MODELS\s*$/i, '').trim();
  return core
    .split(/\s+AND\s+/i)
    .map((part) => part.split(/\s+/).map(titleizeToken).join(' '))
    .join('/');
}

/** `Weekly Limit` → `Weekly`; `Five Hour Limit` → `5-hour`. Pure. */
function agyWindowLabel(raw) {
  const core = raw.replace(/\s*Limit\s*$/i, '').trim();
  return /^five hour$/i.test(core) ? '5-hour' : core;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Parse `Refreshes in 167h 57m` / `4h 57m` / `2d 3h` into an absolute ISO reset
 * time (now + duration). Returns null when no duration is found. `now` is
 * injectable for tests. Pure given `now`.
 */
export function agyRefreshToIso(text, now = Date.now()) {
  if (typeof text !== 'string') return null;
  const d = text.match(/(\d+)\s*d/i);
  const h = text.match(/(\d+)\s*h/i);
  const m = text.match(/(\d+)\s*m(?!o)/i); // `m` but not `mo`(nth)
  if (!d && !h && !m) return null;
  const ms = ((d ? +d[1] : 0) * 86400 + (h ? +h[1] : 0) * 3600 + (m ? +m[1] : 0) * 60) * 1000;
  return new Date(now + ms).toISOString();
}

/**
 * Parse the Antigravity `/usage` panel text into common-shape limit rows.
 * The panel groups models (e.g. `GEMINI MODELS`, `CLAUDE AND GPT MODELS`); each
 * group has one or more `<window> Limit` rows showing a bar `NN.NN%` that is the
 * percent REMAINING (a full bar = full quota), then either
 * `NN% remaining · Refreshes in <dur>` or `Quota available` (full, no reset).
 * Exported for tests. Pure given `now`.
 *
 * @returns {{ limits: Array, groups: number }}
 */
export function parseAgyUsage(text, { now = Date.now() } = {}) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const limits = [];
  const groups = new Set();
  let group = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const g = line.match(/^([A-Z][A-Z0-9 &/+-]*?MODELS)$/);
    if (g) { group = agyGroupLabel(g[1]); groups.add(group); continue; }
    if (!group) continue;
    const w = line.match(/^([A-Z][A-Za-z ]{0,24}?Limit)$/);
    if (!w) continue;
    // Look ahead a few lines for the bar percentage + reset/quota-available.
    let remaining = null;
    let resetsAt = null;
    let quotaAvailable = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      const pct = lines[j].match(/([\d.]+)\s*%/);
      if (pct && remaining === null) remaining = parseFloat(pct[1]);
      if (/quota available/i.test(lines[j])) quotaAvailable = true;
      const r = lines[j].match(/refreshes in\s+(.+?)(?:\s{2,}|·|$)/i);
      if (r && !resetsAt) resetsAt = agyRefreshToIso(r[1], now);
    }
    if (remaining === null) continue; // not a real limit block
    const windowLabel = agyWindowLabel(w[1]);
    const percentRemaining = Math.round(remaining);
    limits.push({
      key: `${slug(group)}-${slug(windowLabel)}`,
      label: `${group} · ${windowLabel}`,
      scope: slug(windowLabel),
      model: group,
      percentUsed: Math.max(0, Math.round(100 - remaining)),
      percentRemaining,
      resetsAt: quotaAvailable ? null : resetsAt,
      timezone: null,
    });
  }
  return { limits, groups: groups.size };
}

/**
 * Parse the Grok Build `/usage show` panel text. Grok reports a single line
 * `Weekly limit: N%` (percent USED) plus `Next reset: <date>`. Exported for
 * tests. Pure.
 *
 * @returns {{ limits: Array }}
 */
export function parseGrokUsage(text) {
  const str = String(text || '');
  const wl = str.match(/weekly limit:\s*([\d.]+)\s*%/i);
  if (!wl) return { limits: [] };
  const percentUsed = Math.round(parseFloat(wl[1]));
  const nr = str.match(/next reset:\s*([A-Za-z0-9 ,:]+?)(?:\s{2,}|$)/i);
  return {
    limits: [{
      key: 'weekly',
      label: 'Weekly',
      scope: 'week',
      model: null,
      percentUsed,
      percentRemaining: Math.max(0, 100 - percentUsed),
      // Grok gives a local-time date string without a year/zone; pass it
      // through verbatim (the UI renders non-ISO reset strings as-is).
      resetsAt: nr ? nr[1].trim() : null,
      timezone: null,
    }],
  };
}

/**
 * Build a family `fetch` fn that scrapes a TUI `/usage` panel and maps it to the
 * common quota shape (cached; `refresh` bypasses). `parse` returns `{ limits }`;
 * an empty result becomes a `supported`-but-`error` card so the UI shows a soft
 * warning rather than a blank card. `name` is the human product name spliced
 * into the note/error copy (e.g. `Antigravity CLI`).
 */
function makeTuiUsageFetcher({ id, command, slashCommand, label, parse, name }) {
  return ({ refresh = false } = {}) => cachedScrape(id, { refresh }, async () => {
    const { limits } = parse(await scrapeTuiUsage({ command, slashCommand }));
    const base = { family: id, label, supported: true, plan: null, activity: [], approximate: true, fetchedAt: new Date().toISOString() };
    return limits.length
      ? { ...base, limits, note: `Scraped from the ${name} /usage panel — local, approximate.` }
      : { ...base, limits: [], error: `No quota data found in the ${name} /usage panel.` };
  });
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
    fetch: makeTuiUsageFetcher({ id: 'agy', command: 'agy', slashCommand: '/usage', label: 'Antigravity', parse: parseAgyUsage, name: 'Antigravity CLI' })
  },
  {
    id: 'grok',
    label: 'Grok',
    matches: (p) => isGrokCommand(p.command) || /grok/i.test(p.id || ''),
    fetch: makeTuiUsageFetcher({ id: 'grok', command: 'grok', slashCommand: '/usage show', label: 'Grok', parse: parseGrokUsage, name: 'Grok Build CLI' })
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
  const result = await getAllProviders();
  const providers = Array.isArray(result) ? result : (result?.providers || []);
  const families = resolveEnabledFamilies(providers);
  return Promise.all(families.map((family) => fetchFamilyQuota(family, { refresh })));
}
