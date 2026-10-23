/** Preserve shared branch configuration, reflogs and objects before retirement.
 * Worktree-private archives do not cover logs/refs/heads, which Git removes
 * with the branch. This leaf also covers branches that have no checkout.
 */
import { lstat, readFile, chmod, open, unlink, rename, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { execGit } from './execGit.js';
import { PATHS } from './paths.js';
import { ensureDir, sha256File, writeFileGuarded } from './fileCore.js';

const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
const MAX_RECOVERY_HEADS = 1024;
const git = (repoPath, args) => execGit(args, repoPath).then(result => result.stdout.trim());
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function readEvidence(path) {
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { bytes: null, identity: null };
  if (!info.isFile() || info.size > MAX_EVIDENCE_BYTES) throw new Error('branch retirement evidence cannot be archived');
  const bytes = await readFile(path);
  const identity = {
    dev: info.dev, ino: info.ino, mode: info.mode, size: info.size,
    mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, sha256: digest(bytes),
  };
  return { bytes, identity };
}

const unchanged = (left, right) => JSON.stringify(left.identity) === JSON.stringify(right.identity);

// Included/global/worktree settings cannot be retired by editing the shared
// config. Refuse them rather than leave a reused name with inherited settings.
async function branchConfiguration(repoPath, branch) {
  const pattern = `^branch\\.${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[^.]+$`;
  const query = async scope => {
    const result = await execGit(['config', '--null', '--show-origin', ...scope, '--get-regexp', pattern], repoPath, { ignoreExitCode: true });
    if (![0, 1].includes(result.exitCode)) throw new Error('branch configuration cannot be read');
    return result.stdout;
  };
  const local = await query(['--local', '--no-includes']);
  if (local !== await query(['--includes'])) throw new Error('branch configuration has an external source');
  return local;
}

async function withNativeLock(path, bytes, work) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  const owned = await readEvidence(path);
  try { return await work(owned); }
  finally {
    // Never remove a replaced or modified lock belonging to another writer.
    const current = await readEvidence(path);
    if (current.bytes && unchanged(current, owned)) await unlink(path);
  }
}

