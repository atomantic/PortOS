import { createReadStream } from 'fs';
import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { isPlainObject } from '../lib/objects.js';
import { isNonBlankStr } from '../lib/textUtils.js';

/**
 * Per-model token usage for EVERY Claude Code session on this machine —
 * including ones PortOS never spawned — read from the CLI's own transcripts
 * (`~/.claude/projects/**\/*.jsonl`, subagent sidechains included).
 *
 * The CLI has no structured usage endpoint, but each assistant line carries
 * `timestamp`, `message.model`, and `message.usage`. Two hazards:
 *  - a streamed response is logged on several lines with growing counts, and
 *    resumed/forked sessions replay earlier history into a new file, so lines
 *    are de-duplicated by `message.id` + `requestId` (the last copy wins);
 *  - the CLI prunes old transcripts. So the scan is folded into a persisted
 *    per-day, per-model store (`data/claude-code-transcript-usage.json`) that
 *    keeps history the CLI has since deleted.
 *
 * That store is what federates: `peerUsage.js` publishes it on the `usage` sync
 * category so a fleet report can total tokens per model across machines and
 * price them at API rates. It carries model ids, day buckets and token counts
 * only — never prompts, paths or session ids.
 *
 * Scans are user- or timer-triggered file reads (no provider calls). Days are
 * UTC calendar days, matching `usageRange.js`.
 */

export const TRANSCRIPT_USAGE_FILE = join(PATHS.data, 'claude-code-transcript-usage.json');

const SYNTHETIC_MODEL = '<synthetic>';
const FIELDS = ['messages', 'input', 'output', 'cacheRead', 'cacheWrite'];
// Bounds on stored/peer-supplied maps (see the digest caps in peerUsage.js).
const MAX_DAYS = 800;
const MAX_MODELS_PER_DAY = 100;
// An incremental refresh re-reads recent days only; a first run reads all.
const REFRESH_LOOKBACK_DAYS = 3;
const REFRESH_STALE_MS = 5 * 60_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const withLock = createMutex();

const projectsRoot = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
const zeroCounts = () => Object.fromEntries(FIELDS.map((f) => [f, 0]));

async function listTranscripts(root, fromMs) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    if (fromMs == null) { files.push(path); continue; }
    // A file last written before `from` cannot hold a line in range.
    const info = await stat(path).catch(() => null);
    if (info && info.mtimeMs >= fromMs) files.push(path);
  }
  return files;
}

async function collectFile(path, from, seen) {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const message = row.message;
    const usage = message?.usage;
    if (row.type !== 'assistant' || !usage || !message.model || message.model === SYNTHETIC_MODEL) continue;
    const day = String(row.timestamp).slice(0, 10);
    if (!DAY_RE.test(day) || (from && day < from)) continue;
    const key = message.id ? `${message.id}:${row.requestId || ''}` : row.uuid;
    if (!key) continue;
    seen.set(key, {
      day,
      model: message.model,
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0
    });
  }
}

/**
 * Scan transcripts from `from` (YYYY-MM-DD, null = everything on disk) into
 * `{ days: { <day>: { <model>: counts } }, filesScanned }`.
 */
async function scanTranscriptDays({ from = null, root = projectsRoot() } = {}) {
  const files = await listTranscripts(root, from ? Date.parse(`${from}T00:00:00Z`) : null);
  const seen = new Map();
  for (const file of files) {
    // Non-strict: a transcript deleted or truncated mid-scan drops out of the
    // report rather than failing the whole read.
    await collectFile(file, from, seen).catch((err) => {
      console.warn(`⚠️ Skipped unreadable Claude Code transcript: ${err.message}`);
    });
  }
  const days = {};
  for (const entry of seen.values()) {
    const row = ((days[entry.day] ||= {})[entry.model] ||= zeroCounts());
    row.messages += 1;
    for (const f of FIELDS) if (f !== 'messages') row[f] += entry[f];
  }
  return { days, filesScanned: files.length };
}

