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
import {
  EIDOVERSE_FOUNDATION_CANDIDATE_VERSION,
  derivedContributionId,
  foundationCandidateFingerprint,
  inheritedFoundationStorageKey,
  verifyFoundationCandidate,
} from '../lib/eidoverseFoundations.js';
import { RESILIENCE_DISTURBANCES } from './eidoverseResilienceAssay.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-eidoverse-foundations-'),
}));

const {
  adoptEidoverseFoundation,
  applyEidoverseFoundationTombstones,
  deleteEidoverseFoundation,
  getEidoverseFoundation,
  getEidoverseFoundationByRef,
  listEidoverseFoundations,
  packageEidoverseFoundationCandidate,
  promoteEidoverseFoundation,
  recordEidoverseFoundation,
  recordEidoverseFoundationInheritance,
  listPromotedFoundationCandidates,
  listWithdrawnFoundationTombstones,
  withdrawEidoverseFoundation,
} = await import('./eidoverseFoundationLedger.js');

/**
 * A `controller` foundation naming a SHIPPED definition and carrying THIS
 * install's own config — a body the promote gate can replay on its own (#7625).
 *
 * This fixture used to name the shipped `beacon-relay-demo` assay fixture in a
 * free-text `contributionId` while its body described something else entirely,
 * and it packaged and promoted anyway. It was the canonical example of the hole:
 * the evidence a peer inherited on was about the demo fixture, not about "Tide
 * Beacon". There is no `contributionId` to supply now; the ledger derives it.
 */
const authored = (overrides = {}) => ({
  id: 'tide-beacon',
  kind: 'controller',
  title: 'Tide Beacon',
  summary: 'A beacon that keeps pulsing between mind wakes.',
  body: { controller: { definitionId: 'ambient-beacon', config: { label: 'tide', pulseEveryTicks: 3 } } },
  style: { motif: 'weathered brass' },
  authorKind: 'mind',
  ...overrides,
});

/** The label the fixture's own body derives — never authored. */
const DERIVED_CONTRIBUTION = 'controller:ambient-beacon';

/** A body with no derivable sandbox: it names no shipped controller. */
const UNREPLAYABLE_BODY = { schema: { pulses: 'integer' }, affordance: { inspect: 'reads the pulse count' } };

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

describe('deriving a district-template placement server-side (#7627)', () => {
  const districtTemplate = (bodyOverrides = {}) => authored({
    id: 'garden-arcade',
    kind: 'district-template',
    body: { layoutId: 'radial-ring', anchor: [1, 0, 2], propCount: 4, seed: 'plaza', ...bodyOverrides },
  });

  it('persists a server-derived placement for a declared {layoutId, anchor, seed}', async () => {
    const saved = await record(districtTemplate(), '2026-03-04T05:06:07.000Z');

    expect(saved.body.placement).toBeTruthy();
    expect(saved.body.placement).toHaveLength(4);
    expect(saved.body.layoutId).toBe('radial-ring');
  });

  it('reproduces byte-identical placement for the same {layoutId, anchor, seed} across two recordings', async () => {
    const first = await record(districtTemplate(), '2026-03-04T05:06:07.000Z');
    const second = await record(districtTemplate({ }), '2026-03-04T05:06:08.000Z');

    expect(second.body.placement).toEqual(first.body.placement);
  });

  it('replaces a caller-supplied placement that disagrees with the derivation, rather than merging it', async () => {
    const bogusPlacement = [{ pos: [999, 999, 999], yaw: 0 }];
    const saved = await record(districtTemplate({ placement: bogusPlacement }), '2026-03-04T05:06:07.000Z');

    expect(saved.body.placement).not.toEqual(bogusPlacement);
    expect(saved.body.placement).toHaveLength(4);
  });

  it('leaves a non-district-template body untouched even if it happens to carry a layoutId-shaped field', async () => {
    const saved = await record(authored({ body: { schema: { layoutId: 'not-a-real-layout', anchor: [0, 0, 0] } } }), '2026-03-04T05:06:07.000Z');

    expect(saved.body).toEqual({ schema: { layoutId: 'not-a-real-layout', anchor: [0, 0, 0] } });
  });

  it('leaves a district-template body without a declared layoutId/anchor untouched', async () => {
    const saved = await record(authored({ id: 'legacy-district', kind: 'district-template', body: { note: 'hand-authored, pre-toolkit' } }), '2026-03-04T05:06:07.000Z');

    expect(saved.body).toEqual({ note: 'hand-authored, pre-toolkit' });
  });

  it('refuses an unknown layoutId rather than silently storing an unusable declaration', async () => {
    await expect(record(districtTemplate({ layoutId: 'floating-islands' })))
      .rejects.toThrow(/Unknown layout "floating-islands"/);
  });
});

