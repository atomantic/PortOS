import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock the migration-status reader so the migration-ledger-root test below can
// assert which rootDir the DEFAULT wiring passes (the rest of the suite injects
// its own `listPending`, so the mock is inert for them).
vi.mock('../../scripts/run-migrations.js', () => ({
  listPendingMigrations: vi.fn(async () => [])
}));

import {
  getInstallState,
  captureBootCommit,
  getBootCommit,
  __setBootCommitForTest,
  __internal
} from './installState.js';
import { listPendingMigrations } from '../../scripts/run-migrations.js';
import { PATHS } from '../lib/fileUtils.js';

// All external effects are injected, so these tests never touch real git/fs.

const ROOT = '/repo';

// Build a statMtime mock from a { pathSuffix: mtimeMs } map. A path not present
// in the map resolves to null (absent), mirroring the real helper.
function makeStat(map) {
  return async (path) => {
    for (const [suffix, mtime] of Object.entries(map)) {
      if (path.endsWith(suffix)) return mtime;
    }
    return null;
  };
}

// A fully in-sync baseline: every workspace installed (receipt newer than
// manifest), build current, no pending migrations, same commit.
function syncedOpts(overrides = {}) {
  return {
    rootDir: ROOT,
    boot: 'abc',
    getCurrentCommit: async () => 'abc',
    isAncestor: async () => false,
    statMtime: makeStat({
      'package.json': 100,
      '.package-lock.json': 200,
      'client/dist/index.html': 500
    }),
    clientSourceNewer: async () => false,
    listPending: async () => [],
    ...overrides
  };
}

describe('getInstallState — running stale code', () => {
  it('flags stale code when on-disk HEAD is strictly ahead of the boot commit', async () => {
    const state = await getInstallState(syncedOpts({
      boot: 'old',
      getCurrentCommit: async () => 'new',
      isAncestor: async () => true // boot is an ancestor of current → ahead
    }));
    expect(state.runningStaleCode).toBe(true);
    expect(state.outOfSync).toBe(true);
    expect(state.bootCommit).toBe('old');
    expect(state.currentCommit).toBe('new');
  });

  it('does NOT flag when commits differ but boot is not an ancestor (branch switch / rollback)', async () => {
    const state = await getInstallState(syncedOpts({
      boot: 'branchA',
      getCurrentCommit: async () => 'branchB',
      isAncestor: async () => false
    }));
    expect(state.runningStaleCode).toBe(false);
    expect(state.outOfSync).toBe(false);
  });

  it('does NOT flag when boot and current commit are identical', async () => {
    const state = await getInstallState(syncedOpts());
    expect(state.runningStaleCode).toBe(false);
  });

  it('does NOT flag when there is no boot commit (tarball / non-git install)', async () => {
    const state = await getInstallState(syncedOpts({ boot: null, isAncestor: async () => true }));
    expect(state.runningStaleCode).toBe(false);
  });
});

describe('getInstallState — stale deps', () => {
  it('flags a workspace whose manifest is newer than the npm install receipt', async () => {
    const state = await getInstallState(syncedOpts({
      statMtime: makeStat({
        'package.json': 300, // manifest newer than receipt
        '.package-lock.json': 200,
        'client/dist/index.html': 500
      })
    }));
    expect(state.staleDeps.stale).toBe(true);
    expect(state.staleDeps.workspaces.some(w => w.stale && w.reason === 'manifest-newer')).toBe(true);
    expect(state.outOfSync).toBe(true);
  });

  it('flags a workspace with no install receipt as not-installed', async () => {
    const state = await getInstallState(syncedOpts({
      statMtime: makeStat({
        'package.json': 100,
        'client/dist/index.html': 500
        // no .package-lock.json → receipt missing
      })
    }));
    expect(state.staleDeps.stale).toBe(true);
    expect(state.staleDeps.workspaces.every(w => w.reason === 'not-installed')).toBe(true);
  });

  it('flags a workspace whose lockfile is newer than the receipt beyond the jitter slack', async () => {
    const state = await getInstallState(syncedOpts({
      statMtime: makeStat({
        'package.json': 100,
        '.package-lock.json': 200,
        'package-lock.json': 200 + 120000, // lockfile clearly newer (2 min) → real stale
        'client/dist/index.html': 500
      })
    }));
    expect(state.staleDeps.stale).toBe(true);
    expect(state.staleDeps.workspaces.some(w => w.reason === 'lockfile-newer')).toBe(true);
  });

  it('does NOT flag lockfile-newer for same-install write jitter (lock barely ahead of receipt)', async () => {
    // The tracked lock and npm's receipt are written by the same `npm install`
    // ms apart; a small lead must never trip a permanent false "out of sync".
    const state = await getInstallState(syncedOpts({
      statMtime: makeStat({
        'package.json': 100,
        '.package-lock.json': 200,
        'package-lock.json': 220, // 20ms ahead — within slack
        'client/dist/index.html': 500
      })
    }));
    expect(state.staleDeps.stale).toBe(false);
  });

  it('skips workspaces with no package.json (absent in this install)', async () => {
    const state = await getInstallState(syncedOpts({
      statMtime: makeStat({
        // Only the root manifest exists; others absent → skipped
        '/repo/package.json': 100,
        '/repo/node_modules/.package-lock.json': 200,
        'client/dist/index.html': 500
      })
    }));
    expect(state.staleDeps.workspaces.map(w => w.name)).toEqual(['root']);
    expect(state.staleDeps.stale).toBe(false);
  });

  it('reports in-sync when every receipt is newer than its manifest', async () => {
    const state = await getInstallState(syncedOpts());
    expect(state.staleDeps.stale).toBe(false);
  });
});