/**
 * Rebuild a day → model → counts map to the known shape, dropping anything
 * else. Used for both the stored file and peer-supplied digests, so depth and
 * size are fixed by construction.
 */
export function sanitizeTranscriptDays(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  const dayKeys = Object.keys(raw).filter((d) => DAY_RE.test(d)).sort().slice(-MAX_DAYS);
  for (const day of dayKeys) {
    if (!isPlainObject(raw[day])) continue;
    for (const [model, counts] of Object.entries(raw[day]).slice(0, MAX_MODELS_PER_DAY)) {
      if (!isNonBlankStr(model)) continue;
      (out[day] ||= {})[model.slice(0, 200)] = Object.fromEntries(FIELDS.map((f) => [f, num(counts?.[f])]));
    }
  }
  return out;
}

// Per (day, model) field, the larger count wins: a re-scan of a day whose
// oldest transcripts were pruned must never shrink what an earlier scan saw.
function mergeDays(stored, scanned) {
  const merged = { ...stored };
  for (const [day, models] of Object.entries(scanned)) {
    const target = { ...(merged[day] || {}) };
    for (const [model, row] of Object.entries(models)) {
      const prev = target[model] || zeroCounts();
      target[model] = Object.fromEntries(FIELDS.map((f) => [f, Math.max(prev[f], row[f])]));
    }
    merged[day] = target;
  }
  return sanitizeTranscriptDays(merged);
}

// The store is read on every sync snapshot/manifest/checksum, so the sanitized
// copy is memoized against the file's identity (mtime + size) — the same idea
// as peerUsage's digest memo — instead of re-parsing and rebuilding up to
// MAX_DAYS x MAX_MODELS_PER_DAY rows per call.
let storeMemo = null;

/** The persisted local store: `{ days, updatedAt }` (`updatedAt` null before the first scan). */
export async function readLocalTranscriptUsage() {
  const info = await stat(TRANSCRIPT_USAGE_FILE).catch(() => null);
  const key = info ? `${TRANSCRIPT_USAGE_FILE}|${info.mtimeMs}|${info.size}` : null;
  if (key && storeMemo?.key === key) return storeMemo.value;
  const raw = await readJSONFile(TRANSCRIPT_USAGE_FILE, null);
  const value = {
    days: sanitizeTranscriptDays(raw?.days),
    updatedAt: isNonBlankStr(raw?.updatedAt) ? raw.updatedAt : null
  };
  storeMemo = key ? { key, value } : null;
  return value;
}

/**
 * Fold a fresh scan into the persisted store. The first run reads every
 * transcript on disk; later runs re-read only the last few days. Skipped when
 * the store is younger than `staleMs` unless `force`.
 */
export function refreshLocalTranscriptUsage({ root, force = false, staleMs = REFRESH_STALE_MS } = {}) {
  return withLock(async () => {
    const stored = await readLocalTranscriptUsage();
    const age = stored.updatedAt ? Date.now() - Date.parse(stored.updatedAt) : Infinity;
    if (!force && age < staleMs) return { ...stored, filesScanned: 0, refreshed: false };
    const from = stored.updatedAt
      ? new Date(Date.now() - REFRESH_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10)
      : null;
    const { days: scanned, filesScanned } = await scanTranscriptDays({ from, root });
    const next = { days: mergeDays(stored.days, scanned), updatedAt: new Date().toISOString() };
    await atomicWrite(TRANSCRIPT_USAGE_FILE, next);
    return { ...next, filesScanned, refreshed: true };
  });
}

/** Background keep-fresh so peers get current numbers even if the page is never opened. */
export function startTranscriptUsageRefresh({ intervalMs = 30 * 60_000, firstDelayMs = 60_000 } = {}) {
  const run = () => refreshLocalTranscriptUsage({ force: true }).catch((err) => {
    console.error(`❌ Claude Code transcript usage refresh failed: ${err.message}`);
  });
  setTimeout(run, firstDelayMs).unref();
  setInterval(run, intervalMs).unref();
}