describe('packaging a promote candidate', () => {
  it('runs the assay itself and packages a foundation that survives it', async () => {
    await record({}, '2026-03-04T05:06:07.000Z');

    const result = await packageEidoverseFoundationCandidate('tide-beacon', { now: '2026-03-04T06:00:00.000Z' });

    expect(result.outcome).toBe('packaged');
    // The verdict came from the harness, not from anything the caller passed.
    expect(result.assay).toMatchObject({ harness: 'eidoverse-resilience-assay', contributionId: DERIVED_CONTRIBUTION, pass: true });
    // The evidence is about THIS body: the label was derived from it, not typed.
    expect(result.candidate.contributionId).toBe(DERIVED_CONTRIBUTION);
    expect(result.candidate.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.candidate)).not.toContain('weathered brass');

    const stored = await getEidoverseFoundation('tide-beacon');
    expect(stored.candidate.fingerprint).toBe(result.candidate.fingerprint);
    expect((await listEidoverseFoundations()).counts.candidates).toBe(1);
  });

  it('refuses a foundation whose own body cannot be replayed without its author', async () => {
    await record({ body: UNREPLAYABLE_BODY });

    const result = await packageEidoverseFoundationCandidate('tide-beacon');

    expect(result.outcome).toBe('refused');
    expect(result.reasons[0]).toMatch(/must declare `body\.controller\.definitionId`/);
    expect((await getEidoverseFoundation('tide-beacon')).candidate).toBeNull();
  });

  it('refuses a body that is unrelated to anything this install can replay, however it is labelled', async () => {
    // The #7625 regression, stated directly: naming a shipped contribution used
    // to be sufficient, so this exact record packaged. A caller cannot even
    // supply the label now, and the body decides.
    await expect(recordEidoverseFoundation({ ...authored({ body: UNREPLAYABLE_BODY }), contributionId: 'beacon-relay-demo' }, { originInstanceId: 'instance-aaaa' }))
      .rejects.toThrow();

    await record({ body: UNREPLAYABLE_BODY });
    expect((await getEidoverseFoundation('tide-beacon')).contributionId).toBe('controller:tide-beacon');
    expect((await packageEidoverseFoundationCandidate('tide-beacon')).outcome).toBe('refused');
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
    await record({ body: UNREPLAYABLE_BODY });

    const result = await promoteEidoverseFoundation('tide-beacon');

    expect(result).toMatchObject({ outcome: 'refused', promoted: false, foundation: null });
    expect(result.reasons[0]).toMatch(/must declare `body\.controller\.definitionId`/);
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

  it('refuses to package or promote an inherited record without touching the ledger, even though its own body is replayable here', async () => {
    const candidate = await peerCandidate();
    rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });
    const inherited = await recordEidoverseFoundationInheritance(candidate, {
      sourceInstanceId: 'instance-peer-relay', localInstanceId: 'instance-this-install', now: '2026-03-04T06:00:00.000Z',
    });
    const storageKey = inheritedFoundationStorageKey(inherited.foundation.provenance.originInstanceId, inherited.foundation.id);
    expect(inherited.outcome).toBe('inherited');

    // The candidate's body names a controller this install DOES ship, so a
    // guard that fired too late (after deriving the sandbox) would run the
    // assay against a peer's body and could package it instead of refusing.
    // If the record is untouched afterward, nothing ran.
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

  // #7627 derives a district-template's `placement` server-side, so the guard
  // has to digest the body it will STORE. Digesting the body as it arrived let a
  // caller re-submit just the inherited template's {layoutId, anchor, seed}
  // recipe — what `eidoverse.draft-foundation` returns — and land a stored body
  // byte-identical to the peer's while never matching it at the check.
  it('refuses a district-template whose recipe only derives into the inherited body', async () => {
    await record({ id: 'tide-beacon', kind: 'district-template', body: { layoutId: 'radial-ring', anchor: [1, 0, 2], propCount: 4, seed: 'plaza' } }, '2026-03-01T00:00:00.000Z');
    const promoted = await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-01T01:00:00.000Z' });
    rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });
    expect((await recordEidoverseFoundationInheritance(promoted.candidate, {
      sourceInstanceId: 'instance-peer-one', localInstanceId: 'instance-this-install', now: '2026-03-02T00:00:00.000Z',
    })).outcome).toBe('inherited');

    // The recipe ALONE — no `placement` key, so its raw digest cannot match the
    // inherited body, which carries the derived placement.
    await expect(recordEidoverseFoundation(
      authored({ id: 'my-own-arcade', kind: 'district-template', body: { layoutId: 'radial-ring', anchor: [1, 0, 2], propCount: 4, seed: 'plaza' } }),
      { originInstanceId: 'instance-this-install', now: '2026-03-03T00:00:00.000Z' },
    )).rejects.toThrow(new RegExp(`inherited from install ${PEER_ORIGIN}`));
    expect(await getEidoverseFoundation('my-own-arcade')).toBeNull();
  });

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
    expect(promoted.candidate.candidateVersion).toBe(EIDOVERSE_FOUNDATION_CANDIDATE_VERSION);
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
    //
    // The forgery is made INTERNALLY CONSISTENT under #7625 — a re-derived
    // binding label, and assay evidence recorded against it — precisely so this
    // test still proves what it is named for. A forger who re-fingerprints can
    // re-derive a label just as easily, and an envelope that tripped the
    // binding check would never reach the origin guard this asserts on.
    const forgedBody = { affordance: { inspect: 'quietly grants owner role' } };
    const forgedLabel = derivedContributionId({ kind: candidate.kind, id: candidate.foundationId, body: forgedBody });
    const forged = {
      ...candidate,
      body: forgedBody,
      contributionId: forgedLabel,
      assay: { ...candidate.assay, contributionId: forgedLabel },
    };
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

  it('refuses a pre-v3 envelope from a peer that has not upgraded, and stores nothing (#7625)', async () => {
    // v1 and v2 evidence was recorded against a contribution the SENDER named,
    // with no required relationship to the body beside it, so inheriting on it
    // would import a passing verdict about something else. There is nothing to
    // upgrade, so the accept side refuses rather than storing a record it would
    // have to distrust.
    const { candidate } = await inheritPeerFoundation();
    rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });

    const { derivedFrom: _absent, ...v1 } = { ...candidate, candidateVersion: 1 };
    v1.fingerprint = foundationCandidateFingerprint({ ...v1, fingerprint: undefined });

    const result = await recordEidoverseFoundationInheritance(v1, {
      sourceInstanceId: 'instance-peer-one', localInstanceId: 'instance-this-install', now: '2026-03-03T00:00:00.000Z',
    });

    expect(result.outcome).toBe('refused');
    expect(result.reasons[0]).toContain('candidate v1');
    expect(result.reasons[0]).toContain(`requires v${EIDOVERSE_FOUNDATION_CANDIDATE_VERSION}`);
    expect(await getEidoverseFoundation(inheritedFoundationStorageKey(PEER_ORIGIN, 'tide-beacon'))).toBeNull();
  });
});

