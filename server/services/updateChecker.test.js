import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module
vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  readJSONFile: vi.fn(),
  PATHS: {
    root: '/mock',
    data: '/mock/data'
  },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/asyncMutex.js', () => ({
  createMutex: () => (fn) => fn()
}));

vi.mock('./github.js', () => ({
  execGh: vi.fn()
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: vi.fn(),
  UPSTREAM_OWNER: 'atomantic',
  UPSTREAM_REPO: 'PortOS',
  UPSTREAM_FULL_NAME: 'atomantic/PortOS'
}));

// Keep getUpdateStatus unit tests hermetic — install-sync detection has its own
// suite (installState.test.js); here it must not spawn real git/fs.
vi.mock('./installState.js', () => ({
  getInstallState: vi.fn().mockResolvedValue(null)
}));

import { readJSONFile, ensureDir, atomicWrite } from '../lib/fileUtils.js';
import { readFile, unlink } from 'fs/promises';
import { execGh } from './github.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import {
  compareSemver,
  getCurrentVersion,
  getUpdateStatus,
  ignoreVersion,
  clearIgnored,
  checkForUpdate,
  clearStaleUpdateInProgress,
  getRemoteInfo,
  syncFork,
  processUpdateMarker,
  updateEvents
} from './updateChecker.js';

describe('compareSemver', () => {
  it('should return 0 for equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.26.0', '1.26.0')).toBe(0);
  });

  it('should return -1 when a < b', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemver('1.0.0', '1.1.0')).toBe(-1);
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
    expect(compareSemver('1.25.0', '1.26.0')).toBe(-1);
  });

  it('should return 1 when a > b', () => {
    expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
    expect(compareSemver('1.1.0', '1.0.0')).toBe(1);
    expect(compareSemver('2.0.0', '1.0.0')).toBe(1);
    expect(compareSemver('1.27.0', '1.26.0')).toBe(1);
  });

  it('should handle missing minor/patch', () => {
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.1', '1.1.0')).toBe(0);
  });
});

describe('getCurrentVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should read version from root package.json', async () => {
    readJSONFile.mockResolvedValue({ version: '1.26.0' });
    const version = await getCurrentVersion();
    expect(version).toBe('1.26.0');
    expect(readJSONFile).toHaveBeenCalledWith('/mock/package.json', { version: '0.0.0' });
  });

  it('should fall back to 0.0.0 when package.json missing', async () => {
    readJSONFile.mockResolvedValue({ version: '0.0.0' });
    const version = await getCurrentVersion();
    expect(version).toBe('0.0.0');
  });
});

describe('getUpdateStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOriginInfo.mockResolvedValue({
      hasOrigin: true,
      originUrl: 'git@github.com:atomantic/PortOS.git',
      host: 'github.com',
      owner: 'atomantic',
      repo: 'PortOS',
      fullName: 'atomantic/PortOS',
      isUpstream: true,
      isGithub: true,
      isFork: false
    });
  });

  it('should report no update when latestRelease is null', async () => {
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: null,
        latestRelease: null,
        ignoredVersions: [],
        updateInProgress: false,
        lastUpdateResult: null
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    const status = await getUpdateStatus();
    expect(status.updateAvailable).toBe(false);
    expect(status.currentVersion).toBe('1.26.0');
  });

  it('should detect update available when remote version is newer', async () => {
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: '2024-01-01T00:00:00Z',
        latestRelease: { version: '1.27.0' },
        ignoredVersions: [],
        updateInProgress: false,
        lastUpdateResult: null
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    const status = await getUpdateStatus();
    expect(status.updateAvailable).toBe(true);
  });

  it('should not detect update when versions are equal', async () => {
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: '2024-01-01T00:00:00Z',
        latestRelease: { version: '1.26.0' },
        ignoredVersions: [],
        updateInProgress: false,
        lastUpdateResult: null
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    const status = await getUpdateStatus();
    expect(status.updateAvailable).toBe(false);
  });

  it('should respect ignored versions', async () => {
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: '2024-01-01T00:00:00Z',
        latestRelease: { version: '1.27.0' },
        ignoredVersions: ['1.27.0'],
        updateInProgress: false,
        lastUpdateResult: null
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    const status = await getUpdateStatus();
    expect(status.updateAvailable).toBe(false);
  });

  it('should handle downgrade (remote older than current)', async () => {
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: '2024-01-01T00:00:00Z',
        latestRelease: { version: '1.26.0' },
        ignoredVersions: [],
        updateInProgress: false,
        lastUpdateResult: null
      })
      .mockResolvedValueOnce({ version: '1.27.0' });

    const status = await getUpdateStatus();
    expect(status.updateAvailable).toBe(false);
  });
});

