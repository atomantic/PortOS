import { describe, it, expect } from 'vitest';
import { PEER_SUBSCRIBABLE_KINDS } from './peerSyncShared.js';
import { RECORD_KINDS } from './recordKinds.js';

// Registry-completeness guard (#6843): every PEER_SUBSCRIBABLE_KINDS entry
// must have a descriptor here and vice versa. This is the guard that makes
// the bug class the issue documents structurally impossible going forward —
// a kind added to PEER_SUBSCRIBABLE_KINDS but never given a descriptor (or a
// stale descriptor left behind after a kind is retired) now fails a test
// instead of silently producing 'missing'/null/false at every call site that
// reads the table.
//
// Mutation-probe evidence (manual, per the swarm playbook's baseline rule —
// not a standing test, since RECORD_KINDS is a frozen null-prototype object
// and there is no supported way to mutate it from outside the module):
// deleting one entry from RECORD_KINDS in recordKinds.js and re-running this
// file fails 'has exactly the same kinds as PEER_SUBSCRIBABLE_KINDS' (the
// deleted kind is missing from Object.keys(RECORD_KINDS)) AND fails the
// all-kinds parity suite in peerSync.test.js for that kind (buildPushPayload
// returns null because `desc` is undefined, so `result.kind` throws).
describe('RECORD_KINDS registry completeness (#6843)', () => {
  it('has exactly the same kinds as PEER_SUBSCRIBABLE_KINDS — no kind missing a descriptor, no stale descriptor left behind', () => {
    expect(Object.keys(RECORD_KINDS).sort()).toEqual([...PEER_SUBSCRIBABLE_KINDS].sort());
  });

  it('is a null-prototype table, like RECORD_KIND_LISTERS/LIVE_ID_LISTERS/ALL_ID_LISTERS — an unrecognized kind resolves to undefined, never an inherited Object.prototype member', () => {
    expect(Object.getPrototypeOf(RECORD_KINDS)).toBeNull();
    expect(RECORD_KINDS.toString).toBeUndefined();
    expect(RECORD_KINDS.constructor).toBeUndefined();
    expect(RECORD_KINDS.hasOwnProperty).toBeUndefined();
  });

  it.each(PEER_SUBSCRIBABLE_KINDS)('%s has a well-shaped descriptor: load + merge are functions, hasEphemeral is a boolean, buildAssetManifest is null or a function', (kind) => {
    const desc = RECORD_KINDS[kind];
    expect(desc).toBeDefined();
    expect(typeof desc.load).toBe('function');
    expect(typeof desc.merge).toBe('function');
    expect(typeof desc.hasEphemeral).toBe('boolean');
    expect(desc.buildAssetManifest === null || typeof desc.buildAssetManifest === 'function').toBe(true);
  });

  it('only universe and series carry hasEphemeral:true — every other kind (including fableLoom and musicVideoProject, both documented drift fixes in #6843) has no ephemeral concept', () => {
    const hasEphemeralKinds = PEER_SUBSCRIBABLE_KINDS.filter((k) => RECORD_KINDS[k].hasEphemeral === true);
    expect(hasEphemeralKinds.sort()).toEqual(['series', 'universe']);
  });

  it('universe and series carry buildAssetManifest:null (their bundle-aware manifest builders live as hooks in buildPushPayload, not in the table)', () => {
    expect(RECORD_KINDS.universe.buildAssetManifest).toBeNull();
    expect(RECORD_KINDS.series.buildAssetManifest).toBeNull();
  });

  it('the 5 body-less/draft-body kinds also carry buildAssetManifest:null (no generic asset manifest for them)', () => {
    for (const kind of ['writersRoomWork', 'writersRoomFolder', 'writersRoomExercise', 'commissionFeedback', 'creativeCommission']) {
      expect(RECORD_KINDS[kind].buildAssetManifest).toBeNull();
    }
  });

  it('the remaining 9 kinds carry a real buildAssetManifest function', () => {
    for (const kind of ['mediaCollection', 'author', 'artist', 'album', 'track', 'creativeDirectorProject', 'moodBoard', 'fableLoom', 'musicVideoProject']) {
      expect(typeof RECORD_KINDS[kind].buildAssetManifest).toBe('function');
    }
  });
});
