import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('./github.js', () => ({
  findPullRequestForBranch: vi.fn(async () => ({ status: 'none' })),
  getPullRequestState: vi.fn(),
  ensureForgeReachable: vi.fn(async () => ({ ok: true, status: 'ok' })),
}));
vi.mock('./git.js', () => ({ resolveForgeForRepo: vi.fn(async () => ({ cli: 'gh' })), getDefaultBranch: vi.fn(async () => 'main') }));

import { verifyPrClaim } from './agentFinalization.js';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
const task = { id: 't', taskType: 'internal', description: 'Dependency Updates',
  metadata: { openPR: true, analysisType: 'dependency-updates' } };

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

async function verifyWith(extraFile) {
  const dir = mkdtempSync(join(tmpdir(), 'dep-sentinel-'));
  dirs.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  sh(dir, 'checkout', '-q', '-b', 'cos/x/agent-1');
  writeFileSync(join(dir, '.agent-done-agent-1'), '{}');
  if (extraFile) writeFileSync(join(dir, extraFile), '{}');
  return verifyPrClaim({ task, workspacePath: dir, success: true, prExpected: true });
}

describe('verifyPrClaim on a dependency-updates run', () => {
  it('does not count its own completion sentinel as an uncommitted deliverable', async () => {
    expect(await verifyWith(null)).toMatchObject({ ok: true, branchProvenEmpty: true });
  });

  it('still preserves a real untracked lockfile deliverable', async () => {
    expect(await verifyWith('package-lock.json')).toMatchObject({ ok: false, category: 'pr-missing' });
  });
});
