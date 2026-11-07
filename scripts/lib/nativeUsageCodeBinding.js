/** Bind supplied backup evidence to this checkout, without executing its migrations. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nativeUsageCanonicalJson } from '../../server/lib/nativeUsageContract.js';
import { refuseNativeUsageRehearsal as refuse } from '../../server/lib/nativeUsageRehearsal.js';
import { inspectNativeUsageRegular } from './nativeUsageSnapshot.js';
import { scanDatabaseMigrationFiles, scanMigrationFiles } from './migrationFiles.js';

const execute = promisify(execFile);
const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOCKS = { root: 'package-lock.json', server: 'server/package-lock.json', client: 'client/package-lock.json', autofixer: 'autofixer/package-lock.json' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const same = (a, b) => nativeUsageCanonicalJson(a) === nativeUsageCanonicalJson(b);

async function git(root, args) {
  return execute('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', ...args], {
    cwd: root, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
    encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
  }).then(result => result.stdout, () => refuse('code-checkout-unreadable'));
}

async function assertCleanIndexAndInventory(root) {
  // Both commands inspect names/index objects only. A worktree status/diff
  // can run configured clean filters while refreshing its stat cache.
  if ((await git(root, ['diff-index', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])).length
    || (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).length) refuse('code-checkout-not-clean');
}

// Git stores LF but this repository explicitly checks Windows command shims
// out as CRLF. Consult committed attributes only; never run a clean filter.
async function committedCrlfMatches(root, commit, name, bytes, oid) {
  const infoPath = (await git(root, ['rev-parse', '--git-path', 'info/attributes'])).trim();
  const hasLocalAttributes = await lstat(resolve(root, infoPath)).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  if (hasLocalAttributes) refuse('code-local-attributes-unsupported');
  const fields = (await git(root, ['check-attr', `--source=${commit}`, '-z', 'text', 'eol', 'filter', 'working-tree-encoding', 'ident', '--', name])).split('\0');
  const attributes = {};
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index] !== name) refuse('code-attributes-invalid');
    attributes[fields[index + 1]] = fields[index + 2];
  }
  if (attributes.text !== 'set' || attributes.eol !== 'crlf'
    || ['filter', 'working-tree-encoding', 'ident'].some(key => !['unspecified', 'unset'].includes(attributes[key]))) return false;
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || !text.includes('\r\n')) return false;
  const normalized = Buffer.from(text.replaceAll('\r\n', '\n'));
  // Mixed line endings are not the declared checkout conversion either.
  return Buffer.from(normalized.toString('utf8').replaceAll('\n', '\r\n')).equals(bytes) && blobHash(normalized) === oid;
}

/** The CLI always uses CODE_ROOT. A root argument is for detached fixture tests. */
export async function verifyNativeUsageCode(commit, root = CODE_ROOT) {
  if (!/^[a-f0-9]{40}$/.test(commit)) refuse('code-commit-invalid');
  if (!(await lstat(root)).isDirectory()) refuse('code-checkout-invalid');
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (head !== commit) refuse('code-commit-mismatch');
  await assertCleanIndexAndInventory(root);
  const tree = (await git(root, ['rev-parse', '--verify', 'HEAD^{tree}'])).trim();
  if (!/^[a-f0-9]{40}$/.test(tree)) refuse('code-tree-invalid');
  const entries = (await git(root, ['ls-tree', '-r', '-z', '--full-tree', commit])).split('\0').filter(Boolean);
  if (!entries.length || entries.length > 100000) refuse('code-inventory-invalid');
  const budget = { bytes: 1024 ** 3, deadline: Date.now() + 5 * 60_000 };
  const files = new Map();
  const directories = new Map();
  let gitlinks = 0;
  let crlfConversions = 0;
  for (const entry of entries) {
    if (budget.bytes < 0 || Date.now() >= budget.deadline) refuse('code-read-budget-exceeded');
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) refuse('code-inventory-invalid');
    const [, mode, type, oid, name] = match;
    if (name.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f:]/.test(name)) refuse('code-path-invalid');
    if (mode === '160000' && type === 'commit') { gitlinks++; continue; }
    if (type !== 'blob' || mode === '160000') refuse('code-inventory-invalid');
    const parts = name.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const ancestor = parts.slice(0, depth).join('/');
      if (!directories.has(ancestor)) {
        const info = await lstat(join(root, ancestor));
        if (!info.isDirectory()) refuse('code-directory-invalid');
        directories.set(ancestor, info);
      }
    }
    const path = join(root, name);
    const before = await lstat(path);
    let bytes;
    if (mode === '120000') {
      if (!before.isSymbolicLink() || before.size > 16384 || before.size > budget.bytes) refuse('code-symlink-invalid');
      bytes = Buffer.from(await readlink(path));
      const after = await lstat(path);
      if (!after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) refuse('code-input-changed');
      budget.bytes -= bytes.length;
    } else {
      if (Boolean(before.mode & 0o111) !== (mode === '100755')) refuse('code-file-mode-mismatch');
      bytes = (await inspectNativeUsageRegular(path, { collect: true, budget })).bytes;
    }
    // Read actual bytes, not git's stat cache: assume-unchanged and same-size
    // edits cannot make a mismatched source/lockfile look like committed code.
    if (blobHash(bytes) !== oid) {
      if (mode === '120000' || !await committedCrlfMatches(root, commit, name, bytes, oid)) refuse('code-file-bytes-mismatch');
      crlfConversions++;
    }
    files.set(name, { mode, sha256: hash(bytes), bytes: bytes.length });
  }
  for (const [name, before] of directories) {
    const after = await lstat(join(root, name));
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) refuse('code-input-changed');
  }
  const required = [...Object.values(LOCKS), 'server/scripts/init-db.sql', 'server/lib/db.js',
    'server/lib/databaseMaintenanceSchema.js', 'scripts/lib/migrationFiles.js',
    'scripts/run-migrations.js', 'server/scripts/run-db-migrations.js'];
  if (required.some(name => !files.has(name) || files.get(name).mode === '120000')) refuse('code-required-source-missing');
  const fileMigrationIds = await scanMigrationFiles(join(root, 'scripts/migrations'));
  const databaseMigrationIds = await scanDatabaseMigrationFiles(join(root, 'server/scripts/db-migrations'));
  for (const [prefix, ids] of [['scripts/migrations/', fileMigrationIds], ['server/scripts/db-migrations/', databaseMigrationIds]]) {
    if (!ids.length || ids.some(id => !files.has(prefix + id) || files.get(prefix + id).mode === '120000')) refuse('code-migration-inventory-invalid');
  }
  if ((await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== commit) refuse('code-input-changed');
  await assertCleanIndexAndInventory(root);
  const groupHash = predicate => hash(nativeUsageCanonicalJson([...files].filter(([name]) => predicate(name))));
  return {
    manifest: { commit, tree, evidence: 'committed-checkout-tracked-bytes', trackedBlobsVerified: files.size,
      crlfConversionsVerified: crlfConversions, checkoutBytesSha256: groupHash(() => true),
      gitlinksRecorded: gitlinks, gitlinkContentsVerified: false, installedDependenciesVerified: false,
      matchedRuntimeVerified: false, nodeVersion: process.version,
      lockfiles: Object.fromEntries(Object.entries(LOCKS).map(([role, name]) => [role, files.get(name).sha256])),
      schemaSourcesSha256: groupHash(name => name === 'server/scripts/init-db.sql' || name === 'server/lib/db.js'
        || name === 'server/lib/databaseMaintenanceSchema.js' || name.startsWith('server/lib/db/schema/')),
      fileMigrationSourcesSha256: groupHash(name => name.startsWith('scripts/migrations/') || ['scripts/run-migrations.js', 'scripts/lib/migrationLedger.js', 'scripts/lib/migrationFiles.js'].includes(name)),
      databaseMigrationSourcesSha256: groupHash(name => name.startsWith('server/scripts/db-migrations/') || ['server/scripts/run-db-migrations.js', 'scripts/lib/migrationFiles.js'].includes(name)),
    }, fileMigrationIds, databaseMigrationIds,
  };
}

/** A ledger proves recorded IDs only, never that the migration's effects exist. */
export function assertNativeUsageMigrationIds(actual, expected, scope) {
  if (!Array.isArray(actual) || actual.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|sql)$/.test(id))
    || new Set(actual).size !== actual.length || !same([...actual].sort(), expected)) refuse(`${scope}-migration-inventory-mismatch`);
}
