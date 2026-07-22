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
  updateSyncStatus: vi.fn(),
  markSentIngested: vi.fn(() => Promise.resolve()),
  updateSendAsAliases: vi.fn(() => Promise.resolve()),
}));

// Keep the REAL pure helpers (notably `newlyLearnedAliases` — re-stating it in a
// mock would test the mock) and stub only the DB-touching entry points.
const stripParticipantsForAccount = vi.fn(() => Promise.resolve(2));
vi.mock('./humanActivity.js', async (importOriginal) => ({
  ...(await importOriginal()),
  stripParticipantsForAccount,
  recordEvents: vi.fn(() => Promise.resolve({ recorded: 0, skipped: 0 })),
}));

const { repairActivityAliasParticipants } = await import('./messageSync.js');

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