/**
 * #7632: promotion used to be irreversible. A foundation left the install once
 * and every peer that pulled it kept that copy forever — the offering only
 * added, and the sweep converged upward toward whatever the sender currently
 * listed. De-promoting (by re-authoring, the only way there was) dropped the
 * record from the offering and told nobody.
 *
 * These pin the retraction path end to end, because no single-install
 * assertion can: the ORIGIN's tombstone is meaningless unless a RECEIVER acts
 * on it, and the receiver's reaper is meaningless unless the origin emits one.
 *
 * The two installs are simulated the way the #7631 suite above already does —
 * one temp data root at a time, wiped to "become" the receiver — so the
 * candidate and the tombstone list have to be captured on the origin before
 * the switch, exactly as they would be carried over the wire.
 */

/** This install's own origin id, as `record()` above stamps it. */
const LOCAL_ORIGIN = 'instance-aaaa';
/** The peer a simulated receiver pulled from. */
const PEER = 'instance-peer-one';

/** Promote on this install and hand back what a peer would have pulled. */
const promoteLocally = async () => {
  await record({}, '2026-03-01T00:00:00.000Z');
  const promoted = await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-01T01:00:00.000Z' });
  expect(promoted.outcome).toBe('promoted');
  return promoted.candidate;
};

describe('withdrawing a promoted foundation (#7632)', () => {
  /** Become a second install holding `candidate` inherited from `PEER`. */
  const becomeReceiverHolding = async (candidate) => {
    rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });
    const inherited = await recordEidoverseFoundationInheritance(candidate, {
      sourceInstanceId: PEER, localInstanceId: 'instance-this-install', now: '2026-03-02T00:00:00.000Z',
    });
    expect(inherited.outcome).toBe('inherited');
    return inherited.foundation;
  };

  it('de-promotes the record, stops offering it, and records a tombstone for what was published', async () => {
    const candidate = await promoteLocally();

    const result = await withdrawEidoverseFoundation('tide-beacon', { now: '2026-03-05T00:00:00.000Z' });

    expect(result.outcome).toBe('withdrawn');
    expect(result.foundation).toMatchObject({ layer: 'vernacular', promotedAt: null, candidate: null });
    expect(await listPromotedFoundationCandidates()).toEqual([]);
    // The body is KEPT — withdrawal un-publishes, it does not delete local work.
    expect((await getEidoverseFoundation('tide-beacon')).body).toEqual(candidate.body);
    expect(await listWithdrawnFoundationTombstones())
      .toEqual([{ fingerprint: candidate.fingerprint, deletedAt: '2026-03-05T00:00:00.000Z' }]);
  });

  // The whole point of the feature, and the one thing only a two-install cycle
  // can prove: a copy already on another machine actually goes away.
  it('drops a peer\'s inherited copy across a full promote → inherit → withdraw → sweep cycle', async () => {
    const candidate = await promoteLocally();
    await withdrawEidoverseFoundation('tide-beacon', { now: '2026-03-05T00:00:00.000Z' });
    const offered = await listWithdrawnFoundationTombstones();

    await becomeReceiverHolding(candidate);
    const heldKey = inheritedFoundationStorageKey(LOCAL_ORIGIN, 'tide-beacon');
    expect(await getEidoverseFoundation(heldKey)).toBeTruthy();

    expect(await applyEidoverseFoundationTombstones(offered, { sourceInstanceId: PEER })).toEqual({ removed: 1 });

    expect(await getEidoverseFoundation(heldKey)).toBeNull();
    expect((await listEidoverseFoundations()).counts.inherited).toBe(0);
  });

  it('is a silent no-op for a fingerprint this install does not hold', async () => {
    const candidate = await promoteLocally();
    await becomeReceiverHolding(candidate);

    // A receiver that never pulled the foundation (or already dropped it) is
    // already in the state the retraction asks for — not an error to surface.
    expect(await applyEidoverseFoundationTombstones(
      [{ fingerprint: 'b'.repeat(64), deletedAt: '2026-03-05T00:00:00.000Z' }], { sourceInstanceId: PEER },
    )).toEqual({ removed: 0 });
    expect((await listEidoverseFoundations()).counts.inherited).toBe(1);
  });

  // A fingerprint is public inside the federation the moment it is offered, so
  // it identifies a record but authorizes nothing. Without the scope, any
  // registered peer could retract a third install's work by naming it.
  it('refuses to act on a retraction from a peer this install did not inherit from', async () => {
    const candidate = await promoteLocally();
    await becomeReceiverHolding(candidate);

    expect(await applyEidoverseFoundationTombstones(
      [{ fingerprint: candidate.fingerprint, deletedAt: '2026-03-05T00:00:00.000Z' }],
      { sourceInstanceId: 'instance-peer-two' },
    )).toEqual({ removed: 0 });
    expect((await listEidoverseFoundations()).counts.inherited).toBe(1);
  });

  // `packagedAt` is hashed into the envelope, so an ordinary re-promote mints a
  // NEW fingerprint. That is the common case and it is already correct: the old
  // tombstone keeps retracting the bytes peers actually hold, while the fresh
  // envelope publishes beside it.
  it('keeps retracting the withdrawn envelope while offering the re-promoted one', async () => {
    const candidate = await promoteLocally();
    await withdrawEidoverseFoundation('tide-beacon', { now: '2026-03-05T00:00:00.000Z' });

    const again = await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-06T00:00:00.000Z' });

    expect(again.candidate.fingerprint).not.toBe(candidate.fingerprint);
    expect((await listPromotedFoundationCandidates()).map((entry) => entry.fingerprint)).toEqual([again.candidate.fingerprint]);
    expect((await listWithdrawnFoundationTombstones()).map((entry) => entry.fingerprint)).toEqual([candidate.fingerprint]);
  });

  // The edge the clear-on-promote exists for: promote → withdraw → promote all
  // stamped at one instant re-mints the SAME fingerprint. Without the clear the
  // offering would publish and retract one fingerprint at once, and the
  // outbound backstop would then withhold the candidate — a re-promote that
  // silently did nothing.
  it('clears the tombstone when a re-promote re-mints the identical fingerprint', async () => {
    const at = '2026-03-01T01:00:00.000Z';
    await record({}, '2026-03-01T00:00:00.000Z');
    const candidate = (await promoteEidoverseFoundation('tide-beacon', { now: at })).candidate;
    await withdrawEidoverseFoundation('tide-beacon', { now: at });

    const again = await promoteEidoverseFoundation('tide-beacon', { now: at });

    expect(again.candidate.fingerprint).toBe(candidate.fingerprint);
    expect(await listWithdrawnFoundationTombstones()).toEqual([]);
    expect((await listPromotedFoundationCandidates()).map((entry) => entry.fingerprint)).toEqual([candidate.fingerprint]);
  });

  // The originally-reported shape: re-authoring already de-promoted the record
  // locally and silently left every peer holding the retracted bytes.
  it('tombstones the published fingerprint when a promoted foundation is re-authored', async () => {
    const candidate = await promoteLocally();

    await record({ body: { affordance: { inspect: 'reads the pulse count and the tide' } } }, '2026-03-05T00:00:00.000Z');

    expect(await listWithdrawnFoundationTombstones())
      .toEqual([{ fingerprint: candidate.fingerprint, deletedAt: '2026-03-05T00:00:00.000Z' }]);
  });

  it('records nothing for a foundation that was only ever packaged, never promoted', async () => {
    await record({}, '2026-03-01T00:00:00.000Z');
    await packageEidoverseFoundationCandidate('tide-beacon', { now: '2026-03-01T01:00:00.000Z' });

    expect(await withdrawEidoverseFoundation('tide-beacon', { now: '2026-03-05T00:00:00.000Z' }))
      .toMatchObject({ outcome: 'not-promoted' });
    // A packaged candidate never left the install, so a tombstone for it would
    // broadcast a retraction no peer could possibly act on.
    expect(await listWithdrawnFoundationTombstones()).toEqual([]);
  });

  it('refuses to withdraw an inherited copy — this install never published it', async () => {
    await becomeReceiverHolding(await promoteLocally());

    const result = await withdrawEidoverseFoundation(inheritedFoundationStorageKey(LOCAL_ORIGIN, 'tide-beacon'));

    expect(result.outcome).toBe('refused');
    expect(result.reasons[0]).toContain(LOCAL_ORIGIN);
  });
});

