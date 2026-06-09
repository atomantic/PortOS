import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'calendar-accounts-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), {
    dataRoot: TEST_DATA_ROOT,
    extraOverrides: (root) => ({ calendar: join(root, 'calendar') }),
  }));

vi.mock('../lib/uuid.js', () => ({
  v4: vi.fn().mockReturnValue('test-uuid-1234'),
}));

const calendarAccounts = await import('./calendarAccounts.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('calendarAccounts', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
  });

  describe('createAccount', () => {
    it('creates an account with field defaults', async () => {
      const acc = await calendarAccounts.createAccount({
        name: 'Work Cal',
        type: 'outlook-calendar',
        email: 'work@example.com',
      });

      expect(acc.id).toBe('test-uuid-1234');
      expect(acc.name).toBe('Work Cal');
      expect(acc.type).toBe('outlook-calendar');
      expect(acc.email).toBe('work@example.com');
      expect(acc.enabled).toBe(true);
      expect(acc.lastSyncAt).toBeNull();
      expect(acc.lastSyncStatus).toBeNull();
      expect(acc.createdAt).toBeTruthy();
      expect(acc.syncConfig.maxAge).toBe('90d');
      expect(acc.syncConfig.syncInterval).toBe(300000);
      expect(acc.syncConfig.calendarIds).toEqual(['default']);
    });

    it('defaults email to empty string when not provided', async () => {
      const acc = await calendarAccounts.createAccount({
        name: 'Personal',
        type: 'outlook-calendar',
      });
      expect(acc.email).toBe('');
    });
  });

  describe('updateAccount', () => {
    it('merges partial fields without clobbering existing fields', async () => {
      await calendarAccounts.createAccount({ name: 'My Cal', type: 'outlook-calendar', email: 'a@b.com' });
      const updated = await calendarAccounts.updateAccount('test-uuid-1234', { name: 'Updated Cal' });

      expect(updated.name).toBe('Updated Cal');
      expect(updated.email).toBe('a@b.com'); // untouched
      expect(updated.type).toBe('outlook-calendar'); // untouched
    });

    it('returns null for a missing id', async () => {
      const result = await calendarAccounts.updateAccount('no-such-id', { name: 'x' });
      expect(result).toBeNull();
    });
  });

  describe('deleteAccount', () => {
    it('removes the account and returns true', async () => {
      await calendarAccounts.createAccount({ name: 'Del Me', type: 'outlook-calendar' });
      const result = await calendarAccounts.deleteAccount('test-uuid-1234');
      expect(result).toBe(true);

      const list = await calendarAccounts.listAccounts();
      expect(list).toHaveLength(0);
    });

    it('returns false for a missing id', async () => {
      const result = await calendarAccounts.deleteAccount('ghost-id');
      expect(result).toBe(false);
    });
  });

  describe('updateSyncStatus', () => {
    it('stamps lastSyncAt and lastSyncStatus', async () => {
      await calendarAccounts.createAccount({ name: 'Sync Test', type: 'outlook-calendar' });
      const result = await calendarAccounts.updateSyncStatus('test-uuid-1234', 'success');

      expect(result.lastSyncStatus).toBe('success');
      expect(result.lastSyncAt).toBeTruthy();
    });

    it('returns null for an absent account id', async () => {
      const result = await calendarAccounts.updateSyncStatus('absent-id', 'ok');
      expect(result).toBeNull();
    });
  });
});
