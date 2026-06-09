import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'message-accounts-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), {
    dataRoot: TEST_DATA_ROOT,
    extraOverrides: (root) => ({ messages: join(root, 'messages') }),
  }));

vi.mock('../lib/uuid.js', () => ({
  v4: vi.fn().mockReturnValue('msg-uuid-5678'),
}));

const messageAccounts = await import('./messageAccounts.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('messageAccounts', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
  });

  describe('createAccount', () => {
    it('creates a gmail account with correct defaults', async () => {
      const acc = await messageAccounts.createAccount({
        name: 'Gmail Work',
        type: 'gmail',
        email: 'user@gmail.com',
      });

      expect(acc.id).toBe('msg-uuid-5678');
      expect(acc.name).toBe('Gmail Work');
      expect(acc.type).toBe('gmail');
      expect(acc.provider).toBe('api');
      expect(acc.email).toBe('user@gmail.com');
      expect(acc.enabled).toBe(true);
      expect(acc.lastSyncAt).toBeNull();
      expect(acc.lastSyncStatus).toBeNull();
      expect(acc.createdAt).toBeTruthy();
      expect(acc.syncConfig.maxAge).toBe('30d');
      expect(acc.syncConfig.maxMessages).toBe(500);
      expect(acc.syncConfig.syncInterval).toBe(300000);
    });

    it('sets provider to playwright for non-gmail types', async () => {
      const acc = await messageAccounts.createAccount({ name: 'Outlook', type: 'outlook' });
      expect(acc.provider).toBe('playwright');
    });

    it('defaults email to empty string when omitted', async () => {
      const acc = await messageAccounts.createAccount({ name: 'No Email', type: 'gmail' });
      expect(acc.email).toBe('');
    });
  });

  describe('updateAccount', () => {
    it('merges partial updates without overwriting untouched fields', async () => {
      await messageAccounts.createAccount({ name: 'Old Name', type: 'gmail', email: 'a@b.com' });
      const updated = await messageAccounts.updateAccount('msg-uuid-5678', { name: 'New Name' });

      expect(updated.name).toBe('New Name');
      expect(updated.email).toBe('a@b.com'); // untouched
    });

    it('returns null for a missing id', async () => {
      const result = await messageAccounts.updateAccount('no-such-id', { name: 'x' });
      expect(result).toBeNull();
    });
  });

  describe('deleteAccount', () => {
    it('removes the account and returns true', async () => {
      await messageAccounts.createAccount({ name: 'Delete Me', type: 'gmail' });
      const result = await messageAccounts.deleteAccount('msg-uuid-5678');
      expect(result).toBe(true);

      const list = await messageAccounts.listAccounts();
      expect(list).toHaveLength(0);
    });

    it('returns false for a missing id', async () => {
      const result = await messageAccounts.deleteAccount('ghost');
      expect(result).toBe(false);
    });
  });

  describe('updateSyncStatus', () => {
    it('stamps lastSyncAt and lastSyncStatus', async () => {
      await messageAccounts.createAccount({ name: 'Sync Me', type: 'gmail' });
      const result = await messageAccounts.updateSyncStatus('msg-uuid-5678', 'ok');

      expect(result.lastSyncStatus).toBe('ok');
      expect(result.lastSyncAt).toBeTruthy();
    });

    it('returns null for an absent id', async () => {
      const result = await messageAccounts.updateSyncStatus('absent-id', 'fail');
      expect(result).toBeNull();
    });
  });
});
