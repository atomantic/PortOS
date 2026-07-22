/**
 * Tests for migration 001 (#2855) — no live DB: the pg transaction client is a
 * stub that records the statements the migration issues, and the accounts file
 * read is mocked. Asserts the migration reads each account's ALREADY-stored
 * send-as aliases and issues the scoped repair on the supplied transaction client
 * (the gap the sync-path delta trigger can't close, since the set never changes
 * again on an install that learned it under an earlier build).
 *
 * Also pins the absent-vs-failed distinction: the runner records this migration
 * as applied the moment `up()` returns, so a swallowed read failure would mark
 * the one-shot backfill done and it could never run again. Only ENOENT is "no
 * work"; every other failure must throw so the migration rolls back unapplied.
 *
 * `*.test.js` files in this directory are ignored by the migration runner.
 */
import { describe, it, expect, vi } from 'vitest';

// Each test sets its own readFile implementation, and the client stub is rebuilt
// per test, so no beforeEach reset is needed — and adding one is actively harmful:
// under vitest 4, clearing this factory-created mock makes the errors its
// implementation throws surface as unhandled test failures even though up()
// catches them.
const readFile = vi.fn();
vi.mock('fs/promises', () => ({ readFile }));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { messages: '/mock/data/messages', data: '/mock/data' },
  tryReadFile: vi.fn(),
  safeJSONParse: (content, fallback) => { try { return JSON.parse(content); } catch { return fallback; } },
  ensureDir: vi.fn(),
  atomicWrite: vi.fn(),
}));

const { up } = await import('./001-strip-send-as-aliases-from-activity-participants.js');

const makeClient = () => {
  const calls = [];
  return { calls, query: (sql, params) => { calls.push({ sql, params }); return Promise.resolve({ rowCount: 1 }); } };
};

const enoent = () => Object.assign(new Error('no such file'), { code: 'ENOENT' });
const ioError = () => Object.assign(new Error('permission denied'), { code: 'EACCES' });

describe('migration 001 — strip send-as aliases from activity participants (#2855)', () => {
  it('repairs each account that already has stored aliases, scoped by id + type', async () => {
    readFile.mockResolvedValue(JSON.stringify({
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

  it('skips accounts with no aliases, no id, or one that never learned any', async () => {
    readFile.mockResolvedValue(JSON.stringify({
      a: { id: 'acct-a', type: 'gmail', sendAsAliases: [] },
      b: { id: 'acct-b', type: 'outlook' },
      c: { type: 'gmail', sendAsAliases: ['x@example.com'] }, // no id — unscopeable
    }));
    const client = makeClient();
    await up(client);
    expect(client.calls).toHaveLength(0);
  });

  it('is a no-op on an install with no message accounts file (ENOENT is genuine "no work")', async () => {
    readFile.mockImplementation(() => { throw enoent(); });
    const client = makeClient();
    await expect(up(client)).resolves.toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });

  // The three cases below MUST throw. Returning normally would let the runner
  // record the migration as applied, permanently skipping the one-shot backfill —
  // and the sync-time delta can't recover it, because those aliases are already
  // stored so the delta is empty forever.
  it('throws when the accounts file exists but cannot be read, so the migration retries next boot', async () => {
    readFile.mockImplementation(() => { throw ioError(); });
    await expect(up(makeClient())).rejects.toThrow(/cannot read data\/messages\/accounts\.json/);
  });

  it('throws when the accounts file is malformed JSON', async () => {
    readFile.mockResolvedValue('{ not json');
    await expect(up(makeClient())).rejects.toThrow(/not valid JSON/);
  });

  it('throws when the accounts file parses to a non-object', async () => {
    readFile.mockResolvedValue('[]');
    await expect(up(makeClient())).rejects.toThrow(/did not contain an account map/);
  });

  it('never leaks the absolute accounts path (which embeds the OS username) into an error', async () => {
    readFile.mockImplementation(() => { throw ioError(); });
    const err = await up(makeClient()).catch((e) => e);
    expect(err.message).not.toContain('/mock/data/messages');
    expect(err.message).toContain('data/messages/accounts.json');
  });
});
