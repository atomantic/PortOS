import { beforeEach, describe, expect, it, vi } from 'vitest';

const pool = vi.hoisted(() => ({
  client: null,
  connect: vi.fn(),
  on: vi.fn(),
  query: vi.fn(),
}));

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(function Pool() { return pool; }),
  },
}));

import { withTransaction } from './db.js';

function makeClient(query) {
  return {
    query,
    release: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.connect.mockImplementation(async () => pool.client);
});

describe('withTransaction', () => {
  it('releases the checked-out client when BEGIN fails', async () => {
    const beginError = new Error('connection reset during BEGIN');
    const client = makeClient(vi.fn().mockRejectedValueOnce(beginError));
    pool.client = client;

    await expect(withTransaction(vi.fn())).rejects.toBe(beginError);

    expect(client.query.mock.calls).toEqual([['BEGIN']]);
    expect(client.release).toHaveBeenCalledWith(beginError);
  });

  it('rolls back and releases the client when the handler throws', async () => {
    const handlerError = new Error('handler failed');
    const client = makeClient(vi.fn().mockResolvedValue({}));
    pool.client = client;

    await expect(withTransaction(async () => { throw handlerError; })).rejects.toBe(handlerError);

    expect(client.query.mock.calls).toEqual([['BEGIN'], ['ROLLBACK']]);
    expect(client.release).toHaveBeenCalledWith(handlerError);
  });

  it('commits, releases, and returns the handler result on success', async () => {
    const client = makeClient(vi.fn().mockResolvedValue({}));
    pool.client = client;

    await expect(withTransaction(async () => 'saved')).resolves.toBe('saved');

    expect(client.query.mock.calls).toEqual([['BEGIN'], ['COMMIT']]);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('keeps savepoint queries available to transaction handlers', async () => {
    const client = makeClient(vi.fn().mockResolvedValue({}));
    pool.client = client;

    await withTransaction(async (transaction) => {
      await transaction.query('SAVEPOINT nested_work');
      await transaction.query('ROLLBACK TO SAVEPOINT nested_work');
    });

    expect(client.query.mock.calls).toEqual([
      ['BEGIN'],
      ['SAVEPOINT nested_work'],
      ['ROLLBACK TO SAVEPOINT nested_work'],
      ['COMMIT'],
    ]);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('rethrows the original error when ROLLBACK also fails', async () => {
    const handlerError = new Error('statement timeout');
    const rollbackError = new Error('Connection terminated unexpectedly');
    const client = makeClient(
      vi.fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(rollbackError),
    );
    pool.client = client;

    await expect(withTransaction(async () => { throw handlerError; })).rejects.toBe(handlerError);

    expect(client.query.mock.calls).toEqual([['BEGIN'], ['ROLLBACK']]);
    expect(client.release).toHaveBeenCalledWith(handlerError);
  });

  it('passes a connection-drop error to release so pg evicts the client', async () => {
    const dropError = new Error('Connection terminated unexpectedly');
    const client = makeClient(
      vi.fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('ROLLBACK on closed socket')),
    );
    pool.client = client;

    await expect(withTransaction(async () => { throw dropError; })).rejects.toBe(dropError);

    expect(client.release).toHaveBeenCalledWith(dropError);
  });
});
