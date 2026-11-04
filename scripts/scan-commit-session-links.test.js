import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommitSessionLinkScan } from './scan-commit-session-links.js';

const TRAILER = 'Claude-Session: https://claude.ai/code/session_EXAMPLE123';

describe('runCommitSessionLinkScan against a repository', () => {
  it('checks a release candidate through the CLI without blaming commits already on origin/main', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-release-commit-links-'));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Example', '-c', 'user.email=ci@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
    const commit = (file, message) => {
      writeFileSync(join(root, file), `${file}\n`);
      git('add', '--all');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    const scanner = fileURLToPath(new URL('./scan-commit-session-links.js', import.meta.url));
    const scan = (base) => spawnSync(process.execPath, [scanner, '--base', base], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: '' },
    });
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'core.hooksPath', join(root, 'empty-hooks'));
      const releaseBase = commit('release.txt', 'Previous release');
      const historical = commit('historical.txt', `Historical main change\n\n${TRAILER}`);
      git('update-ref', 'refs/remotes/origin/main', historical);
      git('checkout', '-q', '-b', 'release-candidate');
      commit('preparation.txt', 'Prepare a clean release');

      const clean = scan(releaseBase);
      expect(clean.status, clean.stderr).toBe(0);
      expect(clean.stdout).toContain('1 message(s)');

      const offender = commit('candidate.txt', `Candidate-only change\n\n${TRAILER}`);
      const dirty = scan(releaseBase);
      expect(dirty.status).toBe(1);
      expect(dirty.stderr).toContain(offender.slice(0, 10));
      expect(dirty.stderr).not.toContain(historical.slice(0, 10));

      // Without a published default-branch ref, retain the explicit base's full scan.
      git('update-ref', '-d', 'refs/remotes/origin/main');
      const withoutRemoteMain = scan(releaseBase);
      expect(withoutRemoteMain.status).toBe(1);
      expect(withoutRemoteMain.stderr).toContain(historical.slice(0, 10));
      expect(withoutRemoteMain.stderr).toContain(offender.slice(0, 10));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      expect(clean.lines[0]).toContain('1 message(s)');

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
    PORTOS_CI_CANDIDATE_HEAD: 'a'.repeat(40), CI_DEFAULT_BRANCH: 'main', CI_PR_NUMBER: '7',
  };
  const respond = (pages, description = 'Clean description') => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.endsWith('/pulls/7')) return description === null ? { ok: false, status: 404 } : { ok: true, json: async () => ({ body: description }) };
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

  it('never prints the session id from a link in a commit subject', async () => {
    const { fetchImpl } = respond([{ total_commits: 1, commits: [{ sha: 'b'.repeat(40), commit: { message: 'Fix https://claude.ai/code/session_private-marker now' } }] }]);
    const result = await runCommitSessionLinkScan({ env, fetchImpl });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain(`${'b'.repeat(10)} "Fix <session link> now" contains claude.ai/code/session`);
    expect(result.lines.join('\n')).not.toContain('private-marker');
  });

  it('checks only the description under --description, the text a squash merge copies to main', async () => {
    const dirty = respond([], `Summary\n\n${TRAILER}`);
    const result = await runCommitSessionLinkScan({ argv: ['--description'], env, fetchImpl: dirty.fetchImpl });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('the pull request description contains claude.ai/code/session');
    expect(dirty.urls).toEqual(['https://api.github.com/repos/example/repo/pulls/7']);
    // An edit that drops the link turns the same check green.
    expect((await runCommitSessionLinkScan({ argv: ['--description'], env, fetchImpl: respond([]).fetchImpl })).code).toBe(0);
    expect((await runCommitSessionLinkScan({ argv: ['--description'], env, fetchImpl: respond([], null).fetchImpl })).code).toBe(2);
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

  it('re-checks the description on every edit', () => {
    const workflow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'pr-description.yml'), 'utf8');
    expect(workflow).toContain('types: [opened, edited, reopened, synchronize]');
    expect(workflow).toContain('run: node scripts/scan-commit-session-links.js --description');
    expect(workflow).toContain('CI_PR_NUMBER: ${{ github.event.pull_request.number }}');
  });
});
