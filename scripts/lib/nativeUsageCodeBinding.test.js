import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyNativeUsageCode } from './nativeUsageCodeBinding.js';

let root;
let commit;
const git = (...args) => execFileSync('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
const sources = ['package-lock.json', 'server/package-lock.json', 'client/package-lock.json', 'autofixer/package-lock.json',
  'server/scripts/init-db.sql', 'server/lib/db.js', 'server/lib/databaseMaintenanceSchema.js',
  'scripts/lib/migrationFiles.js', 'scripts/run-migrations.js', 'server/scripts/run-db-migrations.js',
  'scripts/migrations/001-example.js', 'server/scripts/db-migrations/001-example.sql'];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'native-code-test-'));
  for (const name of sources) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), name.endsWith('.json') ? '{}\n' : '// example\n');
  }
  git('init', '--quiet'); git('add', '.'); git('commit', '--quiet', '-m', 'Synthetic checkout');
  commit = git('rev-parse', 'HEAD');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'linux')('detached committed checkout binding', () => {
  it('binds actual tracked bytes and exact runner-selected migrations without claiming installed dependencies', async () => {
    const before = await readFile(join(root, 'server/lib/db.js'));
    const result = await verifyNativeUsageCode(commit, root);
    expect(result).toMatchObject({ manifest: { commit, tree: git('rev-parse', 'HEAD^{tree}'), trackedBlobsVerified: sources.length,
      gitlinkContentsVerified: false, installedDependenciesVerified: false, matchedRuntimeVerified: false },
      fileMigrationIds: ['001-example.js'], databaseMigrationIds: ['001-example.sql'] });
    expect(Object.values(result.manifest.lockfiles)).toHaveLength(4);
    expect(Object.values(result.manifest.lockfiles).every(hash => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    expect(await readFile(join(root, 'server/lib/db.js'))).toEqual(before);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('refuses an operator-supplied commit label that is not this checkout', async () => {
    await expect(verifyNativeUsageCode('a'.repeat(40), root)).rejects.toThrow('code-commit-mismatch');
  });

  it('accepts only the committed CRLF checkout conversion and hashes its actual bytes', async () => {
    await writeFile(join(root, '.gitattributes'), '*.cmd text eol=crlf\n');
    await writeFile(join(root, 'exec.cmd'), '%*\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'Declare Windows command endings');
    commit = git('rev-parse', 'HEAD');
    await rm(join(root, 'exec.cmd')); git('checkout', '--', 'exec.cmd');
    expect(await readFile(join(root, 'exec.cmd'), 'utf8')).toBe('%*\r\n');
    const { manifest } = await verifyNativeUsageCode(commit, root);
    expect(manifest.crlfConversionsVerified).toBe(1);
    expect(manifest.checkoutBytesSha256).toMatch(/^[a-f0-9]{64}$/);
    git('update-index', '--assume-unchanged', 'exec.cmd');
    await writeFile(join(root, 'exec.cmd'), '%x\r\n');
    await expect(verifyNativeUsageCode(commit, root)).rejects.toThrow('code-file-bytes-mismatch');
  });

  it('refuses local attributes or filters as authority for different source bytes', async () => {
    await writeFile(join(root, 'exec.cmd'), '%*\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'Add unconverted command');
    commit = git('rev-parse', 'HEAD');
    await writeFile(join(root, '.git/info/attributes'), 'exec.cmd text eol=crlf filter=example\n');
    const marker = join(root, '.git', 'filter-ran');
    git('config', 'filter.example.clean', `touch ${JSON.stringify(marker)}; cat`);
    await writeFile(join(root, 'exec.cmd'), '%*\r\n');
    await expect(verifyNativeUsageCode(commit, root)).rejects.toThrow('code-local-attributes-unsupported');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not trust assume-unchanged for tracked source or lock bytes', async () => {
    git('update-index', '--assume-unchanged', 'server/package-lock.json');
    await writeFile(join(root, 'server/package-lock.json'), '[]\n');
    expect(git('status', '--porcelain')).toBe('');
    await expect(verifyNativeUsageCode(commit, root)).rejects.toThrow('code-file-bytes-mismatch');
  });

  it('refuses an extra executable migration even when it is ignored by git', async () => {
    await writeFile(join(root, '.git/info/exclude'), '\nserver/scripts/db-migrations/002-extra.sql\n');
    await writeFile(join(root, 'server/scripts/db-migrations/002-extra.sql'), 'SELECT 1;');
    await expect(verifyNativeUsageCode(commit, root)).rejects.toThrow('code-migration-inventory-invalid');
  });

  it('does not follow a parent-directory link in place of tracked code', async () => {
    const saved = join(root, 'saved-source');
    await mkdir(saved);
    await writeFile(join(saved, 'db.js'), '// example\n');
    await writeFile(join(saved, 'databaseMaintenanceSchema.js'), '// example\n');
    await rm(join(root, 'server/lib'), { recursive: true });
    await symlink(saved, join(root, 'server/lib'));
    await expect(verifyNativeUsageCode(commit, root)).rejects.toThrow(/code-checkout-not-clean|code-directory-invalid/);
  });
});
