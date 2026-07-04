/**
 * Unit tests for deleteBackup filename validation (issue #1822).
 *
 * Backup archives are named like `agents-2026-06-30T12-34-56.tar.gz`, so the
 * raw filename legitimately contains dots. The validation must accept that
 * shape while rejecting traversal/wildcard names — the old dot-stripping
 * double-pass never validated the real dotted filename, leaving only the
 * startsWith(backupDir) guard against traversal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises so deleteBackup's rm is a no-op spy — the accept path must
// not touch the real filesystem, and reject paths throw before rm is reached.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, rm: vi.fn().mockResolvedValue(undefined) };
});

import { rm } from 'fs/promises';
import { deleteBackup } from './dataManager.js';

describe('deleteBackup filename validation (#1822)', () => {
  beforeEach(() => {
    rm.mockClear();
  });

  it('accepts a real dotted backup archive name', async () => {
    const result = await deleteBackup('agents-2026-06-30T12-34-56.tar.gz');
    expect(result).toEqual({ deleted: 'agents-2026-06-30T12-34-56.tar.gz' });
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it('rejects ".." traversal without touching the filesystem', async () => {
    await expect(deleteBackup('../secrets.json')).rejects.toThrow('Invalid filename');
    await expect(deleteBackup('a/../../etc/passwd')).rejects.toThrow('Invalid filename');
    expect(rm).not.toHaveBeenCalled();
  });

  it('rejects the bare "." and ".." entries (which resolve to the backup dir / its parent)', async () => {
    await expect(deleteBackup('.')).rejects.toThrow('Invalid filename');
    await expect(deleteBackup('..')).rejects.toThrow('Invalid filename');
    expect(rm).not.toHaveBeenCalled();
  });

  it('rejects path separators and other unsafe characters', async () => {
    await expect(deleteBackup('sub/dir.tar.gz')).rejects.toThrow('Invalid filename');
    await expect(deleteBackup('name with spaces.tar.gz')).rejects.toThrow('Invalid filename');
    await expect(deleteBackup('weird$name.tar.gz')).rejects.toThrow('Invalid filename');
    expect(rm).not.toHaveBeenCalled();
  });
});
