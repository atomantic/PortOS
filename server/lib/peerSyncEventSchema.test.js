import { describe, it, expect } from 'vitest';
import { peerSyncEventSchema, PEER_SYNC_MAX_RECORD_BYTES } from './peerSyncEventSchema.js';

const upsert = (record = { id: 'v1', createdAt: '2026-05-01T00:00:00.000Z' }) => ({
  v: 1, category: 'videoHistory', op: 'upsert', id: 'v1', record, originInstanceId: 'peer-example',
});
const remove = () => ({
  v: 1, category: 'videoHistory', op: 'delete', id: 'v1', tombstone: { key: 'v1', deletedAt: '2026-06-01T00:00:00.000Z' }, originInstanceId: 'peer-example',
});
const ok = (frame) => peerSyncEventSchema.safeParse(frame).success;

describe('peerSyncEventSchema', () => {
  it('accepts well-formed upsert and delete frames', () => {
    expect(ok(upsert())).toBe(true);
    expect(ok(remove())).toBe(true);
  });

  it('schema rejects unknown category/oversize', () => {
    expect(ok({ ...upsert(), category: 'brain' })).toBe(false);
    const big = { id: 'v1', prompt: 'x'.repeat(PEER_SYNC_MAX_RECORD_BYTES) };
    expect(ok(upsert(big))).toBe(false);
  });

  it('rejects other versions, unknown keys and op/payload mismatches', () => {
    expect(ok({ ...upsert(), v: 2 })).toBe(false);
    expect(ok({ ...upsert(), extra: true })).toBe(false);
    expect(ok(upsert({ id: 'other' }))).toBe(false);
    expect(ok({ ...remove(), tombstone: { key: 'other', deletedAt: '2026-06-01T00:00:00.000Z' } })).toBe(false);
    expect(ok({ ...remove(), tombstone: { key: 'v1', deletedAt: 'not a time' } })).toBe(false);
    expect(ok({ ...remove(), record: { id: 'v1' } })).toBe(false);
  });
});
