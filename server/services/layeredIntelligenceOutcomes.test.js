import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCollectionStore } from '../lib/collectionStore.js';
import {
  sanitizeOutcomeRecord,
  recordFiledProposal,
  listOutcomes,
  reconcileOutcomes,
  OUTCOME_RETENTION_MS,
  LI_OUTCOMES_SCHEMA_VERSION
} from './layeredIntelligenceOutcomes.js';

// Build an isolated store over a temp dir so the suite never touches the real
// data/cos/li-outcomes collection. The store functions all take an injectable
// `store` param exactly so tests can drive them without PATHS.cos.
let dir;
let store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'li-outcomes-'));
  store = createCollectionStore({
    dir,
    type: 'li-outcomes',
    schemaVersion: LI_OUTCOMES_SCHEMA_VERSION,
    sanitizeRecord: sanitizeOutcomeRecord
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('sanitizeOutcomeRecord', () => {
  it('drops rows without a usable appId + slug', () => {
    expect(sanitizeOutcomeRecord(null)).toBeNull();
    expect(sanitizeOutcomeRecord({ slug: 'x' })).toBeNull();
    expect(sanitizeOutcomeRecord({ appId: 'a' })).toBeNull();
  });

  it('normalizes the slug and coerces an unknown outcome to null', () => {
    const r = sanitizeOutcomeRecord({ appId: 'app-1', slug: 'Add Metrics', outcome: 'bogus' });
    expect(r.slug).toBe('add-metrics');
    expect(r.outcome).toBeNull();
  });

  it('keeps outcome metadata only alongside a valid outcome', () => {
    const resolved = sanitizeOutcomeRecord({ appId: 'a', slug: 's', outcome: 'merged', outcomeAt: 'x', outcomeReason: 'y' });
    expect(resolved.outcome).toBe('merged');
    expect(resolved.outcomeAt).toBe('x');
    const unresolved = sanitizeOutcomeRecord({ appId: 'a', slug: 's', outcome: null, outcomeAt: 'x', outcomeReason: 'y' });
    expect(unresolved.outcomeAt).toBeNull();
    expect(unresolved.outcomeReason).toBeNull();
  });
});

describe('recordFiledProposal + listOutcomes', () => {
  it('records a filed proposal with a null (unresolved) outcome', async () => {
    const ok = await recordFiledProposal({ appId: 'app-1', slug: 'add-metrics', tracker: 'github', issueRef: '#42', scope: 'app-data-gap' }, store);
    expect(ok).toBe(true);
    const rows = await listOutcomes({ appId: 'app-1' }, store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ appId: 'app-1', slug: 'add-metrics', tracker: 'github', issueRef: '#42', scope: 'app-data-gap', outcome: null });
    expect(rows[0].filedAt).toBeTruthy();
  });

  it('refuses a record with no appId or slug', async () => {
    expect(await recordFiledProposal({ slug: 's' }, store)).toBe(false);
    expect(await recordFiledProposal({ appId: 'a' }, store)).toBe(false);
  });

  it('scopes listOutcomes to one app', async () => {
    await recordFiledProposal({ appId: 'app-1', slug: 's1', scope: 'app-improvement' }, store);
    await recordFiledProposal({ appId: 'app-2', slug: 's2', scope: 'app-improvement' }, store);
    expect(await listOutcomes({ appId: 'app-1' }, store)).toHaveLength(1);
    expect(await listOutcomes({ appId: 'app-2' }, store)).toHaveLength(1);
  });

  it('retains an unresolved record past the window (like an open issue)', async () => {
    const now = Date.now();
    await recordFiledProposal({ appId: 'app-1', slug: 'still-open', scope: 'app-improvement', now: now - OUTCOME_RETENTION_MS - 10000 }, store);
    const rows = await listOutcomes({ appId: 'app-1', now }, store);
    expect(rows.map(r => r.slug)).toEqual(['still-open']);
  });

  it('GC-drops a resolved record once the window elapses from its outcomeAt (not filedAt)', async () => {
    const now = Date.now();
    // Filed recently, but resolved with an old closedAt → measured from outcomeAt, it's stale.
    await recordFiledProposal({ appId: 'app-1', slug: 'old-merged', scope: 'app-improvement', now: now - 1000 }, store);
    const oldClosed = new Date(now - OUTCOME_RETENTION_MS - 1000).toISOString();
    await reconcileOutcomes({ appId: 'app-1', existingIssues: [{ slug: 'old-merged', state: 'closed', stateReason: 'completed', closedAt: oldClosed }], now }, store);
    expect(await listOutcomes({ appId: 'app-1', now }, store)).toEqual([]);

    // A record resolved within the window survives.
    await recordFiledProposal({ appId: 'app-1', slug: 'fresh-merged', scope: 'app-improvement', now }, store);
    await reconcileOutcomes({ appId: 'app-1', existingIssues: [{ slug: 'fresh-merged', state: 'closed', stateReason: 'completed', closedAt: new Date(now).toISOString() }], now }, store);
    const kept = await listOutcomes({ appId: 'app-1', now }, store);
    expect(kept.map(r => r.slug)).toEqual(['fresh-merged']);
  });

  it('stamps the type-level schemaVersion on the first record (so a future bump is detectable)', async () => {
    // Fresh store: the boot verifier sees no index.json.
    expect((await store.verifySchemaVersion()).onDisk).toBeNull();
    await recordFiledProposal({ appId: 'app-1', slug: 's', scope: 'app-improvement' }, store);
    expect((await store.verifySchemaVersion()).onDisk).toBe(LI_OUTCOMES_SCHEMA_VERSION);
  });
});

describe('reconcileOutcomes', () => {
  it('resolves unresolved records from the fresh tracker state', async () => {
    await recordFiledProposal({ appId: 'app-1', slug: 'merged-one', scope: 'app-data-gap' }, store);
    await recordFiledProposal({ appId: 'app-1', slug: 'rejected-one', scope: 'app-improvement' }, store);
    await recordFiledProposal({ appId: 'app-1', slug: 'abandoned-one', scope: 'app-improvement' }, store);
    await recordFiledProposal({ appId: 'app-1', slug: 'still-open', scope: 'app-improvement' }, store);

    const existingIssues = [
      { slug: 'merged-one', state: 'closed', stateReason: 'completed', closedAt: '2026-07-01T00:00:00Z' },
      { slug: 'rejected-one', state: 'closed', stateReason: 'not_planned' },
      { slug: 'abandoned-one', state: 'closed', stateReason: 'duplicate', closedAt: '2026-07-02T00:00:00Z' },
      { slug: 'still-open', state: 'open' }
    ];
    const updated = await reconcileOutcomes({ appId: 'app-1', existingIssues }, store);
    expect(updated).toBe(3);

    const byslug = Object.fromEntries((await listOutcomes({ appId: 'app-1' }, store)).map(r => [r.slug, r]));
    expect(byslug['merged-one'].outcome).toBe('merged');
    expect(byslug['merged-one'].outcomeAt).toBe('2026-07-01T00:00:00Z');
    expect(byslug['rejected-one'].outcome).toBe('rejected');
    // A close with an unrecognized present reason persists as abandoned (#2620) —
    // it must not inflate the merged count the reasoner calibrates against.
    expect(byslug['abandoned-one'].outcome).toBe('abandoned');
    expect(byslug['abandoned-one'].outcomeReason).toBe('duplicate');
    expect(byslug['still-open'].outcome).toBeNull();
  });

  it('does not re-resolve an already-resolved record', async () => {
    await recordFiledProposal({ appId: 'app-1', slug: 's', scope: 'app-improvement' }, store);
    await reconcileOutcomes({ appId: 'app-1', existingIssues: [{ slug: 's', state: 'closed', stateReason: 'completed' }] }, store);
    // Second pass with the issue now reported open should NOT flip it back.
    const updated = await reconcileOutcomes({ appId: 'app-1', existingIssues: [{ slug: 's', state: 'open' }] }, store);
    expect(updated).toBe(0);
    // And a pass with the SAME closed state is a no-op write.
    const same = await reconcileOutcomes({ appId: 'app-1', existingIssues: [{ slug: 's', state: 'closed', stateReason: 'completed' }] }, store);
    expect(same).toBe(0);
    const rows = await listOutcomes({ appId: 'app-1' }, store);
    expect(rows[0].outcome).toBe('merged');
  });

  it('refreshes outcomeAt when a proposal re-closes to the same outcome with a newer close time (#2620)', async () => {
    // closed → reopened → re-closed completed: the derived outcome is unchanged,
    // but retention/GC keys on outcomeAt, so it must advance to the latest close.
    await recordFiledProposal({ appId: 'app-1', slug: 'recycled', scope: 'app-improvement' }, store);
    await reconcileOutcomes({
      appId: 'app-1',
      existingIssues: [{ slug: 'recycled', state: 'closed', stateReason: 'completed', closedAt: '2026-07-01T00:00:00Z' }]
    }, store);
    const updated = await reconcileOutcomes({
      appId: 'app-1',
      existingIssues: [{ slug: 'recycled', state: 'closed', stateReason: 'completed', closedAt: '2026-07-10T00:00:00Z' }]
    }, store);
    expect(updated).toBe(1);
    const rows = await listOutcomes({ appId: 'app-1' }, store);
    expect(rows[0].outcome).toBe('merged');
    expect(rows[0].outcomeAt).toBe('2026-07-10T00:00:00Z');
  });

  it('reclassifies a record persisted under the old any-close-is-merged mapping (#2620)', async () => {
    // Simulate an install upgrading: a duplicate-closed issue was reconciled as
    // `merged` by the pre-#2620 mapping. The next reconcile against the same
    // live tracker state must self-heal it to `abandoned` instead of letting it
    // inflate the merge rate until the record expires.
    await recordFiledProposal({ appId: 'app-1', slug: 'legacy', scope: 'app-improvement' }, store);
    const legacy = (await listOutcomes({ appId: 'app-1' }, store))[0];
    await store.saveOne('app-1--legacy', {
      ...legacy, outcome: 'merged', outcomeAt: '2026-07-01T00:00:00Z', outcomeReason: 'duplicate'
    });
    const updated = await reconcileOutcomes({
      appId: 'app-1',
      existingIssues: [{ slug: 'legacy', state: 'closed', stateReason: 'duplicate', closedAt: '2026-07-01T00:00:00Z' }]
    }, store);
    expect(updated).toBe(1);
    const rows = await listOutcomes({ appId: 'app-1' }, store);
    expect(rows[0].outcome).toBe('abandoned');
    expect(rows[0].outcomeAt).toBe('2026-07-01T00:00:00Z');
  });

  it('is a no-op with no existing issues', async () => {
    await recordFiledProposal({ appId: 'app-1', slug: 's', scope: 'app-improvement' }, store);
    expect(await reconcileOutcomes({ appId: 'app-1', existingIssues: [] }, store)).toBe(0);
  });
});
