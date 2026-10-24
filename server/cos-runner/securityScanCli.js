import { readFile, readdir, realpath, stat } from 'fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { isPathAtOrInsideDir } from '../lib/pathContainment.js';

async function packageCli(directory, expectedEntry) {
  const pkg = await readFile(join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
  const bin = pkg?.bin?.['codex-security'];
  if (pkg?.name !== '@openai/codex-security' || typeof bin !== 'string') return null;
  if (!isPathAtOrInsideDir(directory, resolve(directory, bin))) return null;
  const [packageRoot, entry] = await Promise.all([
    realpath(directory).catch(() => null), realpath(resolve(directory, bin)).catch(() => null),
  ]);
  if (!packageRoot || !entry || !isPathAtOrInsideDir(packageRoot, entry) || (expectedEntry && entry !== expectedEntry)) return null;
  if (!(await stat(entry).catch(() => null))?.isFile()) return null;
  return { command: process.execPath, args: [entry], version: pkg.version };
}

// Inspect metadata without invoking npm, a PATH launcher, or the scanner.
// Global npm installs expose a symlink to the package's declared bin entry.
export async function resolveInstalledSecurityScanner({ home = homedir(), root = process.cwd(), environment = process.env } = {}) {
  const local = await packageCli(join(root, 'node_modules/@openai/codex-security'));
  if (local) return local;

  for (const directory of new Set((environment.PATH || '').split(delimiter).filter(isAbsolute))) {
    const entry = await realpath(join(directory, 'codex-security')).catch(() => null);
    if (!entry) continue;
    let parent = dirname(entry);
    while (true) {
      const cli = await packageCli(parent, entry);
      if (cli) return cli;
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }

  const cache = join(home, '.npm/_npx');
  for (const name of (await readdir(cache).catch(() => [])).sort()) {
    if (!/^[a-f0-9]+$/.test(name)) continue;
    const cli = await packageCli(join(cache, name, 'node_modules/@openai/codex-security'));
    if (cli) return cli;
  }
  return null;
}
