import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'calendar-accounts-test-'));
const { getAuthStatus } = vi.hoisted(() => ({ getAuthStatus: vi.fn() }));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

vi.mock('../lib/uuid.js', () => ({
  v4: vi.fn().mockReturnValue('test-uuid-1234'),
}));

vi.mock('./googleAuth.js', () => ({ getAuthStatus }));

const calendarAccounts = await import('./calendarAccounts.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('calendarAccounts', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
    getAuthStatus.mockResolvedValue({ hasTokens: false });
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

    it.each([
      [{ hasTokens: true }, 'google-api'],
      [{ hasTokens: false }, 'claude-mcp'],
    ])('uses %o OAuth status to select %s for Google accounts', async (authStatus, syncMethod) => {
      getAuthStatus.mockResolvedValue(authStatus);

      const account = await calendarAccounts.createAccount({
        name: 'Google',
        type: 'google-calendar',
        subcalendars: [{ calendarId: 'primary', name: 'Primary' }],
      });

      expect(account.syncMethod).toBe(syncMethod);
      expect(account.subcalendars).toEqual([expect.objectContaining({
        calendarId: 'primary', name: 'Primary', enabled: true, dormant: false, goalIds: [],
      })]);
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

    // #5302: a Google MCP sync whose CLI exited non-zero with a possibly
    // truncated payload persists 'partial' — events kept, nothing pruned.
    // capabilityMap degrades a 'partial' account row to WARN, so this value
    // has to survive the store verbatim rather than being coerced to
    // success/error by a status enum added here later.
    it('persists a partial sync status verbatim', async () => {
      await calendarAccounts.createAccount({ name: 'Sync Test', type: 'google-calendar' });
      await calendarAccounts.updateSyncStatus('test-uuid-1234', 'partial');

      const account = await calendarAccounts.getAccount('test-uuid-1234');
      expect(account.lastSyncStatus).toBe('partial');
    });

    it('preserves a concurrent account edit', async () => {
      await calendarAccounts.createAccount({ name: 'Sync Test', type: 'outlook-calendar' });

      await Promise.all([
        calendarAccounts.updateAccount('test-uuid-1234', { name: 'Renamed' }),
        calendarAccounts.updateSyncStatus('test-uuid-1234', 'success'),
      ]);

      const account = await calendarAccounts.getAccount('test-uuid-1234');
      expect(account).toMatchObject({ name: 'Renamed', lastSyncStatus: 'success' });
      expect(account.lastSyncAt).toBeTruthy();
    });
  });

  describe('updateSubcalendars', () => {
    it.each([
      [{ calendarId: 'primary', name: 'Primary' }, {
        calendarId: 'primary', name: 'Primary', color: '', enabled: true, dormant: false, goalIds: [],
      }],
      [{ calendarId: 'team', name: 'Team', color: '#123456', enabled: false, dormant: true, goalIds: ['goal-1'], addedAt: '2026-01-01T00:00:00.000Z' }, {
        calendarId: 'team', name: 'Team', color: '#123456', enabled: false, dormant: true, goalIds: ['goal-1'], addedAt: '2026-01-01T00:00:00.000Z',
      }],
    ])('normalizes subcalendar input %#', async (input, expected) => {
      await calendarAccounts.createAccount({ name: 'Google', type: 'google-calendar' });

      const account = await calendarAccounts.updateSubcalendars('test-uuid-1234', [input]);

      expect(account.subcalendars[0]).toMatchObject(expected);
      expect(account.updatedAt).toBeTruthy();
    });

    it('returns null for an absent account id', async () => {
      await expect(calendarAccounts.updateSubcalendars('absent-id', [])).resolves.toBeNull();
    });
  });

  describe('mergeDiscoveredSubcalendars', () => {
    it.each([
      [[], [{ id: 'primary', name: 'Primary', color: '#abcdef' }], [{
        calendarId: 'primary', name: 'Primary', color: '#abcdef', enabled: false, dormant: false, goalIds: [],
      }]],
      [[{ calendarId: 'team', name: 'Old name', color: '#111111', enabled: true, dormant: true, goalIds: ['goal-1'], addedAt: '2026-01-01T00:00:00.000Z' }], [{ id: 'team', name: 'New name' }], [{
        calendarId: 'team', name: 'New name', color: '#111111', enabled: true, dormant: true, goalIds: ['goal-1'], addedAt: '2026-01-01T00:00:00.000Z',
      }]],
      [[{ calendarId: 'hidden', name: 'Hidden' }], [{ id: 'primary' }], [{
        calendarId: 'primary', name: 'primary', color: '', enabled: false, dormant: false, goalIds: [],
      }]],
    ])('merges discovered calendars without retaining removed entries %#', (existing, discovered, expected) => {
      expect(calendarAccounts.mergeDiscoveredSubcalendars(existing, discovered)).toEqual(
        expected.map(calendar => expect.objectContaining(calendar)),
      );
    });
  });
});
