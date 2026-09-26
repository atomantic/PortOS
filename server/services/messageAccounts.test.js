import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'message-accounts-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...makePathsProxy(actual, { dataRoot: TEST_DATA_ROOT }),
    atomicWrite: vi.fn(actual.atomicWrite)
  };
});

vi.mock('../lib/uuid.js', () => ({
  v4: vi.fn().mockReturnValue('msg-uuid-5678'),
}));

const messageAccounts = await import('./messageAccounts.js');
const { atomicWrite } = await import('../lib/fileUtils.js');
const { atomicWrite: persist } = await vi.importActual('../lib/fileUtils.js');
const { v4: uuid } = await import('../lib/uuid.js');

// Pause persistence after its read so competing service calls overlap deterministically.
function holdNextWrite({ fail = false } = {}) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  atomicWrite.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    if (fail) throw new Error('synthetic persistence failure');
    return persist(...args);
  });
  return { entered: entered.promise, release: release.resolve };
}

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('messageAccounts', () => {
  beforeEach(() => {
    atomicWrite.mockReset().mockImplementation(persist);
    uuid.mockReset().mockReturnValue('msg-uuid-5678');
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
  describe('concurrent persistence', () => {
    it.each(['same account', 'different accounts'])('preserves edits and sync status for %s', async (scope) => {
      uuid.mockReturnValueOnce('account-a').mockReturnValueOnce('account-b');
      await messageAccounts.createAccount({ name: 'Account A', type: 'gmail' });
      await messageAccounts.createAccount({ name: 'Account B', type: 'gmail' });
      const barrier = holdNextWrite();
      const edit = messageAccounts.updateAccount('account-a', { enabled: false });
      await barrier.entered;
      const statusId = scope === 'same account' ? 'account-a' : 'account-b';
      const status = messageAccounts.updateSyncStatus(statusId, 'success');
      barrier.release();
      await Promise.all([edit, status]);
      expect(await messageAccounts.getAccount('account-a')).toMatchObject({ enabled: false });
      expect(await messageAccounts.getAccount(statusId)).toMatchObject({ lastSyncStatus: 'success' });
    });

    it('does not resurrect a deleted account through queued sync metadata writes', async () => {
      const account = await messageAccounts.createAccount({ name: 'Account A', type: 'gmail' });
      const barrier = holdNextWrite();
      const deletion = messageAccounts.deleteAccount(account.id);
      await barrier.entered;
      const metadata = [
        messageAccounts.updateSyncStatus(account.id, 'success'),
        messageAccounts.updateSendAsAliases(account.id, ['alias@example.com']),
        messageAccounts.markSentIngested(account.id)
      ];
      barrier.release();
      expect(await deletion).toBe(true);
      expect(await Promise.all(metadata)).toEqual([null, null, null]);
      expect(await messageAccounts.listAccounts()).toEqual([]);
    });

    it('preserves concurrent creates and subsequent alias and coverage changes', async () => {
      uuid.mockReturnValueOnce('account-a').mockReturnValueOnce('account-b');
      const barrier = holdNextWrite();
      const first = messageAccounts.createAccount({ name: 'Account A', type: 'gmail' });
      await barrier.entered;
      const second = messageAccounts.createAccount({ name: 'Account B', type: 'gmail' });
      const aliases = messageAccounts.updateSendAsAliases('account-a', [' ALIAS@example.com ']);
      const watermark = messageAccounts.markSentIngested('account-b', { at: '2026-01-01T00:00:00.000Z', partial: true });
      barrier.release();
      await Promise.all([first, second, aliases, watermark]);
      expect(await messageAccounts.listAccounts()).toEqual([
        expect.objectContaining({ id: 'account-a', sendAsAliases: ['alias@example.com'] }),
        expect.objectContaining({ id: 'account-b', sentIngestedAt: '2026-01-01T00:00:00.000Z', sentCoveragePartial: true })
      ]);
    });

    it('rejects a failed save and lets a queued write use the last persisted state', async () => {
      const account = await messageAccounts.createAccount({ name: 'Account A', type: 'gmail' });
      const barrier = holdNextWrite({ fail: true });
      const edit = messageAccounts.updateAccount(account.id, { enabled: false });
      const rejected = expect(edit).rejects.toThrow('synthetic persistence failure');
      await barrier.entered;
      const status = messageAccounts.updateSyncStatus(account.id, 'success');
      barrier.release();
      await rejected;
      await status;
      expect(await messageAccounts.getAccount(account.id)).toMatchObject({
        enabled: true, lastSyncStatus: 'success'
      });
    });
  });

});
