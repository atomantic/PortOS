/**
 * Tests for migration 001 (#2855) — no live DB: the pg transaction client is a
 * stub that records the statements the migration issues, and the accounts file
 * is mocked. Asserts the migration reads each account's ALREADY-stored send-as
 * aliases and issues the scoped repair on the supplied transaction client (the
 * gap the sync-path delta trigger can't close, since the set never changes again
 * on an install that learned it under an earlier build).
 *
 * `*.test.js` files in this directory are ignored by the migration runner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const tryReadFile = vi.fn();
vi.mock('../../lib/fileUtils.js', () => ({
  tryReadFile,
  PATHS: { messages: '/mock/data/messages', data: '/mock/data' },
  safeJSONParse: (content, fallback) => { try { return JSON.parse(content); } catch { return fallback; } },
  ensureDir: vi.fn(),
  atomicWrite: vi.fn(),
}));

const { up } = await import('./001-strip-send-as-aliases-from-activity-participants.js');

const makeClient = () => {
  const calls = [];
  return { calls, query: (sql, params) => { calls.push({ sql, params }); return Promise.resolve({ rowCount: 1 }); } };
};

const accountsFile = (accounts) => JSON.stringify(accounts);

describe('migration 001 — strip send-as aliases from activity participants (#2855)', () => {
  beforeEach(() => tryReadFile.mockReset());

  it('repairs each account that already has stored aliases, scoped by id + type', async () => {
    tryReadFile.mockResolvedValue(accountsFile({
      a: { id: 'acct-a', type: 'gmail', sendAsAliases: ['Alias@Example.com'] },
      b: { id: 'acct-b', type: 'outlook', sendAsAliases: ['b1@example.com', 'b2@example.com'] },
    }));
    const client = makeClient();
    await up(client);
    expect(client.calls).toHaveLength(2);
    // Aliases are normalized (lowercased) before they reach the statement.
    expect(client.calls[0].params).toEqual(['acct-a', 'gmail', ['alias@example.com']]);
    expect(client.calls[1].params).toEqual(['acct-b', 'outlook', ['b1@example.com', 'b2@example.com']]);
    expect(client.calls[0].sql).toContain('UPDATE human_activity_events');
  });

  it('skips accounts with no aliases, no id, or a non-Gmail account that never learned any', async () => {
    tryReadFile.mockResolvedValue(accountsFile({
      a: { id: 'acct-a', type: 'gmail', sendAsAliases: [] },
      b: { id: 'acct-b', type: 'outlook' },
      c: { type: 'gmail', sendAsAliases: ['x@example.com'] }, // no id — unscopeable
    }));
    const client = makeClient();
    await up(client);
    expect(client.calls).toHaveLength(0);
  });

  it('is a no-op on an install with no message accounts file', async () => {
    tryReadFile.mockResolvedValue(null);
    const client = makeClient();
    await up(client);
    expect(client.calls).toHaveLength(0);
  });

  it('is a no-op when the accounts file is corrupt or not an object', async () => {
    const client = makeClient();
    tryReadFile.mockResolvedValue('{ not json');
    await up(client);
    tryReadFile.mockResolvedValue('[]');
    await up(client);
    expect(client.calls).toHaveLength(0);
  });
});