describe('getInstallState — stale build', () => {
  it('flags when client source is newer than the built bundle', async () => {
    const state = await getInstallState(syncedOpts({ clientSourceNewer: async () => true }));
    expect(state.staleBuild).toBe(true);
    expect(state.outOfSync).toBe(true);
  });

  it('is null (unknown) when there is no built bundle — dev / never built', async () => {
    const state = await getInstallState(syncedOpts({
      statMtime: makeStat({ 'package.json': 100, '.package-lock.json': 200 }) // no dist/index.html
    }));
    expect(state.staleBuild).toBeNull();
    // null build must NOT count toward outOfSync
    expect(state.outOfSync).toBe(false);
  });

  it('is false when the build is current', async () => {
    const state = await getInstallState(syncedOpts());
    expect(state.staleBuild).toBe(false);
  });
});

describe('getInstallState — pending migrations', () => {
  it('surfaces pending migration files and count', async () => {
    const state = await getInstallState(syncedOpts({
      listPending: async () => ['099-foo.js', '100-bar.js']
    }));
    expect(state.pendingMigrations.count).toBe(2);
    expect(state.pendingMigrations.files).toEqual(['099-foo.js', '100-bar.js']);
    expect(state.outOfSync).toBe(true);
  });

  it('reports zero pending when the applied-list is current', async () => {
    const state = await getInstallState(syncedOpts());
    expect(state.pendingMigrations.count).toBe(0);
    expect(state.outOfSync).toBe(false);
  });

  // #1947: the migration ledger lives under the DATA install root (where boot
  // wrote it via the PORTOS_DATA_ROOT-resolved root), not the code checkout —
  // so the status reader must not use PATHS.root when the two diverge.
  it('reads the ledger from the data install root by default, not the code checkout', async () => {
    listPendingMigrations.mockClear();
    const { listPending, ...optsWithoutInjectedPending } = syncedOpts();
    await getInstallState(optsWithoutInjectedPending);
    expect(listPendingMigrations).toHaveBeenCalledWith({ rootDir: PATHS.installRoot });
  });

  it('honors an explicit migrationRootDir override', async () => {
    listPendingMigrations.mockClear();
    const { listPending, ...optsWithoutInjectedPending } = syncedOpts();
    await getInstallState({ ...optsWithoutInjectedPending, migrationRootDir: '/pinned/install' });
    expect(listPendingMigrations).toHaveBeenCalledWith({ rootDir: '/pinned/install' });
  });

  // #1947: boot SKIPS migrations for a worktree data root (no ledger written),
  // so the status path must not scan the ledger-less worktree and falsely report
  // every migration pending / outOfSync on every worktree boot.
  it('reports zero pending on a worktree data root without scanning the ledger', async () => {
    listPendingMigrations.mockClear();
    const { listPending, ...optsWithoutInjectedPending } = syncedOpts();
    const worktreeRoot = join(ROOT, 'data', 'cos', 'worktrees', 'agent-abc');
    const state = await getInstallState({ ...optsWithoutInjectedPending, migrationRootDir: worktreeRoot });
    expect(state.pendingMigrations.count).toBe(0);
    expect(state.outOfSync).toBe(false);
    // short-circuited — never scanned the worktree's absent ledger
    expect(listPendingMigrations).not.toHaveBeenCalled();
  });

  it('still reports pending migrations for a normal (non-worktree) data root', async () => {
    listPendingMigrations.mockClear();
    listPendingMigrations.mockResolvedValueOnce(['099-foo.js']);
    const { listPending, ...optsWithoutInjectedPending } = syncedOpts();
    const state = await getInstallState({ ...optsWithoutInjectedPending, migrationRootDir: ROOT });
    expect(state.pendingMigrations.count).toBe(1);
    expect(state.pendingMigrations.files).toEqual(['099-foo.js']);
    expect(state.outOfSync).toBe(true);
    expect(listPendingMigrations).toHaveBeenCalledWith({ rootDir: ROOT });
  });
});

