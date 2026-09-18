/**
 * The de-promotion this migration owes installs that crossed #7625.
 *
 * Every record in `data/eidoverse/foundations.json` carries assay evidence
 * produced by the OLD replay — a verdict about whatever module the author
 * named. What matters is that a foundation whose body cannot be replayed stops
 * being `baseline` (and so stops being offered to peers) while a replayable one
 * keeps its place and only loses the stale verdict.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import migration from './397-eidoverse-foundation-derived-assay.js';

const roots = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'portos-migration-397-'));
  roots.push(root);
  mkdirSync(join(root, 'data', 'eidoverse'), { recursive: true });
  return root;
};
const ledgerPath = (root) => join(root, 'data', 'eidoverse', 'foundations.json');
const writeLedger = (root, foundations) => writeFileSync(ledgerPath(root), JSON.stringify({ schemaVersion: 1, foundations }, null, 2));
const readLedger = (root) => JSON.parse(readFileSync(ledgerPath(root), 'utf8')).foundations;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const base = (overrides) => ({
  id: 'tide-beacon',
  layer: 'baseline',
  kind: 'controller',
  title: 'Tide Beacon',
  summary: 'A beacon that keeps pulsing.',
  contributionId: 'beacon-relay-demo',
  body: {},
  style: {},
  provenance: { originInstanceId: 'instance-aaaa', authorKind: 'mind', createdAt: '2026-03-01T00:00:00.000Z' },
  disclosure: { requires: [], effects: [], license: null, notes: null },
  assay: { harness: 'eidoverse-resilience-assay', contributionId: 'beacon-relay-demo', pass: true, disturbances: ['reconnect'], ranAt: '2026-03-01T00:00:00.000Z', reasons: [] },
  candidate: { candidateVersion: 1, foundationId: 'tide-beacon' },
  promotedAt: '2026-03-01T01:00:00.000Z',
  inheritance: null,
  updatedAt: '2026-03-01T00:00:00.000Z',
  ...overrides,
});

describe('migration 397 — re-bind foundations to body-derived assay evidence', () => {
  it('writes nothing on an install that never authored a foundation', async () => {
    const root = makeRoot();
    expect(await migration.up({ rootDir: root })).toMatchObject({ updated: 0, reason: 'no-foundation-ledger' });
  });

  it('returns an unreplayable baseline foundation to vernacular and drops its evidence', async () => {
    const root = makeRoot();
    // The canonical pre-#7625 record: it named a shipped demo fixture and its
    // body describes something else, so nothing here can replay it.
    writeLedger(root, { 'tide-beacon': base({ body: { schema: { pulses: 'integer' }, affordance: { inspect: 'reads the pulse count' } } }) });

    const result = await migration.up({ rootDir: root });

    expect(result).toMatchObject({ updated: 1, dePromoted: 1 });
    expect(readLedger(root)['tide-beacon']).toMatchObject({
      layer: 'vernacular', promotedAt: null, assay: null, candidate: null, contributionId: 'controller:tide-beacon',
    });
  });

  it('keeps a replayable foundation in the baseline but drops the verdict the old replay produced', async () => {
    const root = makeRoot();
    writeLedger(root, { 'tide-beacon': base({ body: { controller: { definitionId: 'ambient-beacon', config: { pulseEveryTicks: 3 } } } }) });

    const result = await migration.up({ rootDir: root });

    expect(result).toMatchObject({ updated: 1, dePromoted: 0 });
    expect(readLedger(root)['tide-beacon']).toMatchObject({
      layer: 'baseline', promotedAt: '2026-03-01T01:00:00.000Z', assay: null, candidate: null, contributionId: 'controller:ambient-beacon',
    });
  });

  it('drops an inherited copy\'s v1 envelope without relabelling or replaying a peer\'s body', async () => {
    const root = makeRoot();
    const key = 'peer:instance-bbbb:tide-beacon';
    writeLedger(root, {
      [key]: base({
        provenance: { originInstanceId: 'instance-bbbb', authorKind: 'mind', createdAt: '2026-03-01T00:00:00.000Z' },
        inheritance: { type: 'inherited-from', originInstanceId: 'instance-bbbb', foundationId: 'tide-beacon', fingerprint: 'a'.repeat(64), packagedAt: '2026-03-01T01:00:00.000Z', sourceInstanceId: 'instance-cccc', inheritedAt: '2026-03-02T00:00:00.000Z' },
        promotedAt: null,
      }),
    });

    await migration.up({ rootDir: root });

    const stored = readLedger(root)[key];
    expect(stored).toMatchObject({ layer: 'baseline', assay: null, candidate: null, contributionId: 'beacon-relay-demo' });
  });

  it('is idempotent — a second run finds nothing left to re-bind', async () => {
    const root = makeRoot();
    writeLedger(root, { 'tide-beacon': base({ body: { controller: { definitionId: 'ambient-beacon', config: {} } } }) });

    await migration.up({ rootDir: root });
    expect(await migration.up({ rootDir: root })).toMatchObject({ updated: 0, reason: 'already-derived' });
  });

  it('leaves an unparseable ledger untouched rather than replacing it with an empty one', async () => {
    const root = makeRoot();
    writeFileSync(ledgerPath(root), '{ truncated mid-write');

    expect(await migration.up({ rootDir: root })).toMatchObject({ updated: 0, reason: 'unreadable-ledger' });
    expect(readFileSync(ledgerPath(root), 'utf8')).toBe('{ truncated mid-write');
  });
});
