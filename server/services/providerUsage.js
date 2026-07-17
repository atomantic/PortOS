import { open, readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { getAllProviders } from './providers.js';
import { getClaudeCodeUsage, systemTimeZone } from './claudeCodeUsage.js';
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
  // The scraped buffer is an append-only terminal stream: if the TUI repaints
  // the panel, an older and newer copy of each window both survive the ANSI
  // strip. Key by the stable limit key so a repaint OVERWRITES (latest wins)
  // instead of emitting duplicate rows (which would collide on the React key).
  const byKey = new Map();
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
    const key = `${slug(group)}-${slug(windowLabel)}`;
    // Round ONE side and derive the other so used + remaining always == 100.
    // Independently rounding both (e.g. 98.50% remaining → 99 left + 2 used)
    // would show a card totalling 101%.
    const percentUsed = Math.min(100, Math.max(0, Math.round(100 - remaining)));
    byKey.set(key, {
      key,
      label: `${group} · ${windowLabel}`,
      scope: slug(windowLabel),
      model: group,
      percentUsed,
      percentRemaining: 100 - percentUsed,
      resetsAt: quotaAvailable ? null : resetsAt,
      timezone: null,
    });
  }
  return { limits: [...byKey.values()], groups: groups.size };
}

// Grok's `/usage show` panel reports usage as `<Window> limit: N%` (percent
// USED). Its binary strings expose both `Weekly limit` and `Monthly limit`, so
// different plans surface different windows — parse whichever appear.
const GROK_WINDOWS = { weekly: { label: 'Weekly', scope: 'week' }, monthly: { label: 'Monthly', scope: 'month' } };

/**
 * Parse the Grok Build `/usage show` panel text. Emits one row per usage window
 * present (`Weekly limit: N%` and/or `Monthly limit: N%`, percent USED) plus a
 * shared `Next reset: <date>`. Exported for tests. Pure.
 *
 * @returns {{ limits: Array }}
 */
export function parseGrokUsage(text) {
  const str = String(text || '');
  // Append-only terminal stream: a repaint leaves an older copy of a line ahead
  // of the newer one, so keep the LAST value seen per window (freshest frame) —
  // same repaint hazard as parseAgyUsage.
  const byWindow = new Map();
  for (const m of str.matchAll(/(weekly|monthly) limit:\s*([\d.]+)\s*%/gi)) {
    byWindow.set(m[1].toLowerCase(), Math.round(parseFloat(m[2])));
  }
  if (!byWindow.size) return { limits: [] };
  const resets = [...str.matchAll(/next reset:\s*([A-Za-z0-9 ,:]+?)(?:\s{2,}|$)/gi)];
  const resetsAt = resets.length ? resets[resets.length - 1][1].trim() : null;
  const limits = [...byWindow].map(([window, percentUsed]) => ({
    key: window,
    label: GROK_WINDOWS[window].label,
    scope: GROK_WINDOWS[window].scope,
    model: null,
    percentUsed,
    percentRemaining: Math.max(0, 100 - percentUsed),
    // Grok gives a local-time date string without a year/zone; pass it through
    // verbatim (the UI renders non-ISO reset strings as-is).
    resetsAt,
    timezone: null,
  }));
  return { limits };
}

/**
 * Pick the enabled provider to actually drive for a TUI scrape: a `tui` or `cli`
 * process provider, never an `api` provider. The `/usage` panel is a property of
 * the local CLI/TUI, not the OpenAI-compatible API endpoint — an install that
 * enables only the API provider (e.g. the built-in `grok` API, matched by id)
 * has no scrapeable surface and no `command` to spawn, so return null and let
 * the fetcher report it unsupported rather than launching an unrelated binary.
 *
 * A `tui`-type provider is preferred over a `cli`-type one (and within a type,
 * the one whose command basename is `binary`): a TUI provider is configured for
 * interactive use, so its `args` are safe to forward, whereas a CLI provider's
 * args are one-shot/headless flags that would break the interactive `/usage`.
 */
function pickScrapeProvider(providers, binary) {
  const cliTui = (providers || []).filter((p) => p?.type === 'cli' || p?.type === 'tui');
  const byBinary = (list) => list.find((p) => commandBasename(p.command) === binary) || list[0];
  const tui = cliTui.filter((p) => p.type === 'tui');
  const cli = cliTui.filter((p) => p.type === 'cli');
  return byBinary(tui) || byBinary(cli) || null;
}

