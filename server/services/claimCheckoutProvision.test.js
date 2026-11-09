import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, realpathSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
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
    expect(result).toEqual({ claimCheckout: { repoPath: repo, worktreePath, branchName: 'claim/issue-42', baseBranch: 'main' } });
    expect((await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)).stdout.trim()).toBe('claim/issue-42');
    expect((await execGit(['rev-parse', 'HEAD'], worktreePath)).stdout.trim()).toBe(tip);
    // --no-track: nothing pushes to main by accident from the claim branch.
    const upstream = await execGit(['rev-parse', '--abbrev-ref', '@{u}'], worktreePath, { ignoreExitCode: true });
    expect(upstream.exitCode).not.toBe(0);
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