describe('ignoreVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    atomicWrite.mockResolvedValue(undefined);
    ensureDir.mockResolvedValue(undefined);
  });

  it('should add version to ignore list', async () => {
    readJSONFile.mockResolvedValue({
      lastCheck: null,
      latestRelease: null,
      ignoredVersions: [],
      updateInProgress: false,
      lastUpdateResult: null
    });

    const state = await ignoreVersion('1.27.0');
    expect(state.ignoredVersions).toContain('1.27.0');
    expect(atomicWrite).toHaveBeenCalled();
  });

  it('should not duplicate ignored versions', async () => {
    readJSONFile.mockResolvedValue({
      lastCheck: null,
      latestRelease: null,
      ignoredVersions: ['1.27.0'],
      updateInProgress: false,
      lastUpdateResult: null
    });

    const state = await ignoreVersion('1.27.0');
    expect(state.ignoredVersions).toHaveLength(1);
    expect(atomicWrite).not.toHaveBeenCalled();
  });
});

describe('clearIgnored', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    atomicWrite.mockResolvedValue(undefined);
    ensureDir.mockResolvedValue(undefined);
  });

  it('should clear all ignored versions', async () => {
    readJSONFile.mockResolvedValue({
      lastCheck: null,
      latestRelease: null,
      ignoredVersions: ['1.27.0', '1.28.0'],
      updateInProgress: false,
      lastUpdateResult: null
    });

    const state = await clearIgnored();
    expect(state.ignoredVersions).toHaveLength(0);
    expect(atomicWrite).toHaveBeenCalled();
  });
});

describe('checkForUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    atomicWrite.mockResolvedValue(undefined);
    ensureDir.mockResolvedValue(undefined);
  });

  it('should detect update when remote version is newer', async () => {
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: null,
        latestRelease: null,
        ignoredVersions: [],
        updateInProgress: false,
        lastUpdateResult: null
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    execGh.mockResolvedValue(JSON.stringify({
      tag_name: 'v1.27.0',
      html_url: 'https://github.com/atomantic/PortOS/releases/tag/v1.27.0',
      published_at: '2024-01-15T00:00:00Z',
      body: 'Release notes'
    }));

    const result = await checkForUpdate();
    expect(result.updateAvailable).toBe(true);
    expect(result.currentVersion).toBe('1.26.0');
    expect(result.latestRelease.version).toBe('1.27.0');
  });

  it('should not detect update when versions match', async () => {
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: null,
        latestRelease: null,
        ignoredVersions: [],
        updateInProgress: false,
        lastUpdateResult: null
      })
      .mockResolvedValueOnce({ version: '1.27.0' });

    execGh.mockResolvedValue(JSON.stringify({
      tag_name: 'v1.27.0',
      html_url: 'https://github.com/atomantic/PortOS/releases/tag/v1.27.0',
      published_at: '2024-01-15T00:00:00Z',
      body: 'Release notes'
    }));

    const result = await checkForUpdate();
    expect(result.updateAvailable).toBe(false);
  });

  it('should emit update:available event when newer version found', async () => {
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: null,
        latestRelease: null,
        ignoredVersions: [],
        updateInProgress: false,
        lastUpdateResult: null
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    execGh.mockResolvedValue(JSON.stringify({
      tag_name: 'v1.27.0',
      html_url: 'https://github.com/atomantic/PortOS/releases/tag/v1.27.0',
      published_at: '2024-01-15T00:00:00Z',
      body: 'Release notes'
    }));

    const handler = vi.fn();
    updateEvents.on('update:available', handler);

    await checkForUpdate();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      currentVersion: '1.26.0',
      latestVersion: '1.27.0'
    }));

    updateEvents.removeListener('update:available', handler);
  });

  it('should strip v prefix from tag_name', async () => {
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: null,
        latestRelease: null,
        ignoredVersions: [],
        updateInProgress: false,
        lastUpdateResult: null
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    execGh.mockResolvedValue(JSON.stringify({
      tag_name: 'v2.0.0',
      html_url: '',
      published_at: '',
      body: ''
    }));

    const result = await checkForUpdate();
    expect(result.latestRelease.version).toBe('2.0.0');
  });
});

