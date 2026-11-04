import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommitSessionLinkScan } from './scan-commit-session-links.js';

const TRAILER = 'Claude-Session: https://claude.ai/code/session_EXAMPLE123';

describe('runCommitSessionLinkScan against a repository', () => {
  it('fails only on the branch\'s own commits, naming the offender', async () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-commit-links-'));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Example', '-c', 'user.email=ci@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
    const commit = (file, message) => {
      writeFileSync(join(root, file), `${file}\n`);
      git('add', '--all');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'core.hooksPath', join(root, 'empty-hooks'));
      // History already on main carries the trailer; it must not fail a branch.
      commit('a.txt', `Old main commit\n\n${TRAILER}`);
      git('checkout', '-q', '-b', 'feature');
      commit('b.txt', 'Clean branch commit\n\nCo-Authored-By: Example <ci@example.com>');

      const clean = await runCommitSessionLinkScan({ argv: ['--base', 'main'], cwd: root, env: {} });
      expect(clean.code).toBe(0);
      expect(clean.lines[0]).toContain('1 branch commit');

      const offender = commit('c.txt', `Add a feature\n\n${TRAILER}`);
      const dirty = await runCommitSessionLinkScan({ argv: ['--base', 'main'], cwd: root, env: {} });
      expect(dirty.code).toBe(1);
      expect(dirty.lines.join('\n')).toContain(`${offender.slice(0, 10)} "Add a feature" contains claude.ai/code/session`);
      expect(dirty.lines.join('\n')).not.toContain('EXAMPLE123');
      expect(dirty.lines.join('\n')).not.toContain('Clean branch commit');

      expect((await runCommitSessionLinkScan({ argv: ['--base', 'no-such-ref'], cwd: root, env: {} })).code).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runCommitSessionLinkScan on a pull request', () => {
  const env = {
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'example/repo', GITHUB_TOKEN: 'token',
    PORTOS_CI_CANDIDATE_HEAD: 'a'.repeat(40), CI_DEFAULT_BRANCH: 'main',
  };
  const respond = (pages) => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return { ok: true, json: async () => pages[page - 1] };
    };
    return { urls, fetchImpl };
  };

  it('reads every page of the compare against the default branch', async () => {
    const commit = (n, message) => ({ sha: `${n}`.padStart(40, '0'), commit: { message } });
    const firstPage = Array.from({ length: 100 }, (_, n) => commit(n, `Commit ${n}`));
    const { urls, fetchImpl } = respond([
      { total_commits: 101, commits: firstPage },
      { total_commits: 101, commits: [commit(100, 'Last\n\nSee https://chatgpt.com/share/example')] },
    ]);
    const result = await runCommitSessionLinkScan({ env, fetchImpl });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('"Last" contains chatgpt.com/share/');
    expect(urls[0]).toBe(`https://api.github.com/repos/example/repo/compare/main...${'a'.repeat(40)}?per_page=100&page=1`);
    expect(urls).toHaveLength(2);
  });

  it('refuses to pass when the commits cannot be read', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    expect((await runCommitSessionLinkScan({ env, fetchImpl })).code).toBe(2);
    expect((await runCommitSessionLinkScan({ env: { ...env, GITHUB_TOKEN: '' }, fetchImpl })).code).toBe(2);
  });

  it('is wired into the impact job with the compare inputs', () => {
    const workflow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml'), 'utf8');
    const impact = workflow.slice(workflow.indexOf('\n  impact:\n'), workflow.indexOf('\n  prompt-history:\n'));
    const step = impact.slice(impact.indexOf('- name: Refuse AI session links in commit messages'));
    expect(step).toContain('run: node scripts/ci-impact-diagnostics.js commit-messages -- node scripts/scan-commit-session-links.js');
    for (const input of ['GITHUB_TOKEN:', 'CI_DEFAULT_BRANCH:']) expect(step.split('\n      - name:')[0]).toContain(input);
  });
});
