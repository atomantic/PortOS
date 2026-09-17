/**
 * The Eidoverse foundation pull/inherit transport (#7455).
 *
 * The two gates this wire connects are tested where they live — the send-side
 * offering filter in `eidoverseFoundationLedger.test.js`, the accept-side gate
 * in `eidoverseFoundations.test.js`. What only this suite can catch is the
 * TRANSPORT's own contract: that a version-ahead peer is skipped instead of
 * mis-applied, that the sweep is idempotent rather than rewriting the ledger
 * every tick, that the accept gate is handed the right two instance ids (the
 * only thing that lets it recognize a self-referential pull), and that a
 * refusal is counted rather than thrown.
 *
 * The ledger is mocked so the transport is observable AND can never touch the
 * real `data/eidoverse/foundations.json`; the module reaches it through a
 * dynamic import, which vitest's mock registry covers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../instances.js', () => ({
  DEFAULT_SYNC_CATEGORIES: {},
  getPeers: vi.fn().mockResolvedValue([]),
  resolveEffectiveCategories: vi.fn(() => ({})),
}));
vi.mock('../instanceIdentity.js', () => ({
  UNKNOWN_INSTANCE_ID: 'unknown',
  getInstanceId: vi.fn().mockResolvedValue('instance-local'),
}));
vi.mock('../instanceFeatures.js', () => ({ isInstanceFeatureEnabled: vi.fn().mockResolvedValue(true) }));
vi.mock('../../lib/peerHttpClient.js', () => ({ peerFetch: vi.fn() }));
vi.mock('../eidoverseFoundationLedger.js', () => ({
  listPromotedFoundationCandidates: vi.fn().mockResolvedValue([]),
  listEidoverseFoundations: vi.fn().mockResolvedValue({ foundations: [] }),
  recordEidoverseFoundationInheritance: vi.fn().mockResolvedValue({ outcome: 'inherited', foundation: {}, reasons: [], findings: [] }),
}));

import {
  __resetEidoverseFoundationSweepForTests,
  buildEidoverseFoundationOffering,
  syncEidoverseFoundationsFromPeer,
  syncEidoverseFoundationsWithAllPeers,
} from './peerEidoverseFoundationSync.js';
import { PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import { FORCE_REVALIDATE_EVERY } from './peerSyncShared.js';
import { getPeers } from '../instances.js';
import { getInstanceId } from '../instanceIdentity.js';
import { isInstanceFeatureEnabled } from '../instanceFeatures.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import {
  listEidoverseFoundations,
  listPromotedFoundationCandidates,
  recordEidoverseFoundationInheritance,
} from '../eidoverseFoundationLedger.js';

const PEER = { instanceId: 'instance-peer', name: 'Workshop', address: '192.0.2.10', port: 5555, fullSync: true, enabled: true };

const fingerprint = (seed) => seed.repeat(64).slice(0, 64);

// Shaped like a real promote envelope, but only the fields the TRANSPORT reads
// matter here — the envelope's own contract is the accept gate's to enforce,
// and mocking the ledger is precisely what keeps this suite from re-testing it.
const candidate = (id, seed = 'a') => ({
  candidateVersion: 1,
  foundationId: id,
  kind: 'controller',
  title: id,
  summary: `${id} summary`,
  contributionId: 'beacon-relay-demo',
  body: { schema: { pulses: 'integer' } },
  disclosure: { requires: [], effects: [], license: null, notes: null },
  provenance: {
    originInstanceId: 'instance-peer', authorKind: 'mind',
    createdAt: '2026-03-01T00:00:00.000Z', packagedAt: '2026-03-01T01:00:00.000Z', portosVersion: '9.9.9',
  },
  assay: {
    harness: 'eidoverse-resilience-assay', contributionId: 'beacon-relay-demo', pass: true,
    disturbances: ['author-absent'], ranAt: '2026-03-01T00:30:00.000Z', reasons: [],
  },
  fingerprint: fingerprint(seed),
});

const offering = (candidates, overrides = {}) => ({
  ok: true,
  headers: { get: () => null },
  json: async () => ({
    schemaVersion: PORTOS_SCHEMA_VERSIONS.eidoverseFoundations,
    // A hex64 the receiver only compares for equality; the sender's real one is
    // derived from the fingerprints.
    listHash: fingerprint('f'),
    candidates,
    ...overrides,
  }),
});

beforeEach(() => {
  __resetEidoverseFoundationSweepForTests();
  vi.mocked(peerFetch).mockReset();
  vi.mocked(getPeers).mockResolvedValue([PEER]);
  vi.mocked(getInstanceId).mockResolvedValue('instance-local');
  vi.mocked(isInstanceFeatureEnabled).mockResolvedValue(true);
  vi.mocked(listPromotedFoundationCandidates).mockReset().mockResolvedValue([]);
  vi.mocked(listEidoverseFoundations).mockReset().mockResolvedValue({ foundations: [] });
  vi.mocked(recordEidoverseFoundationInheritance).mockReset()
    .mockResolvedValue({ outcome: 'inherited', foundation: {}, reasons: [], findings: [] });
});

describe('the offering this install advertises', () => {
  it('stamps the wire version and a content-addressed listHash over the promoted envelopes', async () => {
    vi.mocked(listPromotedFoundationCandidates).mockResolvedValue([candidate('tide-beacon', 'a'), candidate('lamp-post', 'b')]);

    const payload = await buildEidoverseFoundationOffering();

    expect(payload.schemaVersion).toBe(PORTOS_SCHEMA_VERSIONS.eidoverseFoundations);
    expect(payload.candidates.map((c) => c.foundationId)).toEqual(['tide-beacon', 'lamp-post']);
    expect(payload.listHash).toMatch(/^[a-f0-9]{64}$/);

    // Content-addressed: the SAME envelopes hash the same, a different set does
    // not. Without this the receiver's unchanged short-circuit would either
    // never fire or would hide a genuine change.
    const again = await buildEidoverseFoundationOffering();
    expect(again.listHash).toBe(payload.listHash);
    vi.mocked(listPromotedFoundationCandidates).mockResolvedValue([candidate('tide-beacon', 'a')]);
    expect((await buildEidoverseFoundationOffering()).listHash).not.toBe(payload.listHash);
  });

  it('advertises nothing while the Eidoverse feature is off, without reading the ledger', async () => {
    vi.mocked(isInstanceFeatureEnabled).mockResolvedValue(false);
    vi.mocked(listPromotedFoundationCandidates).mockResolvedValue([candidate('tide-beacon')]);

    expect((await buildEidoverseFoundationOffering()).candidates).toEqual([]);
    expect(listPromotedFoundationCandidates).not.toHaveBeenCalled();
  });
});

describe('pulling a peer offering', () => {
  it('hands each candidate to the accept gate with the peer it came FROM and this install id', async () => {
    vi.mocked(peerFetch).mockResolvedValue(offering([candidate('tide-beacon')]));

    expect(await syncEidoverseFoundationsFromPeer(PEER)).toMatchObject({ inherited: 1, refused: 0 });
    // Both ids, separately: `sourceInstanceId` is the hop, `localInstanceId` is
    // what lets the gate refuse a foundation this install itself originated.
    // Collapsing them (or passing the candidate's own origin) would silently
    // disarm both self-referential checks.
    expect(recordEidoverseFoundationInheritance).toHaveBeenCalledWith(
      expect.objectContaining({ foundationId: 'tide-beacon' }),
      { sourceInstanceId: 'instance-peer', localInstanceId: 'instance-local' },
    );
    expect(peerFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/peer-sync/eidoverse-foundations'), expect.anything(), PEER,
    );
  });

  it('counts a refusal instead of failing the sweep, and applies the rest', async () => {
    vi.mocked(recordEidoverseFoundationInheritance)
      .mockResolvedValueOnce({ outcome: 'refused', foundation: null, reasons: ['fingerprint does not match'], findings: [] })
      .mockResolvedValueOnce({ outcome: 'inherited', foundation: {}, reasons: [], findings: [] });
    vi.mocked(peerFetch).mockResolvedValue(offering([candidate('tampered', 'a'), candidate('sound', 'b')]));

    expect(await syncEidoverseFoundationsFromPeer(PEER)).toMatchObject({ inherited: 1, refused: 1 });
  });

  it('skips a sender whose schemaVersion is ahead rather than storing a shape it cannot read', async () => {
    vi.mocked(peerFetch).mockResolvedValue(offering([candidate('from-the-future')], {
      schemaVersion: PORTOS_SCHEMA_VERSIONS.eidoverseFoundations + 1,
    }));

    expect(await syncEidoverseFoundationsFromPeer(PEER)).toEqual({ inherited: 0, skipped: 'schema-ahead' });
    expect(recordEidoverseFoundationInheritance).not.toHaveBeenCalled();
  });

  it('short-circuits an unchanged offering, then force-revalidates so a local deletion self-heals', async () => {
    vi.mocked(peerFetch).mockResolvedValue(offering([candidate('tide-beacon')]));
    await syncEidoverseFoundationsFromPeer(PEER);
    // Held locally from here on, so a re-pull has nothing to apply.
    vi.mocked(listEidoverseFoundations).mockResolvedValue({
      foundations: [{ inheritance: { fingerprint: fingerprint('a') } }],
    });

    for (let i = 1; i < FORCE_REVALIDATE_EVERY; i += 1) {
      expect(await syncEidoverseFoundationsFromPeer(PEER)).toEqual({ inherited: 0, skipped: 'unchanged' });
    }
    // The forced tick falls through to a real apply pass rather than skipping.
    expect(await syncEidoverseFoundationsFromPeer(PEER)).toMatchObject({ inherited: 0, refused: 0 });
    expect(vi.mocked(listEidoverseFoundations)).toHaveBeenCalled();
  });

  it('does not re-apply a candidate this install already holds at the same fingerprint', async () => {
    vi.mocked(listEidoverseFoundations).mockResolvedValue({
      foundations: [{ inheritance: { fingerprint: fingerprint('a') } }, { inheritance: null }],
    });
    vi.mocked(peerFetch).mockResolvedValue(offering([candidate('tide-beacon', 'a'), candidate('lamp-post', 'b')]));

    // Re-applying would rewrite `inheritedAt`/`updatedAt` on an unchanged copy
    // every forced re-pull and churn the ledger for nothing.
    expect(await syncEidoverseFoundationsFromPeer(PEER)).toMatchObject({ inherited: 1, refused: 0 });
    expect(recordEidoverseFoundationInheritance).toHaveBeenCalledTimes(1);
    expect(recordEidoverseFoundationInheritance).toHaveBeenCalledWith(
      expect.objectContaining({ foundationId: 'lamp-post' }), expect.anything(),
    );
  });

  it('rejects a malformed wrapper before any candidate reaches the gate', async () => {
    vi.mocked(peerFetch).mockResolvedValue({ ok: true, headers: { get: () => null }, json: async () => ({ candidates: 'not-an-array' }) });

    expect(await syncEidoverseFoundationsFromPeer(PEER)).toEqual({ inherited: 0, skipped: 'invalid' });
    expect(recordEidoverseFoundationInheritance).not.toHaveBeenCalled();
  });

  it('refuses an over-cap response on the declared content length', async () => {
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true, headers: { get: () => String(64 * 1024 * 1024) }, json: async () => ({}),
    });

    expect(await syncEidoverseFoundationsFromPeer(PEER)).toEqual({ inherited: 0, skipped: 'too-large' });
  });

  it('never pulls for a peer the user did not flag full-sync, or while Eidoverse is off', async () => {
    expect(await syncEidoverseFoundationsFromPeer({ ...PEER, fullSync: false })).toEqual({ inherited: 0, skipped: 'not-fullsync' });
    vi.mocked(isInstanceFeatureEnabled).mockResolvedValue(false);
    expect(await syncEidoverseFoundationsFromPeer(PEER)).toEqual({ inherited: 0, skipped: 'feature-disabled' });
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('skips an install with no federation identity instead of minting one in the background', async () => {
    vi.mocked(getInstanceId).mockResolvedValue('unknown');

    expect(await syncEidoverseFoundationsFromPeer(PEER)).toEqual({ inherited: 0, skipped: 'no-local-identity' });
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('sweeps only enabled full-sync peers', async () => {
    vi.mocked(getPeers).mockResolvedValue([
      PEER,
      { ...PEER, instanceId: 'instance-disabled', enabled: false },
      { ...PEER, instanceId: 'instance-partial', fullSync: false },
    ]);
    vi.mocked(peerFetch).mockResolvedValue(offering([]));

    await syncEidoverseFoundationsWithAllPeers();

    expect(peerFetch).toHaveBeenCalledTimes(1);
    expect(peerFetch).toHaveBeenCalledWith(expect.any(String), expect.anything(), PEER);
  });
});
