import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCollectionStore } from '../lib/collectionStore.js';
import {
  sanitizeOutcomeRecord,
  recordFiledProposal,
  listOutcomes,
  listOutcomesResult,
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

  describe('rejectionReason (#2689)', () => {
    const sanitize = (over) => sanitizeOutcomeRecord({ appId: 'a', slug: 's', ...over });

    it('keeps a valid taxonomy token on a non-merged record', () => {
      expect(sanitize({ outcome: 'rejected', rejectionReason: 'duplicate' }).rejectionReason).toBe('duplicate');
      expect(sanitize({ outcome: 'abandoned', rejectionReason: 'unknown-reason' }).rejectionReason).toBe('unknown-reason');
    });

    it('strips a rejection reason from a merged or unresolved record', () => {
      // A merged proposal has no rejection to explain; a stray token would inflate
      // the rejection tally.
      expect(sanitize({ outcome: 'merged', rejectionReason: 'duplicate' }).rejectionReason).toBeNull();
      expect(sanitize({ outcome: null, rejectionReason: 'duplicate' }).rejectionReason).toBeNull();
    });

    it('coerces an unrecognized token to null (unclassified), NOT to unknown-reason', () => {
      // null re-classifies on the next reconcile; laundering it into the sentinel
      // would freeze a bogus "we looked and found nothing" in place.
      expect(sanitize({ outcome: 'rejected', rejectionReason: 'bogus' }).rejectionReason).toBeNull();
      expect(sanitize({ outcome: 'rejected', rejectionReason: 42 }).rejectionReason).toBeNull();
    });

    it('defaults a pre-taxonomy record to null rather than inventing a reason', () => {
      expect(sanitize({ outcome: 'rejected' }).rejectionReason).toBeNull();
    });
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

  describe('rejection classification (#2689)', () => {
    const rowsBySlug = async () =>
      Object.fromEntries((await listOutcomes({ appId: 'app-1' }, store)).map(r => [r.slug, r]));

    it('classifies each non-merged proposal from the tracker state it already has', async () => {
      await recordFiledProposal({ appId: 'app-1', slug: 'merged-one' }, store);
      await recordFiledProposal({ appId: 'app-1', slug: 'declined' }, store);
      await recordFiledProposal({ appId: 'app-1', slug: 'dupe' }, store);
      await recordFiledProposal({ appId: 'app-1', slug: 'labelled' }, store);
      await recordFiledProposal({ appId: 'app-1', slug: 'mystery' }, store);

      await reconcileOutcomes({
        appId: 'app-1',
        existingIssues: [
          { slug: 'merged-one', state: 'closed', stateReason: 'completed' },
          { slug: 'declined', state: 'closed', stateReason: 'not_planned' },
          { slug: 'dupe', state: 'closed', stateReason: 'duplicate' },
          { slug: 'labelled', state: 'closed', stateReason: 'not_planned', labels: ['out-of-scope'] },
          { slug: 'mystery', state: 'closed', stateReason: 'reopened' }
        ]
      }, store);

      const rows = await rowsBySlug();
      // A merged proposal is never given a rejection reason — the load-bearing case
      // for jira/plan, whose trackers report no stateReason at all.
      expect(rows['merged-one'].rejectionReason).toBeNull();
      expect(rows['declined'].rejectionReason).toBe('user-rejected');
      expect(rows['dupe'].rejectionReason).toBe('duplicate');
      // A label outranks the generic not_planned.
      expect(rows['labelled'].rejectionReason).toBe('scope-mismatch');
      // No signal ⇒ the explicit sentinel, never a fabricated diagnosis.
      expect(rows['mystery'].rejectionReason).toBe('unknown-reason');
    });

    it('backfills a record resolved before the taxonomy existed', async () => {
      // Pre-#2689 installs hold resolved records with no rejectionReason. The
      // outcome is unchanged, so only the classification diff can trigger the
      // rewrite that fills them in.
      await recordFiledProposal({ appId: 'app-1', slug: 'legacy' }, store);
      const legacy = (await listOutcomes({ appId: 'app-1' }, store))[0];
      await store.saveOne('app-1--legacy', {
        ...legacy, outcome: 'rejected', outcomeAt: '2026-07-01T00:00:00Z', outcomeReason: 'not_planned'
      });
      expect((await rowsBySlug())['legacy'].rejectionReason).toBeNull();

      const updated = await reconcileOutcomes({
        appId: 'app-1',
        existingIssues: [{ slug: 'legacy', state: 'closed', stateReason: 'not_planned', closedAt: '2026-07-01T00:00:00Z' }]
      }, store);
      expect(updated).toBe(1);
      const row = (await rowsBySlug())['legacy'];
      expect(row.rejectionReason).toBe('user-rejected');
      expect(row.outcome).toBe('rejected');
      // Backfilling the diagnosis must not disturb the retention clock.
      expect(row.outcomeAt).toBe('2026-07-01T00:00:00Z');
    });

    it('re-diagnoses an unknown-reason record once the issue is finally labelled', async () => {
      await recordFiledProposal({ appId: 'app-1', slug: 'mystery' }, store);
      const closed = { slug: 'mystery', state: 'closed', stateReason: 'reopened', closedAt: '2026-07-01T00:00:00Z' };
      await reconcileOutcomes({ appId: 'app-1', existingIssues: [closed] }, store);
      expect((await rowsBySlug())['mystery'].rejectionReason).toBe('unknown-reason');

      const updated = await reconcileOutcomes({
        appId: 'app-1',
        existingIssues: [{ ...closed, labels: ['duplicate'] }]
      }, store);
      expect(updated).toBe(1);
      expect((await rowsBySlug())['mystery'].rejectionReason).toBe('duplicate');
    });

    it('leaves a label-only closure on a reason-less tracker unclassified (known limitation)', async () => {
      // glab/jira never report a stateReason, so deriveOutcome reads a bare close as
      // `merged` and classification never runs — the `wontfix` signal is wasted.
      // Pinned so the gap is explicit, not accidental. Letting labels override the
      // merged fallback is NOT a safe fix: a stale `blocked` label on a genuinely
      // completed issue would flip it to rejected and corrupt the merge rate the
      // other way. Needs a disposition/state label split + a deriveOutcome change
      // (#2620's semantics) — see the module header.
      await recordFiledProposal({ appId: 'app-1', slug: 'glab-wontfix' }, store);
      await reconcileOutcomes({
        appId: 'app-1',
        existingIssues: [{ slug: 'glab-wontfix', state: 'closed', stateReason: null, labels: ['wontfix'], closedAt: '2026-07-01T00:00:00Z' }]
      }, store);
      const row = (await rowsBySlug())['glab-wontfix'];
      expect(row.outcome).toBe('merged');
      expect(row.rejectionReason).toBeNull();
    });

    it('clears a stale rejection reason when a proposal is reopened and then merged', async () => {
      // rejected → reopened → closed completed. The write side must drop the old
      // diagnosis, not just rely on the sanitizer stripping it on read.
      await recordFiledProposal({ appId: 'app-1', slug: 'revived' }, store);
      await reconcileOutcomes({
        appId: 'app-1',
        existingIssues: [{ slug: 'revived', state: 'closed', stateReason: 'not_planned', closedAt: '2026-07-01T00:00:00Z' }]
      }, store);
      expect((await rowsBySlug())['revived'].rejectionReason).toBe('user-rejected');

      const updated = await reconcileOutcomes({
        appId: 'app-1',
        existingIssues: [{ slug: 'revived', state: 'closed', stateReason: 'completed', closedAt: '2026-07-09T00:00:00Z' }]
      }, store);
      expect(updated).toBe(1);
      const row = (await rowsBySlug())['revived'];
      expect(row.outcome).toBe('merged');
      expect(row.rejectionReason).toBeNull();
    });

    it('does not churn a settled record whose classification is unchanged', async () => {
      await recordFiledProposal({ appId: 'app-1', slug: 's' }, store);
      const issue = { slug: 's', state: 'closed', stateReason: 'not_planned', closedAt: '2026-07-01T00:00:00Z' };
      expect(await reconcileOutcomes({ appId: 'app-1', existingIssues: [issue] }, store)).toBe(1);
      expect(await reconcileOutcomes({ appId: 'app-1', existingIssues: [issue] }, store)).toBe(0);
    });
  });
});

describe('listOutcomesResult read sentinel (#2700)', () => {
  it('reports read:true with the records on a successful read', async () => {
    await recordFiledProposal({ appId: 'app-1', slug: 'add-metrics', tracker: 'github', issueRef: '#42' }, store);
    const res = await listOutcomesResult({ appId: 'app-1' }, store);
    expect(res.read).toBe(true);
    expect(res.outcomes).toHaveLength(1);
  });

  it('reports read:true with [] when the store is readable but this app filed nothing', async () => {
    // "Nothing filed" is a real, trustworthy answer — distinct from a failed read.
    expect(await listOutcomesResult({ appId: 'app-1' }, store)).toEqual({ read: true, outcomes: [] });
  });

  it('reports read:false when the store read throws — never a fabricated empty history', async () => {
    const broken = { loadAll: () => Promise.reject(new Error('disk on fire')), deleteOne: () => Promise.resolve() };
    expect(await listOutcomesResult({ appId: 'app-1' }, broken)).toEqual({ read: false, outcomes: [] });
  });

  it('reports read:false when the store returns a non-array', async () => {
    const broken = { loadAll: () => Promise.resolve(null), deleteOne: () => Promise.resolve() };
    expect(await listOutcomesResult({ appId: 'app-1' }, broken)).toEqual({ read: false, outcomes: [] });
  });

  it('treats a missing appId as an empty successful read, not a store failure', async () => {
    expect(await listOutcomesResult({}, store)).toEqual({ read: true, outcomes: [] });
  });

  it('listOutcomes still flattens to the bare array for back-compat', async () => {
    await recordFiledProposal({ appId: 'app-1', slug: 'add-metrics', tracker: 'github', issueRef: '#42' }, store);
    expect(await listOutcomes({ appId: 'app-1' }, store)).toHaveLength(1);
    const broken = { loadAll: () => Promise.reject(new Error('nope')), deleteOne: () => Promise.resolve() };
    expect(await listOutcomes({ appId: 'app-1' }, broken)).toEqual([]);
  });
});
