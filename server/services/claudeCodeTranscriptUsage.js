import { createReadStream } from 'fs';
import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { PATHS } from '../lib/fileUtils.js';
import { POLLUTING_KEYS, bucketFor } from '../lib/objects.js';
import { createNativeUsageStore } from './nativeUsageStore.js';

/**
 * Per-model token usage for EVERY Claude Code session on this machine —
 * including ones PortOS never spawned — read from the CLI's own transcripts
 * (`~/.claude/projects/**\/*.jsonl`, subagent sidechains included).
 *
 * The CLI has no structured usage endpoint, but each assistant line carries
 * `timestamp`, `message.model`, and `message.usage`. Two hazards:
 *  - a streamed response is logged on several lines with growing counts, and
 *    resumed/forked sessions replay earlier history into a new file, so lines
 *    are de-duplicated by `message.id` + `requestId` (the largest output wins,
 *    with a stopped emission preferred when output counts tie);
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
// An incremental refresh re-reads recent days only; a first run reads all.
const REFRESH_LOOKBACK_DAYS = 3;
const REFRESH_STALE_MS = 5 * 60_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
    if (row.type !== 'assistant' || !usage || !message.model || message.model === SYNTHETIC_MODEL || POLLUTING_KEYS.has(message.model)) continue;
    const day = String(row.timestamp).slice(0, 10);
    if (!DAY_RE.test(day) || (from && day < from)) continue;
    const key = message.id ? `${message.id}:${row.requestId || ''}` : row.uuid;
    if (!key) continue;
    const previous = seen.get(key);
    const candidate = {
      day,
      model: message.model,
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
      stopped: Boolean(message.stop_reason)
    };
    if (!previous
      || candidate.output > previous.output
      || (candidate.output === previous.output && candidate.stopped && !previous.stopped)) {
      seen.set(key, candidate);
    }
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
    if (POLLUTING_KEYS.has(entry.model)) continue;
    const dayBucket = bucketFor(days, entry.day, () => ({}));
    if (!dayBucket) continue;
    const row = bucketFor(dayBucket, entry.model, zeroCounts);
    if (!row) continue;
    row.messages += 1;
    for (const f of FIELDS) if (f !== 'messages') row[f] += entry[f];
  }
  return { days, filesScanned: files.length };
}

const store = createNativeUsageStore({
  family: 'claude',
  file: TRANSCRIPT_USAGE_FILE,
  fields: FIELDS,
  // Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30).
  retentionDays: 30,
  lookbackDays: REFRESH_LOOKBACK_DAYS,
  staleMs: REFRESH_STALE_MS,
  scan: scanTranscriptDays,
});
export const claudeNativeUsageStore = store;

/**
 * Rebuild a day → model → counts map to the known shape, dropping anything
 * else. Used for both the stored file and peer-supplied digests, so depth and
 * size are fixed by construction.
 */
export const sanitizeTranscriptDays = (raw) => store.sanitize(raw);

/**
 * The persisted local store: `{ days, updatedAt, coverageStart }` (`updatedAt`
 * null before the first scan). Throws when the file exists but is unreadable.
 */
export const readLocalTranscriptUsage = () => store.read();

/**
 * Fold a fresh scan into the persisted store. The first run reads every
 * transcript on disk; later runs re-read only the last few days. Skipped when
 * the store is younger than `staleMs` unless `force`.
 */
export const refreshLocalTranscriptUsage = (options) => store.refresh(options);
