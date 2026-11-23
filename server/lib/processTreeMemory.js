/**
 * Resident memory of a process and all its descendants: macOS `phys_footprint`, falling back to summed RSS.
 *
 * Used for local model daemons PortOS runs under PM2 (MTPLX, llama-server, slotstream), which report
 * no footprint of their own the way Ollama's `/api/ps` does (#17430). PM2 may start a wrapper (a shell
 * script, a venv launcher) whose child holds the weights, so the whole tree is summed.
 *
 * macOS prefers `footprint`: Apple Silicon runtimes keep weights in Metal buffers, which
 * `phys_footprint` (what Activity Monitor shows) counts and RSS can miss. RSS is the
 * fallback when `footprint` is missing or unreadable, and the only source elsewhere.
 * `source` says which one produced the figure.
 *
 * Every failure resolves `null`, never `0`: an unreadable process table is "not measured".
 */
import { promisify } from 'node:util';
import { execFile } from './childProcess.js';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 10000;

/** Parse `ps -A -o pid= -o ppid= -o rss=` rows. Unparseable rows are skipped. */
export function parseProcessTable(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]) });
  }
  return rows;
}

/** `rootPid` followed by every descendant in `rows`; `[]` when the root is not in the table. */
export function processTreePids(rows, rootPid) {
  if (!rows.some((row) => row.pid === rootPid)) return [];
  const children = new Map();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

/** `pid → bytes` from the per-process headers of `footprint -f bytes --noCategories` output. */
export function parseFootprintBytes(stdout) {
  const byPid = new Map();
  for (const m of String(stdout || '').matchAll(/\[(\d+)\]:.*\bFootprint:\s*(\d+)\s*B\b/g)) byPid.set(Number(m[1]), Number(m[2]));
  return byPid;
}

/**
 * Resident bytes of `pid` and its descendants.
 *
 * @param {number} pid
 * @param {{ platform?: string, run?: (file: string, args: string[], options: object) => Promise<{stdout: string}> }} [options]
 * @returns {Promise<{ bytes: number, source: 'footprint'|'rss', pids: number }|null>}
 */
export async function readProcessTreeResidentBytes(pid, { platform = process.platform, run = execFileAsync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || platform === 'win32') return null;
  const options = { timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } };
  const table = await run('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss='], options).catch(() => null);
  const rows = parseProcessTable(table?.stdout);
  const pids = processTreePids(rows, pid);
  if (!pids.length) return null;

  const rssBytes = new Map(rows.map((row) => [row.pid, row.rssKb * 1024]));
  if (platform === 'darwin') {
    const args = [...pids.flatMap((p) => ['-p', String(p)]), '--noCategories', '-f', 'bytes'];
    const out = await run('footprint', args, options).catch(() => null);
    const footprints = parseFootprintBytes(out?.stdout);
    // `footprint` skips a pid that exited after `ps` read the table (a transient child); that
    // process keeps its RSS. Without the root's own figure, the whole reading falls back to RSS.
    if (footprints.has(pid)) {
      const bytes = pids.reduce((sum, p) => sum + (footprints.get(p) ?? rssBytes.get(p) ?? 0), 0);
      return { bytes, source: 'footprint', pids: pids.length };
    }
  }

  const bytes = pids.reduce((sum, p) => sum + (rssBytes.get(p) ?? 0), 0);
  return bytes > 0 ? { bytes, source: 'rss', pids: pids.length } : null;
}
