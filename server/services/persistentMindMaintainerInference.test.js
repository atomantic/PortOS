import { describe, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { normalizePersistentMindMaintainer, mergePersistentMindMaintainer } from '../lib/persistentMindMaintainer.js';
import { inspectMaintainerInferenceRoute, reserveMaintainerInference, readMaintainerInferenceBudget } from './persistentMindMaintainerInference.js';

const role = normalizePersistentMindMaintainer({ enabled: true });
const provider = { id: 'ollama', type: 'api', enabled: true, endpoint: 'http://localhost:11434/v1', numCtx: 131072 };
const probe = vi.fn(async () => ({ reachable: true, models: ['example-model'], contextWindows: {} }));
const inspect = (patch = {}) => inspectMaintainerInferenceRoute({ role, provider, model: 'example-model', promptChars: 100, promptBytes: 100, probe, ...patch });

it('validates the installed local route and fails closed for missing catalog, model and context capacity', async () => {
  await expect(inspect()).resolves.toMatchObject({ ok: true, lane: 'local-curation' });
  await expect(inspect({ model: 'missing' })).resolves.toMatchObject({ ok: false });
  await expect(inspect({ probe: async () => ({ reachable: false, models: null }) })).resolves.toMatchObject({ ok: false });
  await expect(inspect({ provider: { ...provider, numCtx: undefined } })).resolves.toMatchObject({ ok: false });
  await expect(inspect({ promptChars: role.inference.maxPromptChars + 1 })).resolves.toMatchObject({ ok: false });
  await expect(inspect({ promptBytes: undefined })).resolves.toMatchObject({ ok: false });
  await expect(inspect({ promptBytes: -1 })).resolves.toMatchObject({ ok: false });
  await expect(inspect({ promptBytes: 131072 })).resolves.toMatchObject({ ok: false });
  await expect(inspect({ probe: async () => ({ reachable: true, models: ['example-model'], contextWindows: { 'example-model': 8192 } }) })).resolves.toMatchObject({ ok: false });
});

it('permits remote escalation only for an explicitly allowed human preset and never self-thinking', async () => {
  const remote = { ...provider, endpoint: 'https://example.com/v1' };
  await expect(inspect({ provider: remote })).resolves.toMatchObject({ ok: false });
  const authorized = { provider: remote, role: { ...role, inference: { paidPresetIds: ['deep'], maxPaidCallsPerDay: 1 } }, thinkingPresetId: 'deep', thinkingSelection: { id: 'deep' } };
  await expect(inspect(authorized)).resolves.toMatchObject({ ok: true, lane: 'authorized-escalation' });
  await expect(inspect({ ...authorized, selfThinkingRequest: {} })).resolves.toMatchObject({ ok: false });
  await expect(inspect({ role: { enabled: false }, provider: remote })).resolves.toMatchObject({ ok: true, enforced: false });
  expect(mergePersistentMindMaintainer({ inference: { maxCallsPerDay: 3 } }, { inference: { maxCallsPerTurn: 2 } }).inference).toMatchObject({ maxCallsPerDay: 3, maxCallsPerTurn: 2 });
});

const store = () => {
  let persisted = null;
  return { queue: createFileWriteQueue(), read: async () => structuredClone(persisted), write: async value => { persisted = structuredClone(value); } };
};
it('serializes concurrent admissions and retains per-turn allowance across new callers and midnight', async () => {
  const disk = store();
  const policy = { ...role.inference, maxCallsPerTurn: 2, maxCallsPerDay: 2 };
  const reserve = (turnId, date = '2026-01-01T23:59:59Z') => reserveMaintainerInference({ ...disk, turnId, lane: 'local-curation', policy, now: () => Date.parse(date) });
  const results = await Promise.all([reserve('one'), reserve('one'), reserve('one')]);
  expect(results.map(result => result.ok)).toEqual([true, true, false]);
  await expect(reserve('two')).resolves.toMatchObject({ ok: false, code: 'day-exhausted', disposition: 'reset-wait' });
  await expect(reserve('one', '2026-01-02T00:01:00Z')).resolves.toMatchObject({ ok: false, code: 'turn-exhausted' });
  await expect(reserve('two', '2026-01-02T00:01:00Z')).resolves.toMatchObject({ ok: true });
  expect((await disk.read()).lastReservation.costUsd).toBeNull();
  await expect(reserve('three', '2026-01-01T23:59:59Z')).resolves.toMatchObject({ ok: false });
});
it('reserves paid calls and timeout allowance independently and refuses unreadable storage', async () => {
  const disk = store();
  const policy = { ...role.inference, maxPaidCallsPerDay: 1, maxReservedMsPerDay: role.inference.maxCallMs * 2 };
  const reserve = lane => reserveMaintainerInference({ ...disk, turnId: 'one', lane, policy });
  await expect(reserve('authorized-escalation')).resolves.toMatchObject({ ok: true });
  await expect(reserve('authorized-escalation')).resolves.toMatchObject({ ok: false });
  await expect(reserve('local-curation')).resolves.toMatchObject({ ok: true });
  await expect(reserve('local-curation')).resolves.toMatchObject({ ok: false });
  expect((await readMaintainerInferenceBudget(disk)).day).toMatchObject({ calls: 2, paidCalls: 1 });
  await expect(reserveMaintainerInference({ ...disk, read: async () => { throw new Error('Unreadable'); }, turnId: 'one', policy })).rejects.toThrow('Unreadable');
});

it('refuses malformed persisted counters and dates instead of reopening allowance', async () => {
  for (const patch of [{ calls: -1 }, { date: '2026-99-99' }, { paidCalls: -1 }, { reservedMs: -1 }]) {
    const disk = store();
    await reserveMaintainerInference({ ...disk, turnId: 'one', lane: 'local-curation', policy: role.inference });
    const ledger = await disk.read();
    await disk.write({ ...ledger, day: { ...ledger.day, ...patch } });
    await expect(reserveMaintainerInference({ ...disk, turnId: 'two', lane: 'local-curation', policy: role.inference })).rejects.toThrow('ledger is invalid');
  }
});
