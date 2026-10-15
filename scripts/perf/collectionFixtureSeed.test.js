import { expect, it } from 'vitest';
import { seedFixtureRecords, SEED_BATCH_SIZE } from './collectionFixtureSeed.js';

it('bounds concurrent records and reports only fully completed batches', async () => {
  const pending = [];
  const started = [];
  const completed = [];
  const seed = seedFixtureRecords(SEED_BATCH_SIZE + 1, index => {
    started.push(index);
    return new Promise(resolve => pending.push(resolve));
  }, count => completed.push(count));
  await Promise.resolve();
  expect(started).toHaveLength(SEED_BATCH_SIZE);
  expect(completed).toEqual([]);
  for (const resolve of pending.splice(0)) resolve();
  await new Promise(resolve => setImmediate(resolve));
  expect(started).toEqual(Array.from({ length: SEED_BATCH_SIZE + 1 }, (_, index) => index));
  expect(completed).toEqual([SEED_BATCH_SIZE]);
  pending[0]();
  await seed;
  expect(completed).toEqual([SEED_BATCH_SIZE, SEED_BATCH_SIZE + 1]);
});

it('drains a failed batch before rejecting, and starts no later records', async () => {
  const pending = [];
  const started = [];
  const completed = [];
  const failure = new Error('Synthetic seed write failure');
  let rejected = false;
  const seed = seedFixtureRecords(SEED_BATCH_SIZE + 1, index => {
    started.push(index);
    if (index === 0) throw failure;
    return new Promise(resolve => pending.push(resolve));
  }, count => completed.push(count)).catch(error => { rejected = true; throw error; });
  const assertion = expect(seed).rejects.toBe(failure);
  await new Promise(resolve => setImmediate(resolve));
  expect(rejected).toBe(false);
  for (const resolve of pending) resolve();
  await assertion;
  expect(started).toHaveLength(SEED_BATCH_SIZE);
  expect(completed).toEqual([]);
});
