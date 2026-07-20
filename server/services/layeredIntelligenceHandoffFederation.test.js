/**
 * Cross-peer LI hand-off execution federation (#2779).
 *
 * A CoS LI hand-off task filed on peer A can be claimed and executed on peer B
 * (#1712/#1714). #2765 records the execution outcome (`recordProposalExecution`)
 * only into whichever peer RAN the agent, and the `li-outcomes` collection is NOT
 * federated — so the originating peer A never learned. Option 2 (the chosen
 * approach) routes the verdict via the already-federated task: the executing peer
 * stamps a small verdict into the terminal task's metadata (`buildLiExecutionVerdict`
 * → `LI_EXECUTION_VERDICT_KEY`), and when that terminal state syncs back A derives
 * `recordProposalExecution` from it (`recordProposalExecutionFromVerdict`, driven by
 * cosTaskStore.mergePeerTasks — covered in cosTaskStore.test.js).
 *
 * These tests cover the two pure/injectable seams of that route end to end:
 *   1. `buildLiExecutionVerdict` — the executing peer's stamp (parity with the local
 *      write: validation-authoritative outcome + the #2618 environmental gate).
 *   2. `recordProposalExecutionFromVerdict` — the originating peer's derive, scoped by
 *      `requireExisting` to a proposal THIS peer filed, feeding
 *      `computeProposalExecutionAwareness` after the sync.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCollectionStore } from '../lib/collectionStore.js';
import { buildLiExecutionVerdict } from './taskLearning/metrics.js';
import {
  sanitizeOutcomeRecord,
  recordFiledProposal,
  recordProposalExecution,
  recordProposalExecutionFromVerdict,
  listOutcomes,
  LI_OUTCOMES_SCHEMA_VERSION,
  LI_EXECUTION_VERDICT_KEY
} from './layeredIntelligenceOutcomes.js';
import { computeExecutionByDomain, computeProposalExecutionAwareness } from './layeredIntelligence.js';

// Isolated store over a temp dir — never touches the real data/cos/li-outcomes.
let dir;
let store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'li-handoff-fed-'));
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

describe('buildLiExecutionVerdict (#2779) — the executing peer stamp', () => {
  const proposal = { appId: 'app-x', slug: 'Add Metrics', scope: 'refactor' };

  it('returns null for a non-hand-off task (no liProposal)', () => {
    expect(buildLiExecutionVerdict({ liProposal: null, success: true })).toBeNull();
    expect(buildLiExecutionVerdict({ success: true })).toBeNull();
    expect(buildLiExecutionVerdict({ liProposal: [], success: true })).toBeNull();
  });

  it('returns null when the proposal is missing its (appId, slug) identity', () => {
    expect(buildLiExecutionVerdict({ liProposal: { appId: 'a' }, success: true })).toBeNull();
    expect(buildLiExecutionVerdict({ liProposal: { slug: 's' }, success: true })).toBeNull();
  });

  it('carries the proposal identity + domain, a clean-exit success, and the execution time', () => {
    const v = buildLiExecutionVerdict({ liProposal: proposal, success: true, executedAt: '2026-07-20T10:00:00.000Z' });
    expect(v).toEqual({
      appId: 'app-x',
      slug: 'Add Metrics',
      scope: 'refactor',
      success: true,
      errorCategory: null,
      validationPassed: null,
      executedAt: '2026-07-20T10:00:00.000Z'
    });
  });

  it('defaults executedAt to a timestamp when the caller omits it', () => {
    const v = buildLiExecutionVerdict({ liProposal: proposal, success: true });
    expect(typeof v.executedAt).toBe('string');
    expect(Number.isFinite(Date.parse(v.executedAt))).toBe(true);
  });

  it('is validation-authoritative — a declared verdict overrides the exit code (#2344)', () => {
    // commit-found run: raw exit-code success=false but the criterion passed.
    const passed = buildLiExecutionVerdict({ liProposal: proposal, success: false, validationPassed: true });
    expect(passed.success).toBe(true);
    expect(passed.validationPassed).toBe(true);
    // clean exit that missed its declared criterion → a failure.
    const missed = buildLiExecutionVerdict({ liProposal: proposal, success: true, validationPassed: false });
    expect(missed.success).toBe(false);
  });

  it('applies the environmental gate (#2618) — a rate-limit says nothing about the domain', () => {
    const v = buildLiExecutionVerdict({
      liProposal: proposal,
      success: false,
      errorAnalysis: { category: 'rate-limit', origin: 'provider' }
    });
    expect(v).toBeNull();
  });

  it('records a genuine (non-environmental) failure with its error category', () => {
    const v = buildLiExecutionVerdict({
      liProposal: proposal,
      success: false,
      errorAnalysis: { category: 'test-failure', origin: 'runner' }
    });
    expect(v.success).toBe(false);
    expect(v.errorCategory).toBe('test-failure');
  });

  it('does not divert an output-scan false positive (parity with the local write, #2642)', () => {
    // An environmental category derived only from the output-text regex sweep is NOT
    // diverted — it may be a false positive, so it still counts as a real failure.
    const v = buildLiExecutionVerdict({
      liProposal: proposal,
      success: false,
      errorAnalysis: { category: 'rate-limit', origin: 'output-scan' }
    });
    expect(v).not.toBeNull();
    expect(v.success).toBe(false);
  });
});

describe('recordProposalExecution requireExisting (#2779)', () => {
  it('is a no-op on a peer that never filed the proposal (no minimal record minted)', async () => {
    const ok = await recordProposalExecution(
      { appId: 'app-x', slug: 'add-metrics', scope: 'refactor', success: true, requireExisting: true },
      store
    );
    expect(ok).toBe(false);
    expect(await listOutcomes({ appId: 'app-x' }, store)).toEqual([]);
  });

  it('updates the existing FILED record on the originating peer', async () => {
    await recordFiledProposal({ appId: 'app-x', slug: 'add-metrics', scope: 'refactor' }, store);
    const ok = await recordProposalExecution(
      { appId: 'app-x', slug: 'add-metrics', success: true, requireExisting: true },
      store
    );
    expect(ok).toBe(true);
    const [rec] = await listOutcomes({ appId: 'app-x' }, store);
    expect(rec.executionOutcome).toBe('success');
    expect(rec.scope).toBe('refactor'); // filed scope preserved
  });

  it('still mints a minimal record when requireExisting is not set (local #2765 path)', async () => {
    const ok = await recordProposalExecution(
      { appId: 'app-x', slug: 'add-metrics', scope: 'refactor', success: false },
      store
    );
    expect(ok).toBe(true);
    const [rec] = await listOutcomes({ appId: 'app-x' }, store);
    expect(rec.executionOutcome).toBe('failure');
  });
});

describe('recordProposalExecutionFromVerdict (#2779) — the originating peer derive', () => {
  it('drops a malformed / foreign verdict without writing', async () => {
    expect(await recordProposalExecutionFromVerdict(null, store)).toBe(false);
    expect(await recordProposalExecutionFromVerdict({ appId: 'a', slug: 's' }, store)).toBe(false); // no boolean success
    expect(await listOutcomes({ appId: 'a' }, store)).toEqual([]);
  });

  it('only records for a proposal THIS peer filed (requireExisting)', async () => {
    // Peer C adopted the terminal task but never filed the proposal → no record.
    const verdict = { appId: 'app-x', slug: 'add-metrics', scope: 'refactor', success: true };
    expect(await recordProposalExecutionFromVerdict(verdict, store)).toBe(false);
    expect(await listOutcomes({ appId: 'app-x' }, store)).toEqual([]);
  });

  it("reflects a peer-B execution in A's computeProposalExecutionAwareness after a sync", async () => {
    // Peer A filed three proposals in the same domain (min-sample for awareness).
    for (const slug of ['add-metrics', 'trim-logs', 'split-store']) {
      await recordFiledProposal({ appId: 'app-x', slug, scope: 'refactor' }, store);
    }
    // Peer B executed each hand-off and stamped a verdict onto the terminal task; A
    // derives each from the synced terminal task via the consumer.
    for (const slug of ['add-metrics', 'trim-logs', 'split-store']) {
      const verdict = buildLiExecutionVerdict({
        liProposal: { appId: 'app-x', slug, scope: 'refactor' },
        success: true
      });
      // Sanity: this is exactly what the wire metadata key carries.
      expect(LI_EXECUTION_VERDICT_KEY).toBe('liExecution');
      expect(await recordProposalExecutionFromVerdict(verdict, store)).toBe(true);
    }

    const outcomes = await listOutcomes({ appId: 'app-x' }, store);
    const byDomain = computeExecutionByDomain(outcomes);
    expect(byDomain.refactor.completed).toBe(3);
    expect(byDomain.refactor.succeeded).toBe(3);
    expect(byDomain.refactor.successRate).toBe(100);

    // The per-domain execution now surfaces in the reasoner-facing awareness text —
    // proof the cross-peer execution reached A's computeProposalExecutionAwareness.
    const awareness = computeProposalExecutionAwareness({ outcomes });
    expect(awareness).toContain('refactor');
  });

  it('is a durable no-op when the same verdict re-syncs (idempotency, codex P2)', async () => {
    await recordFiledProposal({ appId: 'app-x', slug: 'add-metrics', scope: 'refactor' }, store);
    const verdict = { appId: 'app-x', slug: 'add-metrics', scope: 'refactor', success: true, executedAt: '2026-07-20T10:00:00.000Z' };
    expect(await recordProposalExecutionFromVerdict(verdict, store)).toBe(true);
    const [first] = await listOutcomes({ appId: 'app-x' }, store);
    expect(first.executionOutcome).toBe('success');
    // Re-offering the identical verdict (the merge re-scans terminal tasks every sweep) does
    // NOT rewrite — the stored execution is not older than the incoming one.
    expect(await recordProposalExecutionFromVerdict(verdict, store)).toBe(false);
    const [again] = await listOutcomes({ appId: 'app-x' }, store);
    expect(again.executionAt).toBe(first.executionAt); // unchanged, no churn
  });

  it('overwrites with a genuinely NEWER (re-executed) verdict — latest wins (parity)', async () => {
    await recordFiledProposal({ appId: 'app-x', slug: 'add-metrics', scope: 'refactor' }, store);
    // First hand-off failed on a peer.
    expect(await recordProposalExecutionFromVerdict(
      { appId: 'app-x', slug: 'add-metrics', scope: 'refactor', success: false, errorCategory: 'test-failure', executedAt: '2026-07-20T10:00:00.000Z' },
      store
    )).toBe(true);
    expect((await listOutcomes({ appId: 'app-x' }, store))[0].executionOutcome).toBe('failure');
    // Re-executed later and passed — a newer executedAt overwrites the stale failure.
    expect(await recordProposalExecutionFromVerdict(
      { appId: 'app-x', slug: 'add-metrics', scope: 'refactor', success: true, executedAt: '2026-07-20T12:00:00.000Z' },
      store
    )).toBe(true);
    expect((await listOutcomes({ appId: 'app-x' }, store))[0].executionOutcome).toBe('success');
  });

  it('records a cross-peer FAILURE so a failing domain surfaces to A', async () => {
    await recordFiledProposal({ appId: 'app-x', slug: 'flaky-thing', scope: 'testing' }, store);
    const verdict = buildLiExecutionVerdict({
      liProposal: { appId: 'app-x', slug: 'flaky-thing', scope: 'testing' },
      success: false,
      errorAnalysis: { category: 'test-failure', origin: 'runner' }
    });
    expect(await recordProposalExecutionFromVerdict(verdict, store)).toBe(true);
    const [rec] = await listOutcomes({ appId: 'app-x' }, store);
    expect(rec.executionOutcome).toBe('failure');
    expect(rec.scope).toBe('testing');
  });
});