describe('getInstallState — resilience', () => {
  it('treats a thrown ancestry check as not-ahead', async () => {
    const state = await getInstallState(syncedOpts({
      boot: 'old',
      getCurrentCommit: async () => 'new',
      isAncestor: async () => { throw new Error('git boom'); }
    }));
    expect(state.runningStaleCode).toBe(false);
  });

  it('treats a thrown migration listing as zero pending', async () => {
    const state = await getInstallState(syncedOpts({
      listPending: async () => { throw new Error('fs boom'); }
    }));
    expect(state.pendingMigrations.count).toBe(0);
  });
});

describe('captureBootCommit', () => {
  beforeEach(() => __setBootCommitForTest(null));

  it('captures the HEAD commit once and is idempotent', async () => {
    let calls = 0;
    const getCommit = async () => { calls++; return calls === 1 ? 'first' : 'second'; };
    expect(await captureBootCommit({ getCommit })).toBe('first');
    // A later on-disk pull must not overwrite the captured boot commit.
    expect(await captureBootCommit({ getCommit })).toBe('first');
    expect(getBootCommit()).toBe('first');
    expect(calls).toBe(1);
  });

  it('leaves boot commit null when HEAD cannot be read', async () => {
    const getCommit = async () => null;
    expect(await captureBootCommit({ getCommit })).toBeNull();
    expect(getBootCommit()).toBeNull();
  });
});

describe('isClientSourceNewer (real fs)', () => {
  let rootDir;
  const BUILD = 1_000_000_000; // arbitrary base "build" mtime in seconds
  const setMtime = (p, secs) => utimesSync(p, secs, secs);

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'client-src-'));
    mkdirSync(join(rootDir, 'client', 'src'), { recursive: true });
    mkdirSync(join(rootDir, 'client', 'public'), { recursive: true });
    // A baseline where every input predates the build.
    for (const rel of ['client/index.html', 'client/package.json', 'client/src/app.jsx', 'client/public/favicon.ico']) {
      writeFileSync(join(rootDir, rel), 'x');
      setMtime(join(rootDir, rel), BUILD - 100);
    }
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  const buildMs = BUILD * 1000;

  it('returns false when every input predates the build', async () => {
    expect(await __internal.isClientSourceNewer(rootDir, buildMs)).toBe(false);
  });

  it('detects a newer file under client/src', async () => {
    const p = join(rootDir, 'client', 'src', 'new.jsx');
    writeFileSync(p, 'x'); setMtime(p, BUILD + 100);
    expect(await __internal.isClientSourceNewer(rootDir, buildMs)).toBe(true);
  });

  it('detects a newer public asset', async () => {
    const p = join(rootDir, 'client', 'public', 'og.png');
    writeFileSync(p, 'x'); setMtime(p, BUILD + 100);
    expect(await __internal.isClientSourceNewer(rootDir, buildMs)).toBe(true);
  });

  it('detects a newer root-level build config (postcss/tailwind/tsconfig) without an explicit allow-list', async () => {
    const p = join(rootDir, 'client', 'postcss.config.js');
    writeFileSync(p, 'x'); setMtime(p, BUILD + 100);
    expect(await __internal.isClientSourceNewer(rootDir, buildMs)).toBe(true);
  });

  it('ignores changes under client/node_modules and client/dist', async () => {
    for (const rel of ['client/node_modules/dep/index.js', 'client/dist/assets/x.js']) {
      mkdirSync(join(rootDir, rel, '..'), { recursive: true });
      writeFileSync(join(rootDir, rel), 'x');
      setMtime(join(rootDir, rel), BUILD + 100);
    }
    expect(await __internal.isClientSourceNewer(rootDir, buildMs)).toBe(false);
  });
});

describe('detectStaleDeps (direct)', () => {
  it('classifies each workspace independently', async () => {
    const statMtime = makeStat({
      '/repo/package.json': 100,
      '/repo/node_modules/.package-lock.json': 200, // root: fresh
      '/repo/client/package.json': 300,
      '/repo/client/node_modules/.package-lock.json': 200, // client: manifest-newer
      '/repo/server/package.json': 100,
      '/repo/server/node_modules/.package-lock.json': 200, // server: fresh
      '/repo/autofixer/package.json': 100
      // autofixer: no receipt → not-installed
    });
    const result = await __internal.detectStaleDeps(ROOT, { statMtime });
    const byName = Object.fromEntries(result.workspaces.map(w => [w.name, w]));
    expect(byName.root.stale).toBe(false);
    expect(byName.client.reason).toBe('manifest-newer');
    expect(byName.server.stale).toBe(false);
    expect(byName.autofixer.reason).toBe('not-installed');
    expect(result.stale).toBe(true);
  });
});
