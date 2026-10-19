/**
 * The runner's enumeration must collect exactly what each Vitest config
 * collects: a file the runner cannot see is a file the memo can never skip
 * and a full plan would silently drop.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_TEST_INCLUDE } from './dbTestFiles.js';
import { globToRegExp, listWorkspaceTests, toRepoPath, toWorkspacePath } from './workspaceTests.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** What `vitest list --filesOnly` collects for a workspace, sorted and project-prefix free. */
function vitestListedFiles(repoRoot, workspace) {
  // Through node, not the .bin shim: the shim is a shell script (.cmd on Windows) execFileSync cannot start there.
  const listed = execFileSync(process.execPath, [join(repoRoot, workspace, 'node_modules', 'vitest', 'vitest.mjs'),
    'list', '--filesOnly', '--configLoader', 'runner'], {
      cwd: join(repoRoot, workspace), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PORTOS_CI_TEST_SELECTION: '', PORTOS_CI_BROWSER_OWNER: '' },
    })
    .split('\n').map((line) => line.trim().replace(/^\[[^\]]+\] /, '')).filter(Boolean);
  if (listed.length < 100) throw new Error(`vitest list returned only ${listed.length} ${workspace} files`);
  return [...new Set(listed)].sort();
}

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

  // The client half lives in client/src/test/workspaceTests.test.js: the server
  // CI job installs no client workspace, so a client `vitest list` cannot run here.
  it('collects the same files as `vitest list` for server', () => {
    expect(listWorkspaceTests('server', { repoRoot: REPO_ROOT, env: {} })).toEqual(vitestListedFiles(REPO_ROOT, 'server'));
  }, 120_000);

  it('collects the same files as `vitest list --config vitest.config.db.js` for the db scope', () => {
    const listed = execFileSync(process.execPath, [join(REPO_ROOT, 'server', 'node_modules', 'vitest', 'vitest.mjs'),
      'list', '--filesOnly', '--config', 'vitest.config.db.js', '--configLoader', 'runner'], {
      cwd: join(REPO_ROOT, 'server'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PORTOS_CI_TEST_SELECTION: '' },
    }).split('\n').map((line) => line.trim().replace(/^\[[^\]]+\] /, '')).filter(Boolean);
    const found = listWorkspaceTests('db', { repoRoot: REPO_ROOT, env: {} });
    expect(found).toEqual([...new Set(listed)].sort());
    expect(found.length).toBeGreaterThanOrEqual(DB_TEST_INCLUDE.filter((glob) => !glob.includes('*')).length);
    expect(toRepoPath('db', found[0])).toMatch(/^(server|scripts)\//);
  }, 120_000);

  it('drops the registered browser suites for an explicit unit owner on every platform', () => {
    const all = listWorkspaceTests('server', { repoRoot: REPO_ROOT, platform: 'linux', env: {} });
    expect(all).toContain('lib/filmLook.browser.test.js');
    for (const platform of ['linux', 'darwin', 'win32']) {
      const owned = listWorkspaceTests('server', { repoRoot: REPO_ROOT, platform, env: { PORTOS_CI_BROWSER_OWNER: 'unit' } });
      expect(owned).not.toContain('lib/filmLook.browser.test.js');
    }
    expect(listWorkspaceTests('server', { repoRoot: REPO_ROOT, platform: 'darwin', env: {} })).toEqual(all);
  });
});