describe('clearStaleUpdateInProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    atomicWrite.mockResolvedValue(undefined);
    ensureDir.mockResolvedValue(undefined);
  });

  it('should return false when updateInProgress is false', async () => {
    readJSONFile.mockResolvedValue({
      lastCheck: null,
      latestRelease: null,
      ignoredVersions: [],
      updateInProgress: false,
      updateStartedAt: null,
      lastUpdateResult: null
    });

    const cleared = await clearStaleUpdateInProgress();
    expect(cleared).toBe(false);
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('should clear stale updateInProgress when updateStartedAt is older than 30 minutes', async () => {
    const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    readJSONFile.mockResolvedValue({
      lastCheck: null,
      latestRelease: { version: '1.28.0' },
      ignoredVersions: [],
      updateInProgress: true,
      updateStartedAt: staleTime,
      lastUpdateResult: null
    });

    const cleared = await clearStaleUpdateInProgress();
    expect(cleared).toBe(true);
    expect(atomicWrite).toHaveBeenCalled();
    const saved = JSON.parse(atomicWrite.mock.calls[0][1]);
    expect(saved.updateInProgress).toBe(false);
    expect(saved.updateStartedAt).toBeNull();
    expect(saved.lastUpdateResult.success).toBe(false);
    expect(saved.lastUpdateResult.version).toBe('1.28.0');
  });

  it('should clear updateInProgress when updateStartedAt is missing', async () => {
    readJSONFile.mockResolvedValue({
      lastCheck: null,
      latestRelease: null,
      ignoredVersions: [],
      updateInProgress: true,
      updateStartedAt: null,
      lastUpdateResult: null
    });

    const cleared = await clearStaleUpdateInProgress();
    expect(cleared).toBe(true);
    expect(atomicWrite).toHaveBeenCalled();
    const saved = JSON.parse(atomicWrite.mock.calls[0][1]);
    expect(saved.updateInProgress).toBe(false);
    expect(saved.lastUpdateResult.version).toBe('unknown');
  });

  it('should not clear updateInProgress when update is recent (< 30 min)', async () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
    readJSONFile.mockResolvedValue({
      lastCheck: null,
      latestRelease: { version: '1.28.0' },
      ignoredVersions: [],
      updateInProgress: true,
      updateStartedAt: recentTime,
      lastUpdateResult: null
    });

    const cleared = await clearStaleUpdateInProgress();
    expect(cleared).toBe(false);
    expect(atomicWrite).not.toHaveBeenCalled();
  });
});

describe('getRemoteInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to getOriginInfo from lib/gitRemote', async () => {
    const mock = {
      hasOrigin: true,
      originUrl: 'git@github.com:alice/PortOS.git',
      host: 'github.com',
      owner: 'alice',
      repo: 'PortOS',
      fullName: 'alice/PortOS',
      isUpstream: false,
      isGithub: true,
      isFork: true
    };
    getOriginInfo.mockResolvedValue(mock);
    await expect(getRemoteInfo()).resolves.toEqual(mock);
  });
});

