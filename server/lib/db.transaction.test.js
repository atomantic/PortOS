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
    types: { setTypeParser: vi.fn() },
  },
}));

import { withTransaction, query, withDatabaseMaintenance } from './db.js';

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


describe('database restore admission', () => {
  it('drains detached nested work that outlives its admitted parent', async () => {
    pool.client = makeClient(vi.fn().mockResolvedValue({}));
    let releaseQuery;
    pool.query.mockImplementationOnce(() => new Promise(resolve => { releaseQuery = resolve; }));
    let nestedQuery;
    let releaseParent;
    let enteredParent;
    const entered = new Promise(resolve => { enteredParent = resolve; });
    const parent = withTransaction(async () => {
      enteredParent();
      await new Promise(resolve => { releaseParent = resolve; });
      nestedQuery = query('SELECT 1');
    });
    await entered;
    let enteredMaintenance = false;
    const maintenance = withDatabaseMaintenance(async () => { enteredMaintenance = true; });
    releaseParent();
    await parent;
    await Promise.resolve();
    await Promise.resolve();
    expect(enteredMaintenance).toBe(false);
    releaseQuery();
    await nestedQuery;
    await maintenance;
    expect(enteredMaintenance).toBe(true);
  });

  it('drains whole transactions, rejects new work, permits recovery, and releases after failure', async () => {
    pool.client = makeClient(vi.fn().mockResolvedValue({}));
    let finishTransaction;
    let enteredTransaction;
    const entered = new Promise(resolve => { enteredTransaction = resolve; });
    const transaction = withTransaction(async client => {
      enteredTransaction();
      await new Promise(resolve => { finishTransaction = resolve; });
      await client.query('SELECT 1');
    });
    await entered;
    let enteredMaintenance = false;
    let finishMaintenance;
    const maintenance = withDatabaseMaintenance(async () => {
      enteredMaintenance = true;
      await query('SELECT 2');
      await withTransaction(client => client.query('SELECT 3'));
      await new Promise(resolve => { finishMaintenance = resolve; });
      throw new Error('replay failed');
    });
    const rejected = expect(maintenance).rejects.toThrow('replay failed');
    await expect(query('SELECT 4')).rejects.toMatchObject({ code: 'DATABASE_MAINTENANCE', status: 503 });
    await expect(withTransaction(() => {})).rejects.toMatchObject({ code: 'DATABASE_MAINTENANCE' });
    await expect(withDatabaseMaintenance(() => {})).rejects.toMatchObject({ code: 'DATABASE_MAINTENANCE' });
    expect(enteredMaintenance).toBe(false);
    finishTransaction();
    await transaction;
    await vi.waitFor(() => expect(finishMaintenance).toBeTypeOf('function'));
    finishMaintenance();
    await rejected;
    await expect(query('SELECT 5')).resolves.toBeUndefined();
    await expect(withDatabaseMaintenance(async () => 'recovered')).resolves.toBe('recovered');
  });
});
