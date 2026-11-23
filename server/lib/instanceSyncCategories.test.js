import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SYNC_CATEGORIES,
  KIND_TO_CATEGORY,
  PEER_SUBSCRIBABLE_KINDS,
  PER_RECORD_CATEGORY_KINDS,
} from './instanceSyncCategories.js';
import { peerSubscribeSchema, peerSyncRecordSchema } from './peerSyncValidation.js';
import * as peerSyncShared from '../services/sharing/peerSyncShared.js';

describe('kind → category registry', () => {
  it('maps every subscribable kind onto a real default sync category', () => {
    for (const cat of Object.values(KIND_TO_CATEGORY)) {
      expect(Object.keys(DEFAULT_SYNC_CATEGORIES)).toContain(cat);
    }
  });

  it('derives the kind list and per-record pairs from the one map', () => {
    expect(PEER_SUBSCRIBABLE_KINDS).toEqual(Object.keys(KIND_TO_CATEGORY));
    expect(PER_RECORD_CATEGORY_KINDS.map(([, kind]) => kind)).toEqual(PEER_SUBSCRIBABLE_KINDS);
    for (const [cat, kind] of PER_RECORD_CATEGORY_KINDS) expect(KIND_TO_CATEGORY[kind]).toBe(cat);
  });

  it('is re-exported unchanged from peerSyncShared', () => {
    expect(peerSyncShared.KIND_TO_CATEGORY).toBe(KIND_TO_CATEGORY);
    expect(peerSyncShared.PEER_SUBSCRIBABLE_KINDS).toBe(PEER_SUBSCRIBABLE_KINDS);
  });

  it('validation schemas accept every subscribable kind and reject others', () => {
    for (const recordKind of PEER_SUBSCRIBABLE_KINDS) {
      expect(peerSubscribeSchema.safeParse({ peerId: 'p', recordKind, recordId: 'r' }).success).toBe(true);
    }
    expect(peerSubscribeSchema.safeParse({ peerId: 'p', recordKind: 'nope', recordId: 'r' }).success).toBe(false);
    expect(peerSyncRecordSchema.shape.recordKind.safeParse('deck').success).toBe(true);
    expect(peerSyncRecordSchema.shape.recordKind.safeParse('nope').success).toBe(false);
  });
});