describe('getUpdateStatus remoteInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes remoteInfo and upstream metadata', async () => {
    const remote = {
      hasOrigin: true,
      originUrl: 'git@github.com:alice/PortOS.git',
      host: 'github.com',
      owner: 'alice',
      repo: 'PortOS',
      fullName: 'alice/PortOS',
      isUpstream: false,
      isGithub: true,
      isFork: true
    };
    getOriginInfo.mockResolvedValue(remote);
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: null,
        latestRelease: { version: '1.27.0' },
        ignoredVersions: [],
        updateInProgress: false,
        lastUpdateResult: null
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    const status = await getUpdateStatus();
    expect(status.remoteInfo).toEqual(remote);
    expect(status.upstream).toEqual({ owner: 'atomantic', repo: 'PortOS', fullName: 'atomantic/PortOS' });
    expect(status.updateAvailable).toBe(true);
  });

  it('returns remoteInfo=null when origin lookup throws', async () => {
    getOriginInfo.mockRejectedValue(new Error('not a git repo'));
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: null,
        latestRelease: null,
        ignoredVersions: [],
        updateInProgress: false,
        lastUpdateResult: null
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    const status = await getUpdateStatus();
    expect(status.remoteInfo).toBeNull();
    expect(status.upstream.fullName).toBe('atomantic/PortOS');
  });

  it('forkSyncFresh is true within the freshness window for the same fork', async () => {
    const remote = {
      hasOrigin: true, originUrl: 'git@github.com:alice/PortOS.git', host: 'github.com',
      owner: 'alice', repo: 'PortOS', fullName: 'alice/PortOS',
      isUpstream: false, isGithub: true, isFork: true
    };
    getOriginInfo.mockResolvedValue(remote);
    const recent = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 min ago
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: null, latestRelease: null, ignoredVersions: [],
        updateInProgress: false, lastUpdateResult: null,
        lastForkSync: { fullName: 'alice/PortOS', syncedAt: recent }
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    const status = await getUpdateStatus();
    expect(status.forkSyncFresh).toBe(true);
    expect(status.forkSyncWindowMs).toBe(10 * 60 * 1000);
  });

  it('forkSyncFresh is false when lastForkSync is older than the window', async () => {
    const remote = {
      hasOrigin: true, originUrl: 'git@github.com:alice/PortOS.git', host: 'github.com',
      owner: 'alice', repo: 'PortOS', fullName: 'alice/PortOS',
      isUpstream: false, isGithub: true, isFork: true
    };
    getOriginInfo.mockResolvedValue(remote);
    const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: null, latestRelease: null, ignoredVersions: [],
        updateInProgress: false, lastUpdateResult: null,
        lastForkSync: { fullName: 'alice/PortOS', syncedAt: stale }
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    const status = await getUpdateStatus();
    expect(status.forkSyncFresh).toBe(false);
  });

  it('forkSyncFresh is case-insensitive on fullName (matches GitHub semantics)', async () => {
    const remote = {
      hasOrigin: true, originUrl: 'git@github.com:ALICE/PortOS.git', host: 'github.com',
      owner: 'ALICE', repo: 'PortOS', fullName: 'ALICE/PortOS',
      isUpstream: false, isGithub: true, isFork: true
    };
    getOriginInfo.mockResolvedValue(remote);
    const recent = new Date(Date.now() - 1 * 60 * 1000).toISOString();
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: null, latestRelease: null, ignoredVersions: [],
        updateInProgress: false, lastUpdateResult: null,
        // Stored with lowercase variant — should still match the uppercase origin
        lastForkSync: { fullName: 'alice/portos', syncedAt: recent }
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    const status = await getUpdateStatus();
    expect(status.forkSyncFresh).toBe(true);
  });

  it('forkSyncFresh is false when lastForkSync.fullName mismatches the current origin', async () => {
    const remote = {
      hasOrigin: true, originUrl: 'git@github.com:bob/PortOS.git', host: 'github.com',
      owner: 'bob', repo: 'PortOS', fullName: 'bob/PortOS',
      isUpstream: false, isGithub: true, isFork: true
    };
    getOriginInfo.mockResolvedValue(remote);
    const recent = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    readJSONFile
      .mockResolvedValueOnce({
        lastCheck: null, latestRelease: null, ignoredVersions: [],
        updateInProgress: false, lastUpdateResult: null,
        lastForkSync: { fullName: 'alice/PortOS', syncedAt: recent }
      })
      .mockResolvedValueOnce({ version: '1.26.0' });

    const status = await getUpdateStatus();
    expect(status.forkSyncFresh).toBe(false);
  });
});

