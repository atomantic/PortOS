import { describe, it, expect } from 'vitest';
import { computeRecordIntegrity, INTEGRITY_STATUS } from './syncIntegrity.js';

const makeRow = (overrides) => ({
  id: 'r1',
  name: 'Record One',
  updatedAt: '2026-05-23T00:00:00.000Z',
  deleted: false,
  assetHashes: [],
  ...overrides,
});

describe('computeRecordIntegrity', () => {
  it('returns IN_PARITY when both sides match (same updatedAt, same hashes)', () => {
    const row = makeRow({ assetHashes: ['aaaa', 'bbbb'] });
    const result = computeRecordIntegrity([row], [row]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'r1', status: INTEGRITY_STATUS.IN_PARITY });
  });

  it('returns LOCAL_ONLY when record exists locally but not on peer', () => {
    const local = makeRow();
    const result = computeRecordIntegrity([local], []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'r1', status: INTEGRITY_STATUS.LOCAL_ONLY });
  });

  it('returns PEER_ONLY when record exists on peer but not locally', () => {
    const remote = makeRow();
    const result = computeRecordIntegrity([], [remote]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'r1', status: INTEGRITY_STATUS.PEER_ONLY });
  });

  it('returns DIVERGED when updatedAt differs', () => {
    const local = makeRow({ updatedAt: '2026-05-23T00:00:00.000Z' });
    const remote = makeRow({ updatedAt: '2026-05-24T00:00:00.000Z' });
    const result = computeRecordIntegrity([local], [remote]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'r1', status: INTEGRITY_STATUS.DIVERGED });
  });

  it('returns ASSETS_MISSING when updatedAt is the same but hashes differ', () => {
    const ts = '2026-05-23T00:00:00.000Z';
    const local = makeRow({ updatedAt: ts, assetHashes: ['aaaa'] });
    const remote = makeRow({ updatedAt: ts, assetHashes: ['bbbb'] });
    const result = computeRecordIntegrity([local], [remote]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'r1', status: INTEGRITY_STATUS.ASSETS_MISSING });
  });

  it('returns METADATA_MISSING when image hashes match but one side lacks sidecar metadata', () => {
    const ts = '2026-05-23T00:00:00.000Z';
    const local = makeRow({ updatedAt: ts, assetHashes: ['aaaa'], metadataMissing: true });
    const remote = makeRow({ updatedAt: ts, assetHashes: ['aaaa'], metadataMissing: false });
    const result = computeRecordIntegrity([local], [remote]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'r1', status: INTEGRITY_STATUS.METADATA_MISSING });
  });

  it('treats hash order as irrelevant for IN_PARITY (sorts before compare)', () => {
    const ts = '2026-05-23T00:00:00.000Z';
    const local = makeRow({ updatedAt: ts, assetHashes: ['bbbb', 'aaaa'] });
    const remote = makeRow({ updatedAt: ts, assetHashes: ['aaaa', 'bbbb'] });
    const result = computeRecordIntegrity([local], [remote]);
    expect(result[0].status).toBe(INTEGRITY_STATUS.IN_PARITY);
  });

  it('omits pairs where both sides are tombstoned (deleted)', () => {
    const local = makeRow({ deleted: true });
    const remote = makeRow({ deleted: true });
    const result = computeRecordIntegrity([local], [remote]);
    expect(result).toHaveLength(0);
  });

  it('treats deleted:true locally + live remotely as PEER_ONLY', () => {
    const local = makeRow({ deleted: true });
    const remote = makeRow({ deleted: false });
    const result = computeRecordIntegrity([local], [remote]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'r1', status: INTEGRITY_STATUS.PEER_ONLY });
  });

  it('treats live locally + deleted:true remotely as LOCAL_ONLY', () => {
    const local = makeRow({ deleted: false });
    const remote = makeRow({ deleted: true });
    const result = computeRecordIntegrity([local], [remote]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'r1', status: INTEGRITY_STATUS.LOCAL_ONLY });
  });

  it('handles null/undefined localList and remoteList gracefully', () => {
    expect(computeRecordIntegrity(null, null)).toEqual([]);
    expect(computeRecordIntegrity(undefined, undefined)).toEqual([]);
    const row = makeRow();
    expect(computeRecordIntegrity([row], null)).toHaveLength(1);
    expect(computeRecordIntegrity(null, [row])).toHaveLength(1);
  });

  it('uses name from peer when local is absent', () => {
    const remote = makeRow({ name: 'Peer Name' });
    const result = computeRecordIntegrity([], [remote]);
    expect(result[0].name).toBe('Peer Name');
  });

  it('falls back to id when name is absent on both sides', () => {
    const local = makeRow({ name: undefined });
    const remote = makeRow({ name: undefined });
    const result = computeRecordIntegrity([local], [remote]);
    expect(result[0].name).toBe('r1');
  });

  it('handles multiple records correctly', () => {
    const ts = '2026-05-23T00:00:00.000Z';
    const localList = [
      makeRow({ id: 'a', name: 'A', updatedAt: ts, assetHashes: [] }),
      makeRow({ id: 'b', name: 'B', updatedAt: ts, assetHashes: [] }),
    ];
    const remoteList = [
      makeRow({ id: 'a', name: 'A', updatedAt: ts, assetHashes: [] }),
      makeRow({ id: 'c', name: 'C', updatedAt: ts, assetHashes: [] }),
    ];
    const result = computeRecordIntegrity(localList, remoteList);
    expect(result).toHaveLength(3);
    const byId = Object.fromEntries(result.map((r) => [r.id, r.status]));
    expect(byId.a).toBe(INTEGRITY_STATUS.IN_PARITY);
    expect(byId.b).toBe(INTEGRITY_STATUS.LOCAL_ONLY);
    expect(byId.c).toBe(INTEGRITY_STATUS.PEER_ONLY);
  });
});
