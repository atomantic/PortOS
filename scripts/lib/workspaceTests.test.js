/**
 * The runner's enumeration must collect exactly what each Vitest config
 * collects: a file the runner cannot see is a file the memo can never skip
 * and a full plan would silently drop.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globToRegExp, listWorkspaceTests, toRepoPath, toWorkspacePath } from './workspaceTests.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('workspace test enumeration', () => {
  it('matches the subset of glob syntax the configs use', () => {
    expect(globToRegExp('**/*.test.js').test('lib/x.test.js')).toBe(true);
    expect(globToRegExp('**/*.test.js').test('x.test.js')).toBe(true);
    expect(globToRegExp('**/*.test.js').test('lib/x.spec.js')).toBe(false);
    expect(globToRegExp('../scripts/**/*.test.js').test('../scripts/lib/x.test.js')).toBe(true);
    expect(globToRegExp('src/**/*.{test,spec}.{js,jsx}').test('src/a/b.spec.jsx')).toBe(true);
    expect(globToRegExp('**/db.test.js').test('lib/db.test.js')).toBe(true);
    expect(globToRegExp('**/db.test.js').test('lib/x.db.test.js')).toBe(false);
    expect(globToRegExp('../lib/slashdo/**').test('../lib/slashdo/a/b.test.js')).toBe(true);
  });

  it('converts between workspace and repository paths', () => {
    expect(toRepoPath('server', 'lib/x.test.js')).toBe('server/lib/x.test.js');
    expect(toRepoPath('server', '../scripts/x.test.js')).toBe('scripts/x.test.js');
    expect(toWorkspacePath('server', 'scripts/x.test.js')).toBe('../scripts/x.test.js');
    expect(toWorkspacePath('client', 'client/src/x.test.jsx')).toBe('src/x.test.jsx');
  });

  for (const workspace of ['server', 'client']) {
    it(`collects the same files as \`vitest list\` for ${workspace}`, () => {
      const listed = execFileSync(join(REPO_ROOT, workspace, 'node_modules', '.bin', 'vitest'),
        ['list', '--filesOnly', '--configLoader', 'runner'], {
          cwd: join(REPO_ROOT, workspace), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PORTOS_CI_TEST_SELECTION: '', PORTOS_CI_BROWSER_OWNER: '' },
        })
        .split('\n').map((line) => line.trim().replace(/^\[[^\]]+\] /, '')).filter(Boolean).sort();
      expect(listed.length).toBeGreaterThan(100);
      expect(listWorkspaceTests(workspace, { repoRoot: REPO_ROOT, env: {} })).toEqual([...new Set(listed)].sort());
    }, 120_000);
  }

  it('drops the registered browser suites only for the Linux unit owner', () => {
    const all = listWorkspaceTests('server', { repoRoot: REPO_ROOT, platform: 'linux', env: {} });
    const owned = listWorkspaceTests('server', { repoRoot: REPO_ROOT, platform: 'linux', env: { PORTOS_CI_BROWSER_OWNER: 'unit' } });
    expect(all).toContain('lib/filmLook.browser.test.js');
    expect(owned).not.toContain('lib/filmLook.browser.test.js');
    expect(listWorkspaceTests('server', { repoRoot: REPO_ROOT, platform: 'win32', env: { PORTOS_CI_BROWSER_OWNER: 'unit' } })).toEqual(all);
  });
});
