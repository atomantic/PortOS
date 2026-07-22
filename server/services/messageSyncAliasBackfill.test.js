/**
 * Wiring test for the send-as-alias activity backfill (#2855).
 *
 * The pure diff (`newlyLearnedAliases`) and the JSONB repair
 * (`stripParticipantsForAccount`) are covered in humanActivity.test.js /
 * humanActivity.db.test.js. What's asserted here is the piece neither covers:
 * that a sync which learns a NEW alias triggers the repair with the right scope,
 * and that a sync with an unchanged alias set touches the DB not at all.
 *
 * Lives in its own file so `./humanActivity.js` can be mocked wholesale without
 * affecting the rest of messageSync.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn(),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn(),
  // `data` is needed too: the real humanActivity.js (kept unmocked for its pure
  // helpers) pulls in lib/timezone.js → services/settings.js, which resolves a
  // settings path at module load.
  PATHS: { messages: '/mock/data/messages', data: '/mock/data' },
  safeJSONParse: vi.fn((content, fallback) => (content ? JSON.parse(content) : fallback)),
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  safeDate: (d) => { const t = new Date(d).getTime(); return Number.isNaN(t) ? 0 : t; },
  filterBySearch: (items) => items,
}));

vi.mock('./messageAccounts.js', () => ({
  getAccount: vi.fn(),
  updateSyncStatus: vi.fn(() => Promise.resolve()),
  markSentIngested: vi.fn(() => Promise.resolve()),
  updateSendAsAliases: vi.fn(() => Promise.resolve()),
}));

vi.mock('./messageGmailSync.js', () => ({ syncGmail: vi.fn() }));

// tribe.js is loaded dynamically by logMessageTouchpoints; stub it so the sync
// path doesn't need a live Postgres.
vi.mock('./tribe.js', () => ({
  autoLogTouchpoints: vi.fn().mockResolvedValue({ created: 0, matched: 0 }),
}));

// Keep the REAL pure helpers (notably `newlyLearnedAliases` — re-stating it in a
// mock would test the mock) and stub only the DB-touching entry points.
const stripParticipantsForAccount = vi.fn(() => Promise.resolve(2));
vi.mock('./humanActivity.js', async (importOriginal) => ({
  ...(await importOriginal()),
  stripParticipantsForAccount,
  recordEvents: vi.fn(() => Promise.resolve({ recorded: 0, skipped: 0 })),
}));

const { repairActivityAliasParticipants, syncAccount } = await import('./messageSync.js');
const { getAccount, updateSendAsAliases } = await import('./messageAccounts.js');
const { syncGmail } = await import('./messageGmailSync.js');
const { tryReadFile } = await import('../lib/fileUtils.js');

const account = { id: 'acct-1', type: 'gmail', email: 'me@example.com' };

describe('repairActivityAliasParticipants (#2855)', () => {
  beforeEach(() => stripParticipantsForAccount.mockClear());

  it('repairs scoped to the account + source when an alias is learned for the first time', async () => {
    await repairActivityAliasParticipants(account, undefined, ['alias@example.com']);
    expect(stripParticipantsForAccount).toHaveBeenCalledWith('acct-1', 'gmail', ['alias@example.com']);
  });

  it('repairs only the newly-added alias when the set grows', async () => {
    await repairActivityAliasParticipants(account, ['old@example.com'], ['old@example.com', 'new@example.com']);
    expect(stripParticipantsForAccount).toHaveBeenCalledWith('acct-1', 'gmail', ['new@example.com']);
  });

  it('does no DB work when the alias set is unchanged (every routine sync)', async () => {
    await repairActivityAliasParticipants(account, ['a@example.com'], ['A@example.com']);
    expect(stripParticipantsForAccount).not.toHaveBeenCalled();
  });

  it('does no DB work when an alias is only removed', async () => {
    await repairActivityAliasParticipants(account, ['a@example.com', 'b@example.com'], ['a@example.com']);
    expect(stripParticipantsForAccount).not.toHaveBeenCalled();
  });

  it('falls back to a generic source when the account has no type', async () => {
    await repairActivityAliasParticipants({ id: 'acct-2' }, [], ['x@example.com']);
    expect(stripParticipantsForAccount).toHaveBeenCalledWith('acct-2', 'message', ['x@example.com']);
  });
});

// Regression: the ORDER of repair-vs-persist inside syncAccount (#2855).
//
// Persisting the learned alias set before the repair succeeds makes a transient
// repair failure PERMANENT: the stored set never changes again, so every later
// sync computes an empty delta and the stale rows are never retried. The repair
// must therefore run first, and the persist must be skipped when it fails.
describe('syncAccount alias repair/persist ordering (#2855)', () => {
  const ACCT = '22222222-2222-2222-2222-222222222222';
  const mockIo = { emit: vi.fn() };

  const runSync = async ({ storedAliases, fetchedAliases }) => {
    getAccount.mockResolvedValue({
      id: ACCT, name: 'Gmail', type: 'gmail', email: 'me@example.com',
      enabled: true, sendAsAliases: storedAliases,
    });
    tryReadFile.mockResolvedValue(JSON.stringify({ syncCursor: null, messages: [] }));
    syncGmail.mockResolvedValue({ messages: [], sentMessages: [], status: 'success', sendAsAliases: fetchedAliases });
    return syncAccount(ACCT, mockIo);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stripParticipantsForAccount.mockResolvedValue(2);
  });

  it('repairs BEFORE persisting, so the persist reflects a completed repair', async () => {
    const order = [];
    stripParticipantsForAccount.mockImplementation(() => { order.push('repair'); return Promise.resolve(1); });
    updateSendAsAliases.mockImplementation(() => { order.push('persist'); return Promise.resolve(); });

    await runSync({ storedAliases: [], fetchedAliases: ['alias@example.com'] });

    expect(order).toEqual(['repair', 'persist']);
    expect(stripParticipantsForAccount).toHaveBeenCalledWith(ACCT, 'gmail', ['alias@example.com']);
  });

  it('does NOT persist the new alias set when the repair fails, so the next sync retries', async () => {
    stripParticipantsForAccount.mockRejectedValue(new Error('transient DB failure'));

    const result = await runSync({ storedAliases: [], fetchedAliases: ['alias@example.com'] });

    // The failure must not fail the sync — it is a secondary effect.
    expect(result.status).toBe('success');
    // …and critically, the alias set stays unpersisted: leaving the stored set at
    // its old value is what keeps the delta non-empty on the next sync. Persisting
    // here would zero the delta forever and strand the stale rows.
    expect(updateSendAsAliases).not.toHaveBeenCalled();
  });

  it('still persists when there is nothing to repair (alias removed → empty delta)', async () => {
    await runSync({ storedAliases: ['a@example.com', 'b@example.com'], fetchedAliases: ['a@example.com'] });

    expect(stripParticipantsForAccount).not.toHaveBeenCalled();
    // A removal changes the set without producing newly-learned aliases — the
    // persist must still happen or the removal would never be recorded.
    expect(updateSendAsAliases).toHaveBeenCalledWith(ACCT, ['a@example.com']);
  });
});
