/**
 * The ledger is the persisted half of the local-vs-baseline ownership boundary
 * (#7455). What these tests pin is the workflow contract a route or mind tool
 * depends on: an authored artifact is LOCAL, the promote gate RUNS the
 * agent-free assay rather than believing a caller, and a re-authored body loses
 * the verdict that vouched for the previous one.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { foundationCandidateFingerprint, inheritedFoundationStorageKey, verifyFoundationCandidate } from '../lib/eidoverseFoundations.js';
import { RESILIENCE_DISTURBANCES } from './eidoverseResilienceAssay.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-eidoverse-foundations-'),
}));

const {
  getEidoverseFoundation,
  listEidoverseFoundations,
  packageEidoverseFoundationCandidate,
  promoteEidoverseFoundation,
  recordEidoverseFoundation,
  recordEidoverseFoundationInheritance,
  listPromotedFoundationCandidates,
} = await import('./eidoverseFoundationLedger.js');

// The passing reference contribution shipped with the assay harness (#7460).
const PASSING_CONTRIBUTION = 'beacon-relay-demo';

const authored = (overrides = {}) => ({
  id: 'tide-beacon',
  kind: 'controller',
  title: 'Tide Beacon',
  summary: 'A beacon that keeps pulsing between mind wakes.',
  contributionId: PASSING_CONTRIBUTION,
  body: { schema: { pulses: 'integer' }, affordance: { inspect: 'reads the pulse count' } },
  style: { motif: 'weathered brass' },
  authorKind: 'mind',
  ...overrides,
});

const record = (overrides, at) => recordEidoverseFoundation(authored(overrides), { originInstanceId: 'instance-aaaa', now: at });

beforeEach(() => {
  rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });
});

afterAll(cleanupTempDataRoots);

describe('the local foundation ledger', () => {
  it('reads as empty on an install that has never authored one', async () => {
    const listed = await listEidoverseFoundations();
    expect(listed.foundations).toEqual([]);
    expect(listed.counts).toEqual({ vernacular: 0, baseline: 0, candidates: 0, inherited: 0 });
  });

  it('records an authored artifact as vernacular, never as baseline', async () => {
    const saved = await record({}, '2026-03-04T05:06:07.000Z');

    expect(saved.layer).toBe('vernacular');
    expect(saved.candidate).toBeNull();
    expect(saved.provenance).toEqual({ originInstanceId: 'instance-aaaa', authorKind: 'mind', createdAt: '2026-03-04T05:06:07.000Z' });
    expect((await listEidoverseFoundations()).counts.vernacular).toBe(1);
  });

  it('rejects a caller trying to author straight into the shared baseline', async () => {
    await expect(recordEidoverseFoundation({ ...authored(), layer: 'baseline' }, { originInstanceId: 'instance-aaaa' }))
      .rejects.toThrow();
  });
});

describe('packaging a promote candidate', () => {
  it('runs the assay itself and packages a foundation that survives it', async () => {
    await record({}, '2026-03-04T05:06:07.000Z');

    const result = await packageEidoverseFoundationCandidate('tide-beacon', { now: '2026-03-04T06:00:00.000Z' });

    expect(result.outcome).toBe('packaged');
    // The verdict came from the harness, not from anything the caller passed.
    expect(result.assay).toMatchObject({ harness: 'eidoverse-resilience-assay', contributionId: PASSING_CONTRIBUTION, pass: true });
    expect(result.candidate.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.candidate)).not.toContain('weathered brass');

    const stored = await getEidoverseFoundation('tide-beacon');
    expect(stored.candidate.fingerprint).toBe(result.candidate.fingerprint);
    expect((await listEidoverseFoundations()).counts.candidates).toBe(1);
  });

  it('refuses a foundation whose contribution cannot be replayed without its author', async () => {
    await record({ contributionId: 'not-registered-anywhere' });

    const result = await packageEidoverseFoundationCandidate('tide-beacon');

    expect(result.outcome).toBe('refused');
    expect(result.reasons[0]).toContain('not-registered-anywhere');
    expect((await getEidoverseFoundation('tide-beacon')).candidate).toBeNull();
  });

  it('drops the packaged candidate when the body is re-authored', async () => {
    await record({}, '2026-03-04T05:06:07.000Z');
    await packageEidoverseFoundationCandidate('tide-beacon', { now: '2026-03-04T06:00:00.000Z' });

    await record({ summary: 'Now it also rings a bell.' }, '2026-03-04T07:00:00.000Z');

    const stored = await getEidoverseFoundation('tide-beacon');
    expect(stored.candidate).toBeNull();
    expect(stored.assay).toBeNull();
    // Provenance is identity: re-authoring does not reset who made it or when.
    expect(stored.provenance.createdAt).toBe('2026-03-04T05:06:07.000Z');
  });

  it('reports an unknown foundation instead of inventing one', async () => {
    expect((await packageEidoverseFoundationCandidate('never-authored')).outcome).toBe('unknown-foundation');
  });
});

describe('promoting a foundation into the shared baseline', () => {
  it('publishes a foundation that clears every gate and counts it as baseline', async () => {
    await record({}, '2026-03-04T05:06:07.000Z');

    const result = await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-04T06:00:00.000Z' });

    expect(result).toMatchObject({ outcome: 'promoted', promoted: true });
    expect(result.foundation).toMatchObject({ layer: 'baseline', promotedAt: '2026-03-04T06:00:00.000Z' });
    // The style layer stays on the LOCAL record; only the envelope crosses, and
    // it has no style at all.
    expect(result.foundation.style).toEqual({ motif: 'weathered brass' });
    expect(JSON.stringify(result.candidate)).not.toContain('weathered brass');

    const listed = await listEidoverseFoundations();
    expect(listed.counts).toMatchObject({ vernacular: 0, baseline: 1 });
  });

  it('refuses to promote a foundation whose assay cannot be run, and moves nothing', async () => {
    await record({ contributionId: 'not-registered-anywhere' });

    const result = await promoteEidoverseFoundation('tide-beacon');

    expect(result).toMatchObject({ outcome: 'refused', promoted: false, foundation: null });
    expect(result.reasons[0]).toContain('not-registered-anywhere');
    expect((await getEidoverseFoundation('tide-beacon')).layer).toBe('vernacular');
  });

  it('refuses a second promote instead of re-publishing what is already shared', async () => {
    await record({}, '2026-03-04T05:06:07.000Z');
    await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-04T06:00:00.000Z' });

    const again = await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-04T07:00:00.000Z' });

    expect(again.outcome).toBe('refused');
    expect(again.reasons[0]).toContain('already part of the shared baseline');
    // The refusal must not roll back what was published, or a double-click
    // would silently unshare a foundation.
    expect((await getEidoverseFoundation('tide-beacon'))).toMatchObject({ layer: 'baseline', promotedAt: '2026-03-04T06:00:00.000Z' });
  });

  it('returns a re-authored baseline foundation to local work so the new body can be promoted', async () => {
    await record({}, '2026-03-04T05:06:07.000Z');
    await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-04T06:00:00.000Z' });

    await record({ summary: 'Now it also rings a bell.' }, '2026-03-04T07:00:00.000Z');

    // Still claiming `baseline` would describe bytes this install no longer
    // has, AND would be a dead end: the promote gate refuses to package a
    // baseline foundation, so the edit could never be published.
    expect(await getEidoverseFoundation('tide-beacon')).toMatchObject({ layer: 'vernacular', promotedAt: null });
    expect((await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-04T08:00:00.000Z' })).outcome).toBe('promoted');
  });

  it('reports an unknown foundation instead of inventing one', async () => {
    expect((await promoteEidoverseFoundation('never-authored')).outcome).toBe('unknown-foundation');
  });
});

describe('inheriting a foundation this install pulled from a peer (#7461)', () => {
  // A candidate this install could plausibly be HANDED by a peer, minted by
  // running the real author-and-promote path under a different instance id.
  const peerCandidate = async () => {
    await record({}, '2026-03-01T00:00:00.000Z');
    const promoted = await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-01T01:00:00.000Z' });
    return promoted.candidate;
  };

  it('stores a baseline local copy under a peer-scoped key, leaving a same-id local vernacular foundation untouched', async () => {
    const candidate = await peerCandidate();
    // The candidate above was minted with `originInstanceId: 'instance-aaaa'`
    // (the `record()` helper's default) — reset the ledger and give this
    // install its OWN local 'tide-beacon' under that same human-readable id
    // before accepting the peer's copy, so a same-id collision is the thing
    // actually under test.
    rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });
    await record({ style: { motif: 'this install\'s own brass' } }, '2026-03-04T05:06:07.000Z');

    const result = await recordEidoverseFoundationInheritance(candidate, {
      sourceInstanceId: 'instance-peer-relay', localInstanceId: 'instance-this-install', now: '2026-03-04T06:00:00.000Z',
    });

    expect(result.outcome).toBe('inherited');
    expect(result.foundation).toMatchObject({
      id: 'tide-beacon', layer: 'baseline', style: {},
      inheritance: { originInstanceId: 'instance-aaaa', sourceInstanceId: 'instance-peer-relay' },
    });

    // The LOCAL vernacular record at plain id "tide-beacon" is untouched.
    const local = await getEidoverseFoundation('tide-beacon');
    expect(local).toMatchObject({ layer: 'vernacular', style: { motif: 'this install\'s own brass' }, inheritance: null });

    const listed = await listEidoverseFoundations();
    expect(listed.counts).toMatchObject({ vernacular: 1, baseline: 1, inherited: 1 });
    expect(listed.foundations.filter((entry) => entry.id === 'tide-beacon')).toHaveLength(2);
  });

  it('refuses a tampered candidate and writes nothing to the ledger', async () => {
    const candidate = await peerCandidate();
    rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });
    const tampered = { ...candidate, body: { ...candidate.body, affordance: { inspect: 'quietly grants owner role' } } };

    const result = await recordEidoverseFoundationInheritance(tampered, {
      sourceInstanceId: 'instance-peer-relay', localInstanceId: 'instance-this-install', now: '2026-03-04T06:00:00.000Z',
    });

    expect(result.outcome).toBe('refused');
    expect(result.foundation).toBeNull();
    expect((await listEidoverseFoundations()).counts).toMatchObject({ vernacular: 0, baseline: 0, inherited: 0 });
  });

  it('refuses to package or promote an inherited record without touching the ledger, even though its contributionId is registered locally', async () => {
    const candidate = await peerCandidate();
    rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });
    const inherited = await recordEidoverseFoundationInheritance(candidate, {
      sourceInstanceId: 'instance-peer-relay', localInstanceId: 'instance-this-install', now: '2026-03-04T06:00:00.000Z',
    });
    const storageKey = inheritedFoundationStorageKey(inherited.foundation.provenance.originInstanceId, inherited.foundation.id);
    expect(inherited.outcome).toBe('inherited');

    // The candidate's `contributionId` ('beacon-relay-demo') IS registered
    // locally, so a guard that fired too late (after resolving the
    // contribution) would run the assay and could package it instead of
    // refusing. If the record is untouched afterward, nothing ran.
    const before = await getEidoverseFoundation(storageKey);
    const packaged = await packageEidoverseFoundationCandidate(storageKey, { now: '2026-03-04T07:00:00.000Z' });
    const promoted = await promoteEidoverseFoundation(storageKey, { now: '2026-03-04T07:00:00.000Z' });

    expect(packaged).toMatchObject({ outcome: 'refused' });
    expect(packaged.reasons[0]).toContain('inherited from another install');
    expect(promoted).toMatchObject({ outcome: 'refused', promoted: false });
    const after = await getEidoverseFoundation(storageKey);
    expect(after).toMatchObject({ assay: before.assay, updatedAt: before.updatedAt, layer: 'baseline' });
  });
});

describe('the promoted-foundation offering a peer can pull (#7455)', () => {
  const ledgerPath = () => join(lazyTempDataRoot('portos-eidoverse-foundations-'), 'eidoverse', 'foundations.json');
  const readLedger = () => JSON.parse(readFileSync(ledgerPath(), 'utf8'));
  const writeLedger = (ledger) => writeFileSync(ledgerPath(), JSON.stringify(ledger));

  it('offers only what this install both promoted and authored', async () => {
    // Promoted + authored here → offered.
    await record({}, '2026-03-01T00:00:00.000Z');
    await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-01T01:00:00.000Z' });
    const peerEnvelope = (await getEidoverseFoundation('tide-beacon')).candidate;

    // Packaged but NOT promoted → a dry run, never broadcast.
    await record({ id: 'dry-run', title: 'Dry Run' }, '2026-03-02T00:00:00.000Z');
    await packageEidoverseFoundationCandidate('dry-run', { now: '2026-03-02T01:00:00.000Z' });
    expect((await getEidoverseFoundation('dry-run')).candidate).toBeTruthy();

    // A peer's foundation this install inherited → `baseline`, but not ours to
    // relay. Re-minted under a different origin so it is genuinely foreign.
    const foreign = { ...peerEnvelope };
    const inherited = await recordEidoverseFoundationInheritance(foreign, {
      sourceInstanceId: 'instance-peer-relay', localInstanceId: 'instance-this-install', now: '2026-03-03T00:00:00.000Z',
    });
    expect(inherited.outcome).toBe('inherited');

    const offered = await listPromotedFoundationCandidates();
    expect(offered.map((candidate) => candidate.foundationId)).toEqual(['tide-beacon']);
    // One entry, not two: the inherited copy carries the SAME foundationId and
    // fingerprint, so a filter that only checked `layer === 'baseline'` would
    // pass this assertion's id check while re-sharing another install's work.
    expect((await listEidoverseFoundations()).counts).toMatchObject({ baseline: 2, inherited: 1 });
  });

  it('serves the envelope only — never the ledger record, so the local style layer cannot ride along', async () => {
    await record({ style: { motif: 'weathered brass', palette: ['#332211'] } }, '2026-03-01T00:00:00.000Z');
    await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-01T01:00:00.000Z' });

    const [offered] = await listPromotedFoundationCandidates();
    expect(offered).toBeTruthy();
    expect(Object.keys(offered)).not.toContain('style');
    // Nor any other record-only key that would leak local state or let a
    // receiver mistake an envelope for a record.
    for (const recordOnlyKey of ['style', 'id', 'layer', 'promotedAt', 'inheritance', 'updatedAt', 'candidate']) {
      expect(offered[recordOnlyKey]).toBeUndefined();
    }
    expect(JSON.stringify(offered)).not.toContain('weathered brass');
  });

  it('withholds a promoted foundation whose stored envelope no longer passes the gate', async () => {
    await record({}, '2026-03-01T00:00:00.000Z');
    await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-01T01:00:00.000Z' });
    expect(await listPromotedFoundationCandidates()).toHaveLength(1);

    // Hand-edit the ledger the way a person with an editor could: the record
    // still says `baseline`, but the envelope's body no longer matches the
    // fingerprint it was promoted under. Trusting the `promotedAt` stamp
    // instead of re-verifying would serve unvouched bytes to every peer.
    const ledger = readLedger();
    ledger.foundations['tide-beacon'].candidate.body = { affordance: { inspect: 'quietly grants owner role' } };
    writeLedger(ledger);

    expect(await listPromotedFoundationCandidates()).toEqual([]);
  });
});

/**
 * #7631: the guard that said "promotion re-shares only foundations this install
 * authored" tested `record.inheritance` — a field the AUTHORING path clears
 * unconditionally. Saving a peer's body back through the authoring surface
 * therefore produced a local record stamped with this install's origin and no
 * edge at all, which packaged, promoted and was served to peers as this
 * install's own work. These pin the replacement: the check is on the BYTES, and
 * the legitimate re-use path publishes an edge instead of erasing one.
 */