describe('deleting a foundation record (#7632)', () => {
  it('withdraws a promoted local record before deleting it, so no peer is orphaned', async () => {
    const candidate = await promoteLocally();

    expect(await deleteEidoverseFoundation('tide-beacon', { now: '2026-03-05T00:00:00.000Z' }))
      .toMatchObject({ outcome: 'deleted', withdrawn: true });

    expect(await getEidoverseFoundation('tide-beacon')).toBeNull();
    // Deleting is the most natural gesture a regretful author makes; without
    // this the record vanishes locally and lives on every peer forever.
    expect(await listWithdrawnFoundationTombstones())
      .toEqual([{ fingerprint: candidate.fingerprint, deletedAt: '2026-03-05T00:00:00.000Z' }]);
  });

  it('addresses an inherited copy by { id, originInstanceId } rather than its storage key', async () => {
    const candidate = await promoteLocally();
    rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });
    await recordEidoverseFoundationInheritance(candidate, {
      sourceInstanceId: 'instance-peer-one', localInstanceId: 'instance-this-install', now: '2026-03-02T00:00:00.000Z',
    });

    // The bare id reaches only local work, on purpose: the two id spaces
    // legitimately overlap.
    expect(await deleteEidoverseFoundation('tide-beacon')).toMatchObject({ outcome: 'unknown-foundation' });
    expect(await deleteEidoverseFoundation('tide-beacon', { originInstanceId: 'instance-aaaa' }))
      .toMatchObject({ outcome: 'deleted', withdrawn: false });
    expect((await listEidoverseFoundations()).foundations).toEqual([]);
    // Deleting a copy this install merely holds retracts nothing: it was never
    // this install's to publish.
    expect(await listWithdrawnFoundationTombstones()).toEqual([]);
  });
});

