import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, realpathSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { provisionClaimCheckout, serverClaimCheckoutBranch } from './claimCheckoutProvision.js';

const app = { id: 'app-fixture', name: 'Fixture App' };
const IDENTITY = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false'];

let scratch;
let repo;
let worktreesRoot;
// The agent-cut claim flow's own path, so both producers name one directory.
const claimDir = () => join(worktreesRoot, 'claim-fixture-app-appfixtu-issue-42');

beforeEach(async () => {
  scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-claim-provision-')));
  const origin = join(scratch, 'origin.git');
  repo = join(scratch, 'repo');
  worktreesRoot = join(scratch, 'worktrees');
  await execGit(['init', '--bare', '-b', 'main', origin], scratch);
  await execGit(['clone', origin, repo], scratch);
  await writeFile(join(repo, 'README.md'), 'fixture\n');
  await execGit([...IDENTITY, 'add', 'README.md'], repo);
  await execGit([...IDENTITY, 'commit', '-m', 'init'], repo);
  await execGit(['push', 'origin', 'HEAD:main'], repo);
  await execGit(['remote', 'set-head', 'origin', 'main'], repo);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const pnpmLock = version => `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      example:\n        specifier: ^${version}\n        version: ${version}\n`;
const npmLock = (version, root = {}) => JSON.stringify({
  lockfileVersion: 3,
  packages: { ...root, 'node_modules/example': { version } },
});

describe('provisionClaimCheckout', () => {
  it('cuts the claim branch from the fetched default branch at the agent-cut claim path', async () => {
    // Origin moved after the clone; the checkout must start from the fetched tip.
    const other = join(scratch, 'other');
    await execGit(['clone', join(scratch, 'origin.git'), other], scratch);
    await writeFile(join(other, 'NEW.md'), 'new\n');
    await execGit([...IDENTITY, 'add', 'NEW.md'], other);
    await execGit([...IDENTITY, 'commit', '-m', 'advance'], other);
    await execGit(['push', 'origin', 'HEAD:main'], other);
    const tip = (await execGit(['rev-parse', 'HEAD'], other)).stdout.trim();

    const result = await provisionClaimCheckout({ app, sourceWorkspace: repo, branch: 'claim/issue-42', worktreesRoot });

    const worktreePath = claimDir();
    expect(result).toEqual({ claimCheckout: { repoPath: repo, worktreePath, branchName: 'claim/issue-42', baseBranch: 'main', dependencies: [{ path: 'node_modules', status: 'absent' }] } });
    expect((await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)).stdout.trim()).toBe('claim/issue-42');
    expect((await execGit(['rev-parse', 'HEAD'], worktreePath)).stdout.trim()).toBe(tip);
    // --no-track: nothing pushes to main by accident from the claim branch.
    const upstream = await execGit(['rev-parse', '--abbrev-ref', '@{u}'], worktreePath, { ignoreExitCode: true });
    expect(upstream.exitCode).not.toBe(0);
  });

  it.each([
    ['pnpm', 'matching', 'linked-match'],
    ['pnpm', 'stale', 'stale'],
    ['pnpm', 'missing receipt', 'unverified'],
    ['pnpm', 'absent', 'absent'],
    ['npm', 'matching', 'linked-match'],
    ['npm', 'stale root range', 'stale'],
    ['npm', 'stale', 'stale'],
  ])('checks the %s root lockfile before linking a %s install', async (manager, receiptState, expectedStatus) => {
    const pnpm = manager === 'pnpm';
    const filename = pnpm ? 'pnpm-lock.yaml' : 'package-lock.json';
    const receiptPath = join(repo, 'node_modules', pnpm ? '.pnpm/lock.yaml' : '.package-lock.json');
    const wanted = (version, range = `^${version}`) => pnpm ? pnpmLock(version) : npmLock(version, {
      '': { name: 'fixture', dependencies: { example: range } },
      'node_modules/platform-optional': { version: '1.0.0', optional: true },
    });
    const installVersion = ['matching', 'stale root range'].includes(receiptState) ? '2.0.0' : '1.0.0';
    const installRange = receiptState === 'stale root range' ? '2.0.0' : `^${installVersion}`;
    const receipt = pnpm ? pnpmLock(installVersion) : npmLock(installVersion);
    if (receiptState !== 'absent') await mkdir(join(repo, 'node_modules', '.pnpm'), { recursive: true });
    await mkdir(join(repo, 'client', 'node_modules'), { recursive: true });
    await writeFile(join(repo, 'client', 'package.json'), '{}');
    await writeFile(join(repo, filename), wanted('2.0.0'));
    await execGit([...IDENTITY, 'add', filename, 'client/package.json'], repo);
    await execGit([...IDENTITY, 'commit', '-m', 'add lockfile'], repo);
    await execGit(['push', 'origin', 'HEAD:main'], repo);
    // A matching lockfile in the primary checkout cannot justify linking into
    // a claim whose fetched branch wants a different dependency version.
    await writeFile(join(repo, filename), wanted(installVersion, installRange));
    const hasReceipt = !['absent', 'missing receipt'].includes(receiptState);
    if (hasReceipt) await writeFile(receiptPath, receipt);

    const { claimCheckout } = await provisionClaimCheckout({ app, sourceWorkspace: repo, branch: 'claim/issue-42', worktreesRoot });

    const root = join(claimDir(), 'node_modules');
    const child = join(claimDir(), 'client', 'node_modules');
    expect(claimCheckout.dependencies).toContainEqual(expect.objectContaining({ path: 'node_modules', status: expectedStatus }));
    if (receiptState === 'matching') {
      expect(realpathSync(root)).toBe(realpathSync(join(repo, 'node_modules')));
      expect(realpathSync(child)).toBe(realpathSync(join(repo, 'client', 'node_modules')));
    } else {
      expect(claimCheckout.dependencies).toEqual([{ path: 'node_modules', status: expectedStatus, manager, hasInstalledChildren: true }]);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(child)).toBe(false);
    }
    if (hasReceipt) expect(await readFile(receiptPath, 'utf8')).toBe(receipt);
  });

  it('refuses, creating nothing, when the claim branch already exists on origin', async () => {
    await execGit(['push', 'origin', 'HEAD:refs/heads/claim/issue-42'], repo);
    const result = await provisionClaimCheckout({ app, sourceWorkspace: repo, branch: 'claim/issue-42', worktreesRoot });
    expect(result.refused).toMatch(/already exists on origin/);
    expect(existsSync(claimDir())).toBe(false);
  });

  it('refuses when the claim branch already exists locally', async () => {
    await execGit(['branch', 'claim/issue-42'], repo);
    const result = await provisionClaimCheckout({ app, sourceWorkspace: repo, branch: 'claim/issue-42', worktreesRoot });
    expect(result.refused).toMatch(/already exists locally/);
    expect(existsSync(claimDir())).toBe(false);
  });

  it.each(['next/issue-42', 'cos/sys-claim/issue-42/agent-abc'])('refuses when a sibling documented claim ref %s exists locally', async (ref) => {
    await execGit(['branch', ref], repo);
    const result = await provisionClaimCheckout({ app, sourceWorkspace: repo, branch: 'claim/issue-42', worktreesRoot });
    expect(result.refused).toBe(`${ref} already exists locally`);
    expect(existsSync(claimDir())).toBe(false);
  });

  it.each(['next/issue-42', 'cos/sys-claim/issue-42/agent-abc'])('refuses when a sibling documented claim ref %s exists on origin', async (ref) => {
    await execGit(['push', 'origin', `HEAD:refs/heads/${ref}`], repo);
    const result = await provisionClaimCheckout({ app, sourceWorkspace: repo, branch: 'claim/issue-42', worktreesRoot });
    expect(result.refused).toBe(`${ref} already exists on origin`);
    expect(existsSync(claimDir())).toBe(false);
  });
});

describe('serverClaimCheckoutBranch', () => {
  it('names the branch only for a flagged claim pinned to an issue number', () => {
    const task = (metadata) => ({ metadata: { claimFlow: true, claimTarget: '42', ...metadata } });
    expect(serverClaimCheckoutBranch(task({ claimServerCheckout: true }))).toBe('claim/issue-42');
    expect(serverClaimCheckoutBranch(task({ claimServerCheckout: 'true' }))).toBe('claim/issue-42');
    expect(serverClaimCheckoutBranch(task({}))).toBeNull();
    expect(serverClaimCheckoutBranch(task({ claimServerCheckout: true, claimTarget: 'PROJ-12' }))).toBeNull();
    expect(serverClaimCheckoutBranch({ metadata: { claimServerCheckout: true, claimTarget: '42' } })).toBeNull();
  });
});
