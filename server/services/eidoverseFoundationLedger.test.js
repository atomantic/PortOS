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
  recordEidoverseFoundation,
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
    expect(listed.counts).toEqual({ vernacular: 0, baseline: 0, candidates: 0 });
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
