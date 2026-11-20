/** Compare a managed claim's root lockfile with the source checkout's install receipt. */

import { lstat, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { isDeepStrictEqual } from 'util';

const LOCKFILES = {
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
};

const readText = path => readFile(path, 'utf8').catch(() => null);

async function readCheckoutFile(path) {
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // A checkout may supply a symlink. Never read its target as a lockfile.
  return info && { text: info.isFile() ? await readText(path) : null };
}

async function declaredPackageManager(worktreePath) {
  const manifest = await readCheckoutFile(join(worktreePath, 'package.json'));
  try {
    const { packageManager } = JSON.parse(manifest?.text ?? '{}');
    return typeof packageManager === 'string' ? /^([^@]+)@/.exec(packageManager)?.[1] : null;
  } catch {
    return null;
  }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const NPM_ROOT_INPUTS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'workspaces'];

function compareNpmReceipt(lockfile, receipt, sourceLockfile) {
  const expected = JSON.parse(lockfile).packages;
  const installed = JSON.parse(receipt).packages;
  // npm's hidden lockfile omits the project root and may omit platform-specific
  // optional packages. Workspace links and their target records are included.
  const sourceRoot = JSON.parse(sourceLockfile ?? 'null')?.packages?.[''];
  if (!isRecord(expected?.['']) || !isRecord(installed) || !isRecord(sourceRoot)) return 'unverified';
  // npm's receipt has no record of the ranges or workspace declarations used
  // at the root. Check the source declaration and still require its receipt
  // to independently agree with the claim's resolved packages.
  if (!NPM_ROOT_INPUTS.every(key => isDeepStrictEqual(expected[''][key], sourceRoot[key]))) return 'stale';
  const matches = Object.entries(expected).every(([path, entry]) =>
    path === '' || (entry?.optional === true && !Object.hasOwn(installed, path)) ||
    isDeepStrictEqual(entry, installed[path])) &&
    Object.keys(installed).every(path => Object.hasOwn(expected, path));
  return matches ? 'matching' : 'stale';
}

function comparePnpmReceipt(lockfile, receipt) {
  const normalize = text => text.replaceAll('\r\n', '\n').trimEnd();
  // Compare the generated current lock without interpreting any project YAML.
  // A filtered install or a differently serialized lock requires a local install.
  if (![lockfile, receipt].every(text => /^lockfileVersion:[ \t]+\S/m.test(text))) return 'unverified';
  return normalize(lockfile) === normalize(receipt) ? 'matching' : 'stale';
}

export async function inspectClaimDependencyLock(sourceWorkspace, worktreePath) {
  const sourceModules = join(sourceWorkspace, 'node_modules');
  const sourceAvailable = (await stat(sourceModules).catch(() => null))?.isDirectory();
  const candidates = await Promise.all(Object.entries(LOCKFILES).map(async ([manager, filename]) => {
    const file = await readCheckoutFile(join(worktreePath, filename));
    return file && { manager, lockfile: file.text };
  }));
  const found = candidates.filter(Boolean);
  if (!found.length) return sourceAvailable ? { status: 'unverified' } : null;
  const declared = found.length > 1 ? await declaredPackageManager(worktreePath) : found[0].manager;
  const candidate = found.find(({ manager }) => manager === declared);
  if (!candidate) return { status: 'unverified' };

  const { manager, lockfile } = candidate;
  if (!sourceAvailable) return { manager, status: 'absent' };
  const receiptPath = manager === 'pnpm' ? join('.pnpm', 'lock.yaml') : '.package-lock.json';
  const receipt = await readText(join(sourceModules, receiptPath));
  if (!lockfile || !receipt) return { manager, status: 'unverified' };
  try {
    const status = manager === 'pnpm'
      ? comparePnpmReceipt(lockfile, receipt)
      : compareNpmReceipt(lockfile, receipt, (await readCheckoutFile(join(sourceWorkspace, LOCKFILES.npm)))?.text);
    return { manager, status };
  } catch {
    return { manager, status: 'unverified' };
  }
}

export function formatClaimDependencyStatus(dependencies) {
  if (!Array.isArray(dependencies) || !dependencies.length) {
    return 'Dependency provisioning could not be verified. Inspect dependency paths and symlinks before installing. Never install through links to the source checkout.';
  }

  const unavailable = dependencies.find(item =>
    item.status === 'stale' || item.status === 'unverified' || (item.status === 'absent' && item.manager));
  if (unavailable) {
    const source = {
      stale: 'stale in source',
      unverified: 'source lockfile match unverified',
      absent: 'absent in source',
    }[unavailable.status];
    const install = {
      pnpm: 'with `pnpm install --frozen-lockfile`',
      npm: 'with `npm ci`',
    }[unavailable.manager] ?? 'using the repository’s documented install procedure';
    const childGuidance = unavailable.hasInstalledChildren
      ? ' Source child installs were also left unlinked. Install independently locked packages from their own worktree directories if needed.'
      : '';
    return `Dependency provisioning: ${unavailable.path} ${source}. PortOS skipped dependency linking. After verifying the dependency paths are local to this worktree, install here ${install}.${childGuidance}`;
  }

  if (dependencies.every(item => item.status === 'absent')) {
    return 'The source checkout has no installed dependencies to link. Install dependencies inside this worktree after verifying no dependency paths are symlinks.';
  }

  const descriptions = {
    'linked-match': 'linked (matches lockfile)',
    linked: 'linked',
    absent: 'absent in source',
    existing: 'existing and preserved',
  };
  const paths = dependencies.map(({ path, status }) => `${path} ${descriptions[status] ?? 'status unknown'}`);
  return `Dependency provisioning: ${paths.join(', ')}. Never install through dependency paths linked to the source checkout. Inspect preserved paths before installing.`;
}
