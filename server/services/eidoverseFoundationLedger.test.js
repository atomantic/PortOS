/**
 * The ledger is the persisted half of the local-vs-baseline ownership boundary
 * (#7455). What these tests pin is the workflow contract a route or mind tool
 * depends on: an authored artifact is LOCAL, the promote gate RUNS the
 * agent-free assay rather than believing a caller, and a re-authored body loses
 * the verdict that vouched for the previous one.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

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
});