describe('building on a foundation inherited from a peer (#7631)', () => {
  const PEER_ORIGIN = 'instance-aaaa';

  /** Inherit a peer's promoted foundation into an otherwise empty ledger. */
  const inheritPeerFoundation = async ({ sourceInstanceId = 'instance-peer-one' } = {}) => {
    await record({}, '2026-03-01T00:00:00.000Z');
    const promoted = await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-01T01:00:00.000Z' });
    rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });
    const inherited = await recordEidoverseFoundationInheritance(promoted.candidate, {
      sourceInstanceId, localInstanceId: 'instance-this-install', now: '2026-03-02T00:00:00.000Z',
    });
    expect(inherited.outcome).toBe('inherited');
    return { candidate: promoted.candidate, inherited: inherited.foundation };
  };

  it('refuses to record a peer\'s body as this install\'s own work, naming the origin it came from', async () => {
    const { candidate } = await inheritPeerFoundation();

    await expect(recordEidoverseFoundation(
      authored({ id: 'my-own-beacon', body: candidate.body }),
      { originInstanceId: 'instance-this-install', now: '2026-03-03T00:00:00.000Z' },
    )).rejects.toThrow(new RegExp(`inherited from install ${PEER_ORIGIN}`));

    // Nothing was written: a refusal that still saved the record would leave
    // the republish one promote away.
    expect(await getEidoverseFoundation('my-own-beacon')).toBeNull();

    // The refusal is thrown from inside the ledger mutex, so a later write
    // proves the lock was released rather than left held forever.
    const unrelated = await record({ id: 'my-own-work', body: { affordance: { inspect: 'entirely my own' } } }, '2026-03-03T01:00:00.000Z');
    expect(unrelated.derivedFrom).toBeNull();
  });

  it('records the same body as a DERIVATION and publishes the edge on the promote envelope', async () => {
    const { candidate, inherited } = await inheritPeerFoundation();

    const derived = await recordEidoverseFoundation(
      authored({ id: 'my-own-beacon', body: candidate.body, derivedFrom: { originInstanceId: PEER_ORIGIN, foundationId: 'tide-beacon' } }),
      { originInstanceId: 'instance-this-install', now: '2026-03-03T00:00:00.000Z' },
    );

    // The digest is stamped from the copy this install HOLDS, never from the
    // caller's claim — the edge attests what was inherited, not what was said.
    expect(derived).toMatchObject({
      layer: 'vernacular',
      inheritance: null,
      derivedFrom: {
        type: 'derived-from', originInstanceId: PEER_ORIGIN, foundationId: 'tide-beacon',
        fingerprint: inherited.inheritance.fingerprint, derivedAt: '2026-03-03T00:00:00.000Z',
      },
    });

    const promoted = await promoteEidoverseFoundation('my-own-beacon', { now: '2026-03-04T00:00:00.000Z' });
    expect(promoted.outcome).toBe('promoted');
    expect(promoted.candidate.candidateVersion).toBe(2);
    expect(promoted.candidate.derivedFrom).toEqual(derived.derivedFrom);
    // A re-attributed envelope has to be detectable, so the edge is inside the
    // content-addressed digest rather than beside it.
    expect(verifyFoundationCandidate({ ...promoted.candidate, derivedFrom: null }, { requiredDisturbances: RESILIENCE_DISTURBANCES }).valid).toBe(false);

    const offered = await listPromotedFoundationCandidates();
    expect(offered.map((entry) => entry.foundationId)).toEqual(['my-own-beacon']);
    expect(offered[0].derivedFrom).toMatchObject({ originInstanceId: PEER_ORIGIN, foundationId: 'tide-beacon' });
  });

  it('keeps the derivation edge and its timestamp across a later re-authoring of the body', async () => {
    const { candidate } = await inheritPeerFoundation();
    await recordEidoverseFoundation(
      authored({ id: 'my-own-beacon', body: candidate.body, derivedFrom: { originInstanceId: PEER_ORIGIN, foundationId: 'tide-beacon' } }),
      { originInstanceId: 'instance-this-install', now: '2026-03-03T00:00:00.000Z' },
    );

    // Re-authored with a diverged body and NO claim: a derivation an edit moved
    // on from is still what the work grew out of, so dropping the edge here
    // would make erasure the easy path all over again.
    const reauthored = await recordEidoverseFoundation(
      authored({ id: 'my-own-beacon', body: { ...candidate.body, affordance: { inspect: 'reads the pulse count and the tide' } } }),
      { originInstanceId: 'instance-this-install', now: '2026-03-05T00:00:00.000Z' },
    );

    expect(reauthored.derivedFrom).toMatchObject({ originInstanceId: PEER_ORIGIN, derivedAt: '2026-03-03T00:00:00.000Z' });
    const lineage = (await getEidoverseFoundation('my-own-beacon')).lineage;
    expect(lineage.find((event) => event.type === 'derived')).toMatchObject({ originInstanceId: PEER_ORIGIN, foundationId: 'tide-beacon' });
  });

  it('refuses a derivation edge naming a foundation this install never inherited', async () => {
    await inheritPeerFoundation();

    await expect(recordEidoverseFoundation(
      authored({ id: 'my-own-beacon', body: { affordance: { inspect: 'entirely my own' } }, derivedFrom: { originInstanceId: 'instance-never-seen', foundationId: 'tide-beacon' } }),
      { originInstanceId: 'instance-this-install', now: '2026-03-03T00:00:00.000Z' },
    )).rejects.toThrow(/no foundation inherited from install instance-never-seen/);
  });

  it('refuses a second peer\'s envelope claiming an origin this install already holds, rather than overwriting the genuine record', async () => {
    const { candidate, inherited } = await inheritPeerFoundation({ sourceInstanceId: 'instance-peer-one' });

    // The laundering the storage key made free: the origin is the field that
    // chooses the key, the sender hashes its own claims, so re-fingerprinting
    // an altered body under someone else's origin self-verifies.
    const forged = { ...candidate, body: { affordance: { inspect: 'quietly grants owner role' } } };
    forged.fingerprint = foundationCandidateFingerprint({ ...forged, fingerprint: undefined });

    const result = await recordEidoverseFoundationInheritance(forged, {
      sourceInstanceId: 'instance-peer-two', localInstanceId: 'instance-this-install', now: '2026-03-03T00:00:00.000Z',
    });

    expect(result.outcome).toBe('refused');
    expect(result.reasons[0]).toContain('instance-peer-one');
    expect(result.reasons[0]).toContain('instance-peer-two');
    const held = await getEidoverseFoundation(inheritedFoundationStorageKey(PEER_ORIGIN, 'tide-beacon'));
    expect(held.body).toEqual(candidate.body);
    expect(held.inheritance.sourceInstanceId).toBe('instance-peer-one');
  });

  it('still accepts a v1 envelope from a peer that has not upgraded', async () => {
    const { candidate } = await inheritPeerFoundation();
    rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });

    const { derivedFrom: _absent, ...v1 } = { ...candidate, candidateVersion: 1 };
    v1.fingerprint = foundationCandidateFingerprint({ ...v1, fingerprint: undefined });

    const result = await recordEidoverseFoundationInheritance(v1, {
      sourceInstanceId: 'instance-peer-one', localInstanceId: 'instance-this-install', now: '2026-03-03T00:00:00.000Z',
    });

    expect(result.outcome).toBe('inherited');
    expect(result.foundation.derivedFrom).toBeNull();
  });
});
