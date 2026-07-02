/**
 * Tests for workspaceContext.js (#902).
 *
 * Covers the pure helpers (task scoping incl. the PortOS `_self`/absent
 * special-case, and prefix-safe shell-cwd containment) and the save→get→
 * restore→delete round-trip against a temp data root, with apps/git/shell/
 * task deps mocked so the orchestration is exercised without a real repo,
 * live PTYs, or the CoS task files.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'workspace-context-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

// Mutable fixtures the mocks read — reassigned per test.
let mockApps = [];
let mockSessions = [];
let mockTasks = { user: { tasks: [] }, cos: { tasks: [] } };
let mockGit = { isRepo: true, branch: 'main', clean: true, files: [] };

vi.mock('./apps.js', () => ({
  PORTOS_APP_ID: 'portos-default',
  getAppById: vi.fn(async (id) => mockApps.find(a => a.id === id) || null),
  getAllApps: vi.fn(async () => mockApps)
}));

vi.mock('./git.js', () => ({
  isRepo: vi.fn(async () => mockGit.isRepo),
  getBranch: vi.fn(async () => mockGit.branch),
  getStatus: vi.fn(async () => ({ clean: mockGit.clean, files: mockGit.files }))
}));

vi.mock('./shell.js', () => ({
  listAllSessions: vi.fn(() => mockSessions)
}));

vi.mock('./cosTaskStore.js', () => ({
  getAllTasks: vi.fn(async () => mockTasks)
}));

const wc = await import('./workspaceContext.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_DATA_ROOT, { recursive: true });
  mockApps = [
    { id: 'portos-default', name: 'PortOS', repoPath: '/code/portos' },
    { id: 'app-1', name: 'BookLoom', repoPath: '/code/bookloom' }
  ];
  mockSessions = [];
  mockTasks = { user: { tasks: [] }, cos: { tasks: [] } };
  mockGit = { isRepo: true, branch: 'main', clean: true, files: [] };
});

describe('tasksForApp', () => {
  const { tasksForApp } = wc.__test;

  it('scopes tasks to the matching app id', () => {
    const all = { user: { tasks: [
      { id: 't1', description: 'a', metadata: { app: 'app-1' } },
      { id: 't2', description: 'b', metadata: { app: 'other' } }
    ] }, cos: { tasks: [] } };
    expect(tasksForApp(all, 'app-1').map(t => t.id)).toEqual(['t1']);
  });

  it('PortOS collects _self, absent, and explicit portos-default scopes', () => {
    const all = { user: { tasks: [
      { id: 's1', description: 'self', metadata: { app: '_self' } },
      { id: 's2', description: 'absent', metadata: {} },
      { id: 's3', description: 'explicit', metadata: { app: 'portos-default' } },
      { id: 's4', description: 'other', metadata: { app: 'app-1' } }
    ] }, cos: { tasks: [] } };
    expect(tasksForApp(all, 'portos-default').map(t => t.id).sort()).toEqual(['s1', 's2', 's3']);
  });

  it('truncates description to the first line', () => {
    const all = { user: { tasks: [
      { id: 't1', description: 'first line\nsecond line', metadata: { app: 'app-1' } }
    ] }, cos: { tasks: [] } };
    expect(tasksForApp(all, 'app-1')[0].description).toBe('first line');
  });
});

describe('shellSessionsForRepo', () => {
  const { shellSessionsForRepo } = wc.__test;

  it('matches the repo root and nested cwds', () => {
    const sessions = [
      { sessionId: 'a', cwd: '/code/app' },
      { sessionId: 'b', cwd: '/code/app/sub/dir' }
    ];
    expect(shellSessionsForRepo(sessions, '/code/app').map(s => s.sessionId)).toEqual(['a', 'b']);
  });

  it('does NOT match a sibling sharing a name prefix', () => {
    const sessions = [
      { sessionId: 'a', cwd: '/code/app' },
      { sessionId: 'b', cwd: '/code/app-www' }
    ];
    expect(shellSessionsForRepo(sessions, '/code/app').map(s => s.sessionId)).toEqual(['a']);
  });

  it('returns [] when repoPath is missing', () => {
    expect(shellSessionsForRepo([{ sessionId: 'a', cwd: '/x' }], null)).toEqual([]);
  });
});

describe('captureLiveContext', () => {
  it('returns null for an unknown app id', async () => {
    expect(await wc.captureLiveContext('nope')).toBeNull();
  });

  it('captures branch, dirty state, in-repo shells, and scoped tasks', async () => {
    mockGit = { isRepo: true, branch: 'feature/x', clean: false, files: [{ path: 'a' }, { path: 'b' }] };
    mockSessions = [
      { sessionId: 's1', cwd: '/code/bookloom', label: 'dev', kind: 'shell', attached: false },
      { sessionId: 's2', cwd: '/code/other', label: 'x', kind: 'shell', attached: true }
    ];
    mockTasks = { user: { tasks: [{ id: 't1', description: 'do thing', status: 'pending', metadata: { app: 'app-1' } }] }, cos: { tasks: [] } };

    const live = await wc.captureLiveContext('app-1');
    expect(live.branch).toBe('feature/x');
    expect(live.dirty).toBe(true);
    expect(live.changedFileCount).toBe(2);
    expect(live.shellSessions.map(s => s.sessionId)).toEqual(['s1']);
    expect(live.tasks.map(t => t.id)).toEqual(['t1']);
  });

  it('tolerates a non-repo path', async () => {
    mockGit = { isRepo: false, branch: null, clean: true, files: [] };
    const live = await wc.captureLiveContext('app-1');
    expect(live.isRepo).toBe(false);
    expect(live.branch).toBeNull();
    expect(live.dirty).toBeNull();
  });

  it('normalizes a detached HEAD to null (not the literal "HEAD")', async () => {
    mockGit = { isRepo: true, branch: 'HEAD', clean: true, files: [] };
    const live = await wc.captureLiveContext('app-1');
    expect(live.branch).toBeNull();
  });
});

describe('save / get / restore / delete round-trip', () => {
  it('persists a snapshot and reconciles it on restore', async () => {
    mockGit = { isRepo: true, branch: 'main', clean: true, files: [] };
    mockSessions = [{ sessionId: 's1', cwd: '/code/bookloom', label: 'dev', kind: 'shell', attached: false }];
    mockTasks = { user: { tasks: [{ id: 't1', description: 'task', status: 'pending', metadata: { app: 'app-1' } }] }, cos: { tasks: [] } };

    const saved = await wc.saveContext('app-1');
    expect(saved.branch).toBe('main');
    expect(saved.shellSessionIds).toEqual(['s1']);
    expect(saved.taskIds).toEqual(['t1']);
    expect(saved.savedAt).toBeTruthy();

    const ctx = await wc.getContext('app-1');
    expect(ctx.saved.branch).toBe('main');
    expect(ctx.branch).toBe('main');

    // s1 still alive → re-attachable; branch unchanged → matches.
    let restore = await wc.restoreContext('app-1');
    expect(restore.restorable.shellSessions.map(s => s.sessionId)).toEqual(['s1']);
    expect(restore.restorable.missingShellSessionIds).toEqual([]);
    expect(restore.restorable.branchMatches).toBe(true);

    // s1 gone + branch switched → reported as missing + mismatch.
    mockSessions = [];
    mockGit = { ...mockGit, branch: 'other' };
    restore = await wc.restoreContext('app-1');
    expect(restore.restorable.shellSessions).toEqual([]);
    expect(restore.restorable.missingShellSessionIds).toEqual(['s1']);
    expect(restore.restorable.branchMatches).toBe(false);

    expect(await wc.deleteContext('app-1')).toBe(true);
    expect(await wc.getSavedContext('app-1')).toBeNull();
    expect(await wc.deleteContext('app-1')).toBe(false);
  });

  it('restore with no saved snapshot returns an empty restorable', async () => {
    const restore = await wc.restoreContext('app-1');
    expect(restore.saved).toBeNull();
    expect(restore.restorable.shellSessions).toEqual([]);
    expect(restore.restorable.branchMatches).toBeNull();
  });

  it('saveContext returns null for an unknown app id', async () => {
    expect(await wc.saveContext('nope')).toBeNull();
  });
});

describe('listContexts', () => {
  it('summarizes every active app with live counts and saved-at', async () => {
    mockSessions = [{ sessionId: 's1', cwd: '/code/bookloom', label: 'dev', kind: 'shell', attached: false }];
    mockTasks = { user: { tasks: [{ id: 't1', description: 'x', metadata: { app: 'app-1' } }] }, cos: { tasks: [] } };
    await wc.saveContext('app-1');

    const list = await wc.listContexts();
    const bookloom = list.find(r => r.appId === 'app-1');
    expect(bookloom.shellSessionCount).toBe(1);
    expect(bookloom.taskCount).toBe(1);
    expect(bookloom.savedAt).toBeTruthy();
    const portos = list.find(r => r.appId === 'portos-default');
    expect(portos.savedAt).toBeNull();
  });
});

describe('snapshotOnRepoSwitch (#2035 auto-save hook)', () => {
  beforeEach(() => wc.__resetWorkspaceTracker());

  it('is a no-op on the first switch (no prior workspace to snapshot)', async () => {
    const saved = await wc.snapshotOnRepoSwitch('app-1');
    expect(saved).toBeNull();
    expect(await wc.getSavedContext('app-1')).toBeNull();
    expect(wc.getCurrentWorkspaceAppId()).toBe('app-1');
  });

  it('snapshots the previous ("current") workspace when switching to a different repo', async () => {
    await wc.snapshotOnRepoSwitch('app-1');          // no-op, sets current = app-1
    const saved = await wc.snapshotOnRepoSwitch('portos-default'); // snapshots app-1
    expect(saved).toBeTruthy();
    expect(saved.appId).toBe('app-1');
    expect(await wc.getSavedContext('app-1')).toBeTruthy();
    expect(wc.getCurrentWorkspaceAppId()).toBe('portos-default');
  });

  it('does NOT snapshot when the target repo is unchanged', async () => {
    await wc.snapshotOnRepoSwitch('app-1');
    const saved = await wc.snapshotOnRepoSwitch('app-1');
    expect(saved).toBeNull();
    expect(await wc.getSavedContext('app-1')).toBeNull();
  });

  it('normalizes a null target to the PortOS app (CoS self dispatch)', async () => {
    await wc.snapshotOnRepoSwitch('app-1');
    const saved = await wc.snapshotOnRepoSwitch(null); // → portos-default, snapshots app-1
    expect(saved?.appId).toBe('app-1');
    expect(wc.getCurrentWorkspaceAppId()).toBe('portos-default');
  });
});