/**
 * Epic #7453's headline success signal was "a mind can USE something another
 * mind left". Until #7626 nothing on either install read a foundation's
 * `body`: inheriting stored a row, `summarizeFoundation()` omitted the body,
 * `GET /foundations/:id` could not name a `peer:`-keyed record at all, and no
 * runtime consumed one. So the only way to use a peer's contribution was a
 * human reading raw JSON and retyping it — which #7631 then refuses as
 * republishing. These pin the two verbs that close it.
 */
describe('reading and adopting an inherited foundation (#7626)', () => {
  const PEER_ORIGIN = 'instance-aaaa';

  /** Promote a foundation as one install, then inherit it as another. */
  const inheritPeerControllerFoundation = async (bodyOverride) => {
    await record({ body: bodyOverride ?? { controller: { definitionId: 'ambient-beacon', config: { label: 'harbor', pulseEveryTicks: 3 } } } }, '2026-03-01T00:00:00.000Z');
    const promoted = await promoteEidoverseFoundation('tide-beacon', { now: '2026-03-01T01:00:00.000Z' });
    expect(promoted.outcome).toBe('promoted');
    rmSync(lazyTempDataRoot('portos-eidoverse-foundations-'), { recursive: true, force: true });
    const inherited = await recordEidoverseFoundationInheritance(promoted.candidate, {
      sourceInstanceId: 'instance-peer-one', localInstanceId: 'instance-this-install', now: '2026-03-02T00:00:00.000Z',
    });
    expect(inherited.outcome).toBe('inherited');
    return inherited.foundation;
  };

  it('reaches a local and an inherited record sharing one id without confusing them', async () => {
    await inheritPeerControllerFoundation();
    // A LOCAL foundation under the same human-readable id, authored after the
    // inherited copy landed. Before the ref grammar, the bare id was the only
    // address a read-one caller had, so the inherited copy was unreachable and
    // an ambiguous id silently meant "the local one".
    await record({ summary: 'This install\'s own beacon, not the peer\'s.' }, '2026-03-03T00:00:00.000Z');

    const local = await getEidoverseFoundationByRef({ id: 'tide-beacon', originInstanceId: null });
    const peers = await getEidoverseFoundationByRef({ id: 'tide-beacon', originInstanceId: PEER_ORIGIN });

    expect(local.layer).toBe('vernacular');
    expect(local.inheritance).toBeNull();
    expect(peers.layer).toBe('baseline');
    expect(peers.inheritance).toMatchObject({ originInstanceId: PEER_ORIGIN, sourceInstanceId: 'instance-peer-one' });
    // An origin this install never inherited from resolves to nothing rather
    // than falling back to the local record.
    expect(await getEidoverseFoundationByRef({ id: 'tide-beacon', originInstanceId: 'instance-never-seen' })).toBeNull();
  });

  it('adopts an inherited controller foundation into a disarmed install carrying a derived-from edge', async () => {
    const inherited = await inheritPeerControllerFoundation();

    const adopted = await adoptEidoverseFoundation({ id: 'tide-beacon', originInstanceId: PEER_ORIGIN }, { installedBy: 'mind' });

    expect(adopted.outcome).toBe('adopted');
    // Disarmed and silent: adopting a peer's controller must not, in one call,
    // produce a thing already ticking and already allowed to act in the world.
    expect(adopted.install).toMatchObject({
      id: 'tide-beacon',
      controllerId: 'ambient-beacon',
      armed: false,
      deliverEffects: false,
      config: { label: 'harbor', pulseEveryTicks: 3 },
    });
    expect(adopted.install.derivedFrom).toEqual({
      type: 'derived-from',
      originInstanceId: PEER_ORIGIN,
      foundationId: 'tide-beacon',
      fingerprint: inherited.inheritance.fingerprint,
      derivedAt: '2026-03-02T00:00:00.000Z',
    });
  });

  it('keeps the derived-from edge when the adopted controller is later re-installed by hand', async () => {
    await inheritPeerControllerFoundation();
    const adopted = await adoptEidoverseFoundation({ id: 'tide-beacon', originInstanceId: PEER_ORIGIN });
    const { installEidoverseController } = await import('./eidoverseControllerRuntime.js');

    // An ordinary local edit — change the cadence, arm it — passes no
    // `derivedFrom`. An edge that vanished here would make erasing a peer's
    // attribution the path of least effort, which is the hole #7631 closed on
    // the authoring side.
    const reinstalled = await installEidoverseController(
      { id: 'tide-beacon', controllerId: 'ambient-beacon', config: { label: 'harbor', pulseEveryTicks: 3 }, tickIntervalMs: 600_000, armed: true },
      { installedBy: 'user' },
    );

    expect(reinstalled.outcome).toBe('installed');
    expect(reinstalled.install.armed).toBe(true);
    expect(reinstalled.install.derivedFrom).toEqual(adopted.install.derivedFrom);
  });

  it('refuses a kind with no interpreter by name rather than succeeding at nothing', async () => {
    await inheritPeerControllerFoundation();
    const foundations = JSON.parse(readFileSync(join(lazyTempDataRoot('portos-eidoverse-foundations-'), 'eidoverse', 'foundations.json'), 'utf8'));
    const key = inheritedFoundationStorageKey(PEER_ORIGIN, 'tide-beacon');
    foundations.foundations[key].kind = 'schema';
    writeFileSync(join(lazyTempDataRoot('portos-eidoverse-foundations-'), 'eidoverse', 'foundations.json'), JSON.stringify(foundations));

    const result = await adoptEidoverseFoundation({ id: 'tide-beacon', originInstanceId: PEER_ORIGIN });

    expect(result.outcome).toBe('refused');
    expect(result.install).toBeNull();
    expect(result.reasons[0]).toContain('"schema" foundation is a declaration with no interpreter');
  });

  it('refuses to adopt a foundation this install authored itself', async () => {
    await record({}, '2026-03-04T00:00:00.000Z');

    const result = await adoptEidoverseFoundation({ id: 'tide-beacon', originInstanceId: null });

    expect(result.outcome).toBe('refused');
    expect(result.reasons[0]).toContain('authored on this install');
  });

  it('refuses rather than overwriting a controller already installed under that id for another reason', async () => {
    await inheritPeerControllerFoundation();
    const { installEidoverseController } = await import('./eidoverseControllerRuntime.js');
    // A controller the user stood up themselves, which happens to share the
    // foundation's id. Installing over it would silently retarget a RUNNING
    // controller at a peer's config.
    expect((await installEidoverseController(
      { id: 'tide-beacon', controllerId: 'lantern-keeper', config: { lanterns: [{ id: 'plaza-lantern', pos: [0, 2, 0] }] }, armed: true },
      { installedBy: 'user' },
    )).outcome).toBe('installed');

    const result = await adoptEidoverseFoundation({ id: 'tide-beacon', originInstanceId: PEER_ORIGIN });

    expect(result.outcome).toBe('refused');
    expect(result.reasons[0]).toContain('retire it first');
  });

  it('reports an unknown reference as its own outcome, not as a refusal', async () => {
    const result = await adoptEidoverseFoundation({ id: 'tide-beacon', originInstanceId: 'instance-never-seen' });
    expect(result.outcome).toBe('unknown-foundation');
  });
});