/**
 * Build a family `fetch` fn that scrapes a TUI `/usage` panel and maps it to the
 * common quota shape (cached; `refresh` bypasses). It drives the matched
 * provider's configured `command` (falling back to `binary`) and `envVars`, so
 * an absolute-path or env-authenticated provider scrapes with the same
 * invocation a normal run uses. `parse` returns `{ limits }`; an empty result
 * becomes a `supported`-but-`error` card so the UI shows a soft warning rather
 * than a blank card. `name` is the human product name spliced into the copy.
 */
function makeTuiUsageFetcher({ id, binary, slashCommand, label, parse, name, readyMarker }) {
  return ({ refresh = false, providers = [] } = {}) => {
    const base = { family: id, label, plan: null, activity: [], approximate: true, fetchedAt: new Date().toISOString() };
    const provider = pickScrapeProvider(providers, binary);
    // No CLI/TUI provider (e.g. only the API provider is enabled) → unsupported.
    // Returned OUTSIDE cachedScrape so it is NOT cached: enabling the CLI later
    // must take effect on the next load, not be masked by a 5-min stale "off".
    if (!provider) {
      return Promise.resolve({ ...base, supported: false, limits: [], note: `${name} usage is read from the local CLI/TUI — enable the ${name} to see quota (the API provider has no queryable usage surface).` });
    }
    const command = provider.command || binary;
    // Args are forwarded ONLY for a `tui`-type provider — those are interactive
    // args (a wrapper script path, `--project <id>`, etc.). A `cli`-type
    // provider's args are one-shot/headless flags (`-p`, `exec -`, `--print`,
    // `--prompt-file`) that would break the interactive TUI `/usage` needs.
    const args = provider.type === 'tui' && Array.isArray(provider.args) ? provider.args : [];
    // The TUI renders reset times in its own timezone; a server under PM2 runs
    // in UTC, so pass the machine's real zone (as claudeCodeUsage.js does) or
    // Grok's zoneless "Next reset" is off for non-UTC installs.
    const tz = systemTimeZone();
    const env = { ...(provider.envVars || {}), ...(tz ? { TZ: tz } : {}) };
    // Key the cache by the resolved invocation, not just the family id — so a
    // provider edit (different account via envVars, tui↔cli switch, arg change)
    // doesn't serve the previous account's quota from a stale entry.
    const cacheKey = `${id}:${command}:${provider.type}:${JSON.stringify(env)}:${JSON.stringify(args)}`;
    return cachedScrape(cacheKey, { refresh }, async () => {
      const text = await scrapeTuiUsage({ command, args, slashCommand, env, readyMarker });
      const { limits } = parse(text);
      return limits.length
        ? { ...base, supported: true, limits, note: `Scraped from the ${name} /usage panel — local, approximate.` }
        : { ...base, supported: true, limits: [], error: `No quota data found in the ${name} /usage panel.` };
    });
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
    fetch: makeTuiUsageFetcher({ id: 'agy', binary: 'agy', slashCommand: '/usage', label: 'Antigravity', parse: parseAgyUsage, name: 'Antigravity CLI', readyMarker: /Weekly Limit|Five Hour Limit|Models & Quota/i })
  },
  {
    id: 'grok',
    label: 'Grok',
    matches: (p) => isGrokCommand(p.command) || /grok/i.test(p.id || ''),
    fetch: makeTuiUsageFetcher({ id: 'grok', binary: 'grok', slashCommand: '/usage show', label: 'Grok', parse: parseGrokUsage, name: 'Grok Build CLI', readyMarker: /(Weekly|Monthly) limit:/i })
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

const fetchFamilyQuota = (family, { refresh, providers }) =>
  Promise.resolve(family.fetch({ refresh, providers })).catch((err) => ({
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
 * as `error` entries. Each family fetch receives the enabled providers that
 * matched it, so TUI-scrape adapters drive the actual configured provider
 * (command + envVars), not a hardcoded binary.
 */
export async function getProviderQuotas({ refresh = false } = {}) {
  const result = await getAllProviders();
  const providers = Array.isArray(result) ? result : (result?.providers || []);
  const enabled = providers.filter((p) => p?.enabled && p.ollamaBacked !== true);
  const families = resolveEnabledFamilies(providers);
  return Promise.all(families.map((family) =>
    fetchFamilyQuota(family, { refresh, providers: enabled.filter((p) => family.matches(p)) })));
}
