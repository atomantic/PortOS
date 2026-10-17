// Plumbing shared by the autofixer's two PM2-managed processes — `server.js`
// (the repair loop) and `ui.js` (the dashboard). Kept package-local and
// dependency-light (node builtins only): PortOS's own `server/services/pm2.js`
// has an equivalent `execPm2`, but importing it here would drag the whole
// server dependency graph into a package whose package.json declares only
// express. `server/lib/pm2Jlist.js` is the one exception: a pure, zero-import
// leaf, so importing it costs nothing this package needs to stay light about.
import { spawn } from 'child_process';
import { waitForChild, COMMAND_TIMEOUT_MS } from './childProcess.js';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { parsePm2JlistStdout } from '../server/lib/pm2Jlist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve PM2 binary to avoid pm2.cmd on Windows (creates visible CMD windows)
const require = createRequire(import.meta.url);
export const PM2_BIN = join(dirname(require.resolve('pm2/package.json')), 'bin', 'pm2');

/** Execute a PM2 CLI command via node (bypasses pm2.cmd) */
export async function execPm2(pm2Args, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  // Package resolution can succeed while the PM2 entry point is a dangling link.
  if (!existsSync(PM2_BIN)) {
    throw new Error(`PM2 binary not found at ${PM2_BIN} — run "npm install" in the repo root`);
  }
  const child = spawn(process.execPath, [PM2_BIN, ...pm2Args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = await waitForChild(child, { timeoutMs });
  if (result.timedOut) {
    throw Object.assign(new Error(`pm2 ${pm2Args.join(' ')} timed out after ${timeoutMs / 1000}s; CLI cleanup ${result.cleanupConfirmed ? 'confirmed' : 'unconfirmed'}, daemon outcome unknown`), {
      code: 'PM2_TIMEOUT', timedOut: true, cleanupConfirmed: result.cleanupConfirmed, outcome: 'unknown',
    });
  }
  if (result.error) throw result.error;
  if (result.code !== 0) throw new Error(result.stderr || `pm2 exited with code ${result.code}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * Strict PM2 process list: the one non-test reader both `server.js` and
 * `ui.js` share, so a failed read never masquerades as zero processes.
 *
 * `null` = the read FAILED (spawn/exit failure, or stdout with no real array
 * literal — see `parsePm2JlistStdout`); an array (incl. `[]`) = a successful
 * read. Callers must not collapse `null` into `[]`: the repair daemon skips
 * its cycle instead of reporting "no PM2 processes found", and the dashboard
 * API answers 503 instead of an empty list (issue #8164).
 *
 * @returns {Promise<Array|null>}
 */
export async function listProcessesStrict() {
  const { stdout } = await execPm2(['jlist']).catch(() => ({ stdout: '' }));
  return parsePm2JlistStdout(stdout);
}

// Paths. Resolved from THIS module's location (both consumers are siblings in
// `autofixer/`), so every process agrees on one `data/` directory.
export const DATA_DIR = join(__dirname, '../data');
export const APPS_FILE = join(DATA_DIR, 'apps.json');
export const AUTOFIXER_DIR = join(DATA_DIR, 'autofixer');
export const INDEX_FILE = join(AUTOFIXER_DIR, 'index.json');

export async function loadApps() {
  try {
    const parsed = JSON.parse(await readFile(APPS_FILE, 'utf8'));
    return Object.entries(parsed.apps || {}).map(([id, app]) => ({ id, ...app }));
  } catch (error) {
    // A not-yet-created registry remains a valid empty installation.
    if (error.code === 'ENOENT') return [];
    // File paths, parser excerpts and read errors may contain private data.
    throw Object.assign(new Error('App registry unavailable'), { code: 'APPS_UNAVAILABLE' });
  }
}
