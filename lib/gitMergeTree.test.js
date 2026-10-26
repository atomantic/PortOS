import { describe, expect, it, vi } from 'vitest';
import { mergeTreeCapability, probeGitMergeTree } from './gitMergeTree.js';

describe('Git merge-tree prerequisite', () => {
  it.each([
    ['legacy', { status: 129, stderr: 'usage: git merge-tree <base-tree> <branch1> <branch2>' }, 'git-merge-tree-unsupported'],
    ['write-tree only', { status: 129, stdout: '--write-tree' }, 'git-merge-tree-unsupported'],
    ['missing executable', { status: null, error: new Error('ENOENT') }, 'git-capability-probe-failed'],
    ['timeout', { status: null, signal: 'SIGTERM', stdout: '--write-tree --merge-base' }, 'git-capability-probe-failed'],
    ['unexpected failure', { status: 128, stderr: 'fatal: unavailable' }, 'git-capability-probe-failed'],
  ])('fails closed with repair guidance for %s', (_name, result, reason) => {
    const run = vi.fn(() => result);
    expect(probeGitMergeTree('/synthetic/repo', run)).toMatchObject({ ok: false, reason, detail: expect.stringContaining('Install Git 2.40 or newer') });
    expect(run).toHaveBeenCalledWith('git', ['merge-tree', '-h'], expect.objectContaining({ cwd: '/synthetic/repo', timeout: 5000 }));
  });

  it.each(['--merge-base=<tree-ish>', '--[no-]merge-base <tree-ish>'])('accepts advertised %s even with normal help exit 129', flag => {
    expect(mergeTreeCapability({ exitCode: 129, stderr: `--write-tree\n${flag}` })).toEqual({ ok: true });
  });
});
