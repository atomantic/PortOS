// Plumbing shared by the autofixer's two PM2-managed processes — `server.js`
// (the repair loop) and `ui.js` (the dashboard). Kept package-local and
// dependency-light (node builtins only): PortOS's own `server/services/pm2.js`
// has an equivalent `execPm2`, but importing it here would drag the whole
// server dependency graph into a package whose package.json declares only
// express.
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve PM2 binary to avoid pm2.cmd on Windows (creates visible CMD windows)
const require = createRequire(import.meta.url);
export const PM2_BIN = join(dirname(require.resolve('pm2/package.json')), 'bin', 'pm2');

/** Execute a PM2 CLI command via node (bypasses pm2.cmd) */
export function execPm2(pm2Args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PM2_BIN, ...pm2Args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `pm2 exited with code ${code}`));
      resolve({ stdout, stderr });
    });
    child.on('error', reject);
  });
}

// Paths. Resolved from THIS module's location (both consumers are siblings in
// `autofixer/`), so every process agrees on one `data/` directory.
export const DATA_DIR = join(__dirname, '../data');
export const APPS_FILE = join(DATA_DIR, 'apps.json');
export const AUTOFIXER_DIR = join(DATA_DIR, 'autofixer');
export const INDEX_FILE = join(AUTOFIXER_DIR, 'index.json');

// Load apps from PortOS
export async function loadApps() {
  const data = await readFile(APPS_FILE, 'utf8').catch(() => '{"apps":{}}');
  const parsed = JSON.parse(data);
  return Object.entries(parsed.apps || {}).map(([id, app]) => ({ id, ...app }));
}