export async function preserveBranchRetirement(repoPath, commonGitDir, branch, expectedHead, { cosDir = PATHS.cos } = {}) {
  const storage = await execGit(['config', '--get', 'extensions.refStorage'], repoPath, { ignoreExitCode: true });
  if ((storage.exitCode !== 0 && storage.exitCode !== 1) || (storage.stdout.trim() && storage.stdout.trim() !== 'files')) {
    throw new Error('branch reflog storage is unsupported');
  }
  const ref = `refs/heads/${branch}`;
  if (await git(repoPath, ['rev-parse', '--verify', ref]) !== expectedHead) throw new Error('branch head changed');
  const source = join(commonGitDir, 'logs', 'refs', 'heads', ...branch.split('/'));
  const before = await readEvidence(source);
  const configPath = join(commonGitDir, 'config');
  const config = await readEvidence(configPath);
  if (!config.bytes) throw new Error('shared branch configuration is missing');
  const settings = await branchConfiguration(repoPath, branch);
  const recoveryHeads = new Set([expectedHead]);
  for (const line of (before.bytes?.toString('utf8') || '').split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?) ([a-f0-9]{40}(?:[a-f0-9]{24})?) /.exec(line);
    if (!match) throw new Error('branch reflog entry cannot be preserved');
    for (const head of match.slice(1)) if (!/^0+$/.test(head)) recoveryHeads.add(head);
  }
  if (recoveryHeads.size > MAX_RECOVERY_HEADS) throw new Error('too many branch recovery objects');
  const id = randomUUID();
  const archiveDir = join(cosDir, 'branch-retirement-archives', id);
  await ensureDir(archiveDir);
  await chmod(archiveDir, 0o700);
  // Keep the original bytes, including duplicate values and formatting. Both
  // copies are private; the prepared copy lets Git remove precisely its section.
  const configCopy = join(archiveDir, 'config');
  const retiredCopy = join(archiveDir, 'config.retired');
  await writeFileGuarded(configCopy, config.bytes, { flag: 'wx', mode: 0o600 });
  await writeFileGuarded(retiredCopy, config.bytes, { flag: 'wx', mode: 0o600 });
  if (settings) await git(repoPath, ['config', '--file', retiredCopy, '--remove-section', `branch.${branch}`]);
  await chmod(retiredCopy, 0o600);
  const retiredConfig = await readFile(retiredCopy);
  const retiredSha256 = digest(retiredConfig);
  if (before.bytes) {
    const copy = join(archiveDir, 'reflog');
    await writeFileGuarded(copy, before.bytes, { flag: 'wx', mode: 0o600 });
    if (digest(await readFile(copy)) !== before.identity.sha256) throw new Error('branch reflog archive mismatch');
  }
  const bundle = join(archiveDir, 'commits.bundle');
  const recoveryRefs = [];
  try {
    for (const head of recoveryHeads) {
      if (await git(repoPath, ['cat-file', '-t', head]) !== 'commit') throw new Error('branch recovery object is not a commit');
      const recoveryRef = `refs/portos/branch-archive/${id}/${head}`;
      await git(repoPath, ['update-ref', recoveryRef, head, '']);
      recoveryRefs.push({ ref: recoveryRef, head });
    }
    await git(repoPath, ['bundle', 'create', bundle, ...recoveryRefs.map(entry => entry.ref)]);
    await git(repoPath, ['bundle', 'verify', bundle]);
    const heads = await git(repoPath, ['bundle', 'list-heads', bundle]);
    const bundled = new Set(heads.split('\n').map(line => line.split(' ')[0]));
    if ([...recoveryHeads].some(head => !bundled.has(head))) throw new Error('branch bundle recovery head mismatch');
  } finally {
    for (const entry of recoveryRefs) await git(repoPath, ['update-ref', '-d', entry.ref, entry.head]);
  }
  await chmod(bundle, 0o600);
  const bundleSha256 = await sha256File(bundle);
  const manifestPath = join(archiveDir, 'manifest.json');
  const manifest = `${JSON.stringify({
    version: 2, repoPath, commonGitDir, branch, expectedHead, archivedAt: new Date().toISOString(),
    reflog: { present: before.bytes !== null, source, identity: before.identity },
    configuration: { source: configPath, identity: config.identity, retiredSha256,
      restore: 'Inspect config and restore only the archived branch section into the current repository configuration.' },
    recoveryHeads: [...recoveryHeads], bundleSha256,
    restore: 'git -C <repo> fetch <archive>/commits.bundle refs/portos/branch-archive/<archive-id>/<head>:refs/heads/<restored-branch>',
  }, null, 2)}\n`;
  await writeFileGuarded(manifestPath, manifest, { flag: 'wx', mode: 0o600 });
  const verifyConfig = async () => unchanged(await readEvidence(configPath), config)
    && await branchConfiguration(repoPath, branch) === settings;
  const verifyArchive = () => Promise.all([
    sha256File(bundle), readFile(manifestPath, 'utf8'),
    before.bytes ? sha256File(join(archiveDir, 'reflog')) : null,
    sha256File(configCopy), sha256File(retiredCopy),
  ]).then(([bundleHash, currentManifest, reflogHash, configHash, retiredHash]) =>
    bundleHash === bundleSha256 && currentManifest === manifest
    && (!before.bytes || reflogHash === before.identity.sha256)
    && configHash === config.identity.sha256 && retiredHash === retiredSha256).catch(() => false);
  const verify = () => Promise.all([
    git(repoPath, ['rev-parse', '--verify', ref]), readEvidence(source), verifyConfig(), verifyArchive(),
  ]).then(([head, current, configValid, archiveValid]) =>
    head === expectedHead && unchanged(current, before) && configValid && archiveValid).catch(() => false);
  if (!await verify()) throw new Error('branch reflog or archive changed during archival');
  const retire = deleteRef => withNativeLock(`${configPath}.lock`, retiredConfig, async configLock => {
    if (!await verify() || !await deleteRef()) return false;
    // The receiver's lease and holder checks remain authoritative for deletion.
    // Afterwards lock the absent ref so a native Git writer cannot recreate it
    // between the final incarnation check and the configuration rename.
    const refPath = join(commonGitDir, ...ref.split('/'));
    await mkdir(dirname(refPath), { recursive: true });
    return withNativeLock(`${refPath}.lock`, Buffer.alloc(0), async () => {
      const absent = await execGit(['show-ref', '--verify', '--quiet', ref], repoPath, { ignoreExitCode: true });
      const holders = await git(repoPath, ['worktree', 'list', '--porcelain', '-z']);
      if (absent.exitCode !== 1 || (await readEvidence(refPath)).bytes !== null
        || holders.split('\0').includes(`branch ${ref}`) || !await verifyArchive() || !await verifyConfig()
        || !unchanged(await readEvidence(`${configPath}.lock`), configLock)) return false;
      if (settings) {
        await chmod(`${configPath}.lock`, config.identity.mode & 0o777);
        await rename(`${configPath}.lock`, configPath);
      }
      return true;
    });
  });
  return { archiveDir, verify, retire };
}
