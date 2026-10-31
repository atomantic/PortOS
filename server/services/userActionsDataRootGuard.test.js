/**
 * A test that reaches the operator-action ledger must not read or write the
 * install's live data tree. In a CoS worktree the checkout's own data/ is
 * intentionally disposable, so point PATHS.data at the protected install root
 * rather than assuming the checkout and install roots are the same.
 *
 * Stub the file I/O as a backstop: if the guard regresses, these tests must
 * fail without reading or changing the user's ledger.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { join } = await import('node:path');
  const { resolveCodeRootForModule } = await import('../lib/dataRoot.js');
  const { _resolveGuardRoots } = await import('../lib/testDataIsolation.js');
  const protectedRoot = _resolveGuardRoots(resolveCodeRootForModule(import.meta.url)).root;
  const unexpectedIo = () => { throw new Error('Unexpected ledger file I/O'); };
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: join(protectedRoot, 'guard-test') },
    readJSONFile: vi.fn(unexpectedIo),
    ensureDir: vi.fn(unexpectedIo),
    atomicWrite: vi.fn(unexpectedIo),
  };
});

import { atomicWrite, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { listUserActions, recordUserAction } from './userActions.js';

afterEach(() => vi.clearAllMocks());

describe('user-action ledger — data-root guard (#5605)', () => {
  it('rejects a write to the protected data tree before touching the ledger', async () => {
    await expect(recordUserAction({
      type: 'cos.task.create',
      summary: 'Guard regression probe',
      dedupeKey: 'guard-probe',
    })).rejects.toThrow(/real data\/ tree/);
    expect(readJSONFile).not.toHaveBeenCalled();
    expect(ensureDir).not.toHaveBeenCalled();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('rejects a read from the protected data tree before touching the ledger', async () => {
    await expect(listUserActions()).rejects.toThrow(/real data\/ tree/);
    expect(readJSONFile).not.toHaveBeenCalled();
  });
});
