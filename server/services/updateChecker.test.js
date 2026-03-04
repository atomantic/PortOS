import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the module
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/fileUtils.js', () => ({
  readJSONFile: vi.fn(),
  PATHS: {
    root: '/mock',
    data: '/mock/data'
  },
  ensureDir: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../lib/asyncMutex.js', () => ({
  createMutex: () => (fn) => fn()
}));

vi.mock('./github.js', () => ({
  execGh: vi.fn()
}));

import { writeFile } from 'fs/promises';
import { readJSONFile, ensureDir } from '../lib/fileUtils.js';
import { execGh } from './github.js';
import {
  compareSemver,
  getCurrentVersion,
  getUpdateStatus,
  ignoreVersion,
  clearIgnored,
  checkForUpdate,
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
    writeFile.mockResolvedValue(undefined);
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
    expect(writeFile).toHaveBeenCalled();
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
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('clearIgnored', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeFile.mockResolvedValue(undefined);
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
    expect(writeFile).toHaveBeenCalled();
  });
});

describe('checkForUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeFile.mockResolvedValue(undefined);
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
