/** Enumerate the collection fixture's indexed source paths and validate the working files it copies. */
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE_ROOTS = ['server', 'lib'];
const INDEX_ENTRY = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/;

function isCollectionFixtureSource(file) {
  return SOURCE_ROOTS.some(root => file.startsWith(root + '/'))
    && file !== 'lib/slashdo' && !file.endsWith('.test.js') && !file.endsWith('.test.jsx');
}

/** Git supplies membership. The fixture copies current working files, including uncommitted edits. */
export function collectionFixtureSources(repoRoot = ROOT) {
  const root = realpathSync(repoRoot);
  // A launch from a wrapper must not substitute a different repository or index.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_OPTIONAL_LOCKS = '0';
  const git = args => execFileSync('git', args, { cwd: root, env, timeout: 15000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const top = decode(git(['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
  if (realpathSync(top) !== root) throw new Error('Collection fixture requires a checkout root');
  const version = decode(git(['--version'])).trimEnd();
  const index = decode(git(['--literal-pathspecs', 'ls-files', '--cached', '--stage', '-z', '--', ...SOURCE_ROOTS]));
  if (!version || (index && !index.endsWith('\0'))) throw new Error('Invalid collection fixture git response');
  const entries = [];
  const directories = new Set();
  for (const item of index.split('\0').slice(0, -1)) {
    const match = INDEX_ENTRY.exec(item);
    if (!match) throw new Error('Invalid collection fixture index entry');
    const [, indexMode, oid, stage, file] = match;
    if (!isCollectionFixtureSource(file)) continue;
    const parts = file.split('/');
    if (stage !== '0' || !['100644', '100755'].includes(indexMode)
        || /[\\:]/.test(file) || parts.some(part => part === '' || part === '.' || part === '..')) {
      throw new Error('Unsupported collection fixture index entry');
    }
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      if (directories.has(parent)) continue;
      if (!lstatSync(parent).isDirectory()) throw new Error('Collection fixture source directories must be physical');
      directories.add(parent);
    }
    const source = join(root, file);
    const info = lstatSync(source);
    if (!info.isFile()) throw new Error('Fixture source must contain regular files');
    entries.push({ file, source, indexMode, oid, mode: info.mode });
  }
  return { version, entries };
}