describe('syncFork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    atomicWrite.mockResolvedValue(undefined);
    ensureDir.mockResolvedValue(undefined);
    readJSONFile.mockResolvedValue({
      lastCheck: null,
      latestRelease: null,
      ignoredVersions: [],
      updateInProgress: false,
      lastUpdateResult: null,
      lastForkSync: null
    });
  });

  it('runs gh repo sync against the user fork and the upstream source', async () => {
    getOriginInfo.mockResolvedValue({
      hasOrigin: true,
      originUrl: 'git@github.com:alice/PortOS.git',
      host: 'github.com',
      owner: 'alice',
      repo: 'PortOS',
      fullName: 'alice/PortOS',
      isUpstream: false,
      isGithub: true,
      isFork: true
    });
    execGh.mockResolvedValue('✓ Synced the "main" branch from atomantic/PortOS to alice/PortOS');

    const result = await syncFork();
    expect(execGh).toHaveBeenCalledWith([
      'repo', 'sync', 'alice/PortOS', '--source', 'atomantic/PortOS', '--branch', 'main'
    ]);
    expect(result.synced).toBe(true);
    expect(result.fullName).toBe('alice/PortOS');
    expect(result.source).toBe('atomantic/PortOS');
    expect(result.mergedBranch).toBe('main');
    expect(result.alreadyUpToDate).toBe(false);
  });

  it('detects already-up-to-date response', async () => {
    getOriginInfo.mockResolvedValue({
      hasOrigin: true,
      isGithub: true,
      isUpstream: false,
      isFork: true,
      fullName: 'alice/PortOS',
      owner: 'alice',
      repo: 'PortOS'
    });
    execGh.mockResolvedValue('✓ Repository is up to date with atomantic/PortOS');

    const result = await syncFork();
    expect(result.alreadyUpToDate).toBe(true);
  });

  it('respects an explicit branch argument', async () => {
    getOriginInfo.mockResolvedValue({
      hasOrigin: true,
      isGithub: true,
      isUpstream: false,
      isFork: true,
      fullName: 'alice/PortOS',
      owner: 'alice',
      repo: 'PortOS'
    });
    execGh.mockResolvedValue('✓ Synced');

    await syncFork({ branch: 'release' });
    expect(execGh).toHaveBeenCalledWith([
      'repo', 'sync', 'alice/PortOS', '--source', 'atomantic/PortOS', '--branch', 'release'
    ]);
  });

  it('refuses when there is no origin remote', async () => {
    getOriginInfo.mockResolvedValue({ hasOrigin: false, isGithub: false, isFork: false, isUpstream: false });
    await expect(syncFork()).rejects.toThrow(/no git origin/i);
    expect(execGh).not.toHaveBeenCalled();
  });

  it('refuses when origin is not on GitHub', async () => {
    getOriginInfo.mockResolvedValue({
      hasOrigin: true,
      isGithub: false,
      isFork: false,
      isUpstream: false,
      host: 'gitlab.com',
      fullName: 'team/PortOS'
    });
    await expect(syncFork()).rejects.toThrow(/github-only/i);
    expect(execGh).not.toHaveBeenCalled();
  });

  it('refuses when origin is already the upstream', async () => {
    getOriginInfo.mockResolvedValue({
      hasOrigin: true,
      isGithub: true,
      isUpstream: true,
      isFork: false,
      fullName: 'atomantic/PortOS'
    });
    await expect(syncFork()).rejects.toThrow(/already the upstream/i);
    expect(execGh).not.toHaveBeenCalled();
  });

  it('uses pre-fetched remoteInfo without re-spawning git', async () => {
    const remote = {
      hasOrigin: true, isGithub: true, isUpstream: false, isFork: true,
      fullName: 'alice/PortOS', owner: 'alice', repo: 'PortOS'
    };
    execGh.mockResolvedValue('✓ Synced');
    await syncFork({ remoteInfo: remote });
    expect(getOriginInfo).not.toHaveBeenCalled();
    expect(execGh).toHaveBeenCalledWith([
      'repo', 'sync', 'alice/PortOS', '--source', 'atomantic/PortOS', '--branch', 'main'
    ]);
  });

  it('refuses when origin is a GitHub repo but not a fork (renamed/unrelated)', async () => {
    getOriginInfo.mockResolvedValue({
      hasOrigin: true,
      isGithub: true,
      isUpstream: false,
      isFork: false,
      fullName: 'alice/MyCustomOS',
      owner: 'alice',
      repo: 'MyCustomOS'
    });
    await expect(syncFork()).rejects.toThrow(/not a fork of atomantic\/PortOS/i);
    expect(execGh).not.toHaveBeenCalled();
  });

  it('propagates gh CLI errors (diverged fork)', async () => {
    getOriginInfo.mockResolvedValue({
      hasOrigin: true,
      isGithub: true,
      isUpstream: false,
      isFork: true,
      fullName: 'alice/PortOS',
      owner: 'alice',
      repo: 'PortOS'
    });
    execGh.mockRejectedValue(new Error('failed to sync: the destination repository would not be a fast forward'));
    await expect(syncFork()).rejects.toThrow(/fast forward/i);
  });

  it('persists lastForkSync metadata to state on success', async () => {
    getOriginInfo.mockResolvedValue({
      hasOrigin: true,
      isGithub: true,
      isUpstream: false,
      isFork: true,
      fullName: 'alice/PortOS',
      owner: 'alice',
      repo: 'PortOS'
    });
    execGh.mockResolvedValue('✓ Synced');

    await syncFork();
    expect(atomicWrite).toHaveBeenCalled();
    const saved = JSON.parse(atomicWrite.mock.calls[0][1]);
    expect(saved.lastForkSync).toEqual(expect.objectContaining({
      fullName: 'alice/PortOS',
      source: 'atomantic/PortOS',
      branch: 'main',
      alreadyUpToDate: false
    }));
    expect(saved.lastForkSync.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('processUpdateMarker', () => {
  const ENOENT = Object.assign(new Error('not found'), { code: 'ENOENT' });

  beforeEach(() => {
    vi.clearAllMocks();
    // getCurrentVersion + loadState both read via readJSONFile — distinguish by path.
    readJSONFile.mockImplementation((p) =>
      String(p).endsWith('package.json') ? { version: '1.2.3' } : {});
  });

  it('returns silently and records nothing when no marker exists', async () => {
    readFile.mockRejectedValueOnce(ENOENT);
    await processUpdateMarker();
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('records success and removes the marker when versions match', async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ version: '1.2.3', completedAt: '2026-06-30T00:00:00Z' }));
    await processUpdateMarker();
    const saved = JSON.parse(atomicWrite.mock.calls.at(-1)[1]);
    expect(saved.lastUpdateResult).toMatchObject({ version: '1.2.3', success: true });
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('records failure when the marker version mismatches the running version', async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ version: '9.9.9', completedAt: '2026-06-30T00:00:00Z' }));
    await processUpdateMarker();
    const saved = JSON.parse(atomicWrite.mock.calls.at(-1)[1]);
    expect(saved.lastUpdateResult).toMatchObject({ version: '9.9.9', success: false });
    expect(saved.lastUpdateResult.log).toMatch(/mismatch/i);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('removes a corrupt (invalid JSON) marker without recording a result', async () => {
    readFile.mockResolvedValueOnce('{ not json');
    await processUpdateMarker();
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('removes a marker missing required fields without recording a result', async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ version: '1.2.3' })); // no completedAt
    await processUpdateMarker();
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledTimes(1);
  });
});
