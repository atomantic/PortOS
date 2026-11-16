import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeDeliveryMetrics,
} from './outcomes.js';
import {
  renderCosMetricsSource,
  renderChurnSignals,
  COS_METRICS_MAX_CHARS,
  gatherSources,
} from './sources.js';
import {
  SCOPE_AWARENESS_MAX_PER_LIST,
} from './constants.js';

describe('renderCosMetricsSource (#3085)', () => {
  const BY_TYPE = { 'user-task': { lifetimeSuccessRate: 92, lifetimeCompleted: 25 } };

  it('leaves the per-task-type document unchanged when no delivery data was gathered', () => {
    // Outcomes source off / tracker can't report outcomes / store unreadable: OMIT the
    // block rather than emit zeros, which would read as "nothing has ever been approved".
    const parsed = JSON.parse(renderCosMetricsSource({ metricsByType: BY_TYPE }));
    expect(parsed).toEqual(BY_TYPE);
    expect(parsed.delivery).toBeUndefined();
  });

  it('renders delivery alone when the install has no CoS run history yet', () => {
    // The two halves are independently optional: an install with no learning.json can
    // still have approved-but-undelivered proposals, and that is exactly the signal
    // that arms the exclusion gate — it must not be withheld for lack of run stats.
    const parsed = JSON.parse(renderCosMetricsSource({
      metricsByType: {},
      delivery: computeDeliveryMetrics([{ scope: 'loop-meta', outcome: 'merged', executionOutcome: null, filedAt: '2026-07-01T00:00:00.000Z' }])
    }));
    expect(parsed.delivery).toEqual({ totalApproved: 1, totalDelivered: 0, currentDeliveryRate: 0 });
  });

  it('returns an empty string when both halves are empty so the source is omitted', () => {
    // A hollow `{}` block would tell the reasoner nothing while costing prompt budget.
    expect(renderCosMetricsSource()).toBe('');
    expect(renderCosMetricsSource({ metricsByType: {}, delivery: null })).toBe('');
  });

  it('folds delivery into the same document as the run rates', () => {
    const delivery = computeDeliveryMetrics([
      { scope: 'app-improvement', outcome: 'merged', executionOutcome: 'success', filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T01:00:00.000Z' }
    ]);
    const parsed = JSON.parse(renderCosMetricsSource({ metricsByType: BY_TYPE, delivery }));
    expect(parsed['user-task'].lifetimeSuccessRate).toBe(92);
    expect(parsed.delivery).toEqual({ totalApproved: 1, totalDelivered: 1, currentDeliveryRate: 100 });
    expect(parsed.deliveryByScope).toEqual({ 'app-improvement': { approved: 1, delivered: 1 } });
  });

  it('keeps the delivery block ahead of the per-type map so the cap cannot cut it', () => {
    // An install with dozens of task types can fill COS_METRICS_MAX_CHARS on its own.
    // The per-type tail has an interpreted sibling in the prompt (liScopeAwareness,
    // derived from the untruncated map); the delivery block has none, so it must survive.
    const metricsByType = {};
    for (let i = 0; i < 200; i++) {
      metricsByType[`self-improve:scope-${i}`] = { lifetimeSuccessRate: 50, lifetimeCompleted: 10, recentSuccessRate: null, recentCompleted: 0, avgDurationMs: 1000 };
    }
    const rendered = renderCosMetricsSource({
      metricsByType,
      delivery: computeDeliveryMetrics([{ scope: 'loop-meta', outcome: 'merged', executionOutcome: null, filedAt: '2026-07-01T00:00:00.000Z' }])
    });
    expect(rendered.length).toBe(COS_METRICS_MAX_CHARS); // genuinely truncated
    expect(rendered).toContain('"currentDeliveryRate":0');
    expect(rendered.indexOf('"delivery"')).toBeLessThan(rendered.indexOf('self-improve:scope-0'));
  });

  it('does not let a task type named "delivery" shadow the delivery block', () => {
    const parsed = JSON.parse(renderCosMetricsSource({
      metricsByType: { delivery: { lifetimeSuccessRate: 10 } },
      delivery: computeDeliveryMetrics([{ scope: 'loop-meta', outcome: 'merged', executionOutcome: 'success', filedAt: '2026-07-01T00:00:00.000Z', executionAt: '2026-07-01T01:00:00.000Z' }])
    }));
    expect(parsed.delivery).toEqual({ totalApproved: 1, totalDelivered: 1, currentDeliveryRate: 100 });
  });
});

describe('gatherSources cosMetrics windowed rate (issue #2460)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lil-cosmetrics-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const writeLearning = (learning) => writeFile(join(dir, 'learning.json'), JSON.stringify(learning));

  it('surfaces a recency-windowed rate distinct from the lifetime rate', async () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // Lifetime rate is dragged down by an old failure burst; the recent ring is
    // all successes → windowed rate should read high while lifetime reads low.
    await writeLearning({
      byTaskType: {
        'self-improve:ui': {
          completed: 12, succeeded: 2, failed: 10, successRate: 17, avgDurationMs: 1000,
          recentOutcomes: [
            { t: new Date(now - 40 * DAY).toISOString(), s: false }, // aged out of the 30d window
            { t: new Date(now - 2 * DAY).toISOString(), s: true },
            { t: new Date(now - 1 * DAY).toISOString(), s: true }
          ]
        }
      }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir });
    const parsed = JSON.parse(out.cosMetrics);
    expect(parsed['self-improve:ui'].lifetimeSuccessRate).toBe(17);
    expect(parsed['self-improve:ui'].lifetimeCompleted).toBe(12);
    expect(parsed['self-improve:ui'].recentSuccessRate).toBe(100);
    expect(parsed['self-improve:ui'].recentCompleted).toBe(2);
  });

  it('reports a null recentSuccessRate (not 0) when the ring is empty so LI leans on lifetime', async () => {
    await writeLearning({
      byTaskType: {
        'idle-review': { completed: 5, succeeded: 5, failed: 0, successRate: 100, recentOutcomes: [] }
      }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir });
    const parsed = JSON.parse(out.cosMetrics);
    expect(parsed['idle-review'].recentSuccessRate).toBeNull();
    expect(parsed['idle-review'].lifetimeSuccessRate).toBe(100);
  });

  it('tolerates a pre-migration bucket with no recentOutcomes key', async () => {
    await writeLearning({
      byTaskType: { 'auto-fix': { completed: 3, succeeded: 1, failed: 2, successRate: 33 } }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir });
    const parsed = JSON.parse(out.cosMetrics);
    expect(parsed['auto-fix'].recentSuccessRate).toBeNull();
    expect(parsed['auto-fix'].lifetimeSuccessRate).toBe(33);
  });

  it('does not read learning.json when cosMetrics is off', async () => {
    await writeLearning({ byTaskType: { x: { successRate: 50, recentOutcomes: [] } } });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: false } }, { cosPath: dir });
    expect(out.cosMetrics).toBeUndefined();
  });

  it('emits scopeGuidance derived from the same per-type rates on PortOS (#2760)', async () => {
    await writeLearning({
      byTaskType: {
        'self-improve:layered-intelligence': { completed: 9, succeeded: 0, failed: 9, successRate: 0, recentOutcomes: [] },
        'plan-task': { completed: 10, succeeded: 10, failed: 0, successRate: 100, recentOutcomes: [] },
        'feature-ideas': { completed: 8, succeeded: 5, failed: 3, successRate: 63, recentOutcomes: [] } // mid-band → neither
      }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir, isPortos: true });
    expect(out.scopeGuidance).toContain('LOW-COMPLETION');
    expect(out.scopeGuidance).toContain('self-improve:layered-intelligence: 0% completed over 9 runs');
    expect(out.scopeGuidance).toContain('HIGH-COMPLETION');
    expect(out.scopeGuidance).toContain('plan-task: 100% completed over 10 runs');
    expect(out.scopeGuidance).not.toContain('feature-ideas');
  });

  it('omits scopeGuidance when no scope clears the sample floor (#2760)', async () => {
    await writeLearning({
      byTaskType: { 'plan-task': { completed: 2, succeeded: 2, failed: 0, successRate: 100, recentOutcomes: [] } }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir, isPortos: true });
    expect(out.cosMetrics).toBeDefined(); // raw metrics still surfaced
    expect(out.scopeGuidance).toBeUndefined();
  });

  it('does NOT emit scopeGuidance for a managed app even when it enabled cosMetrics (#2760 codex P2)', async () => {
    // These completion rates are the install's own CoS history — irrelevant to a
    // managed app — so the derivation is gated on isPortos, not just the cosMetrics
    // toggle (which a managed app CAN turn on). cosMetrics itself is still surfaced.
    await writeLearning({
      byTaskType: { 'plan-task': { completed: 10, succeeded: 0, failed: 10, successRate: 0, recentOutcomes: [] } }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir, isPortos: false });
    expect(out.cosMetrics).toBeDefined();
    expect(out.scopeGuidance).toBeUndefined();
  });

  it('caps the number of task types per list and notes the overflow (#2760 codex P2)', async () => {
    // Overflow the cap by 3 chronically-failing types (all past the sample floor) → the
    // block must cap at SCOPE_AWARENESS_MAX_PER_LIST and note the remainder, not dump all.
    const overflow = 3;
    const total = SCOPE_AWARENESS_MAX_PER_LIST + overflow;
    const byTaskType = {};
    for (let i = 0; i < total; i++) {
      byTaskType[`self-improve:fail-scope-${i}`] = { completed: 5, succeeded: 0, failed: 5, successRate: 0, recentOutcomes: [] };
    }
    await writeLearning({ byTaskType });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir, isPortos: true });
    const listedTypes = (out.scopeGuidance.match(/self-improve:fail-scope-\d+/g) || []).length;
    expect(listedTypes).toBe(SCOPE_AWARENESS_MAX_PER_LIST);
    expect(out.scopeGuidance).toContain(`and ${overflow} more`);
  });

  it('hands the raw per-type map back for the delivery re-render, with no delivery block yet (#3085)', async () => {
    // gatherSources runs BEFORE outcomes are reconciled against this run's tracker read,
    // so it cannot know the approval count yet — emitting one here would let the
    // cosMetrics and liOutcomes blocks in the SAME prompt disagree. The hook re-renders
    // with `cosMetricsByType` once it has post-reconciliation records.
    await writeLearning({
      byTaskType: { 'user-task': { completed: 10, succeeded: 9, failed: 1, successRate: 90, recentOutcomes: [] } }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir });
    expect(out.cosMetricsByType['user-task'].lifetimeSuccessRate).toBe(90);
    expect(JSON.parse(out.cosMetrics).delivery).toBeUndefined();
  });

  it('still hands off an empty per-type map when learning.json is missing, so delivery can render (#3085)', async () => {
    // No learning.json at all: the source used to be skipped outright, which would have
    // withheld the delivery half too — and that half comes from the outcome records, not
    // from here. Hand back an empty map so the hook can still render delivery; the
    // rendered document stays omitted while BOTH halves are empty.
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir });
    expect(out.cosMetricsByType).toEqual({});
    expect(out.cosMetrics).toBeUndefined();
  });

  it('harvests 24h short-lived run counts next to the lifetime duration', async () => {
    const now = Date.now();
    await writeLearning({
      byTaskType: {
        'self-improve:branch-reconcile': {
          completed: 24, succeeded: 24, failed: 0, successRate: 100, avgDurationMs: 90_000,
          recentOutcomes: Array.from({ length: 12 }, (_, i) => ({
            t: new Date(now - i * 10 * 60 * 1000).toISOString(),
            s: true,
            d: 80_000
          }))
        }
      }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir });
    const parsed = JSON.parse(out.cosMetrics);
    expect(parsed['self-improve:branch-reconcile'].recent24hCompleted).toBe(12);
    expect(parsed['self-improve:branch-reconcile'].recent24hShortLived).toBe(12);
    expect(parsed['self-improve:branch-reconcile'].recent24hMedianDurationMs).toBe(80_000);
  });

  it('surfaces an active churn signal to PortOS LI as local evidence, not tracker work', async () => {
    const now = Date.now();
    await writeLearning({
      byTaskType: {
        'self-improve:branch-reconcile': {
          completed: 12, succeeded: 12, failed: 0, successRate: 100, avgDurationMs: 80_000,
          recentOutcomes: Array.from({ length: 12 }, (_, i) => ({
            t: new Date(now - i * 10 * 60 * 1000).toISOString(),
            s: true,
            d: 80_000
          }))
        }
      }
    });
    const portos = await gatherSources(
      { repoPath: dir },
      { sources: { cosMetrics: true } },
      { cosPath: dir, isPortos: true }
    );
    const parsed = JSON.parse(portos.cosMetrics);
    expect(parsed['self-improve:branch-reconcile'].churn).toMatchObject({
      signal: 'short-lived-burst',
      windowCompleted: 12,
      shortLivedCount: 12,
      shortLivedSampleSize: 12
    });
    expect(portos.churnSignals).toContain('Instance-local CoS churn signals');
    expect(portos.churnSignals).toContain('concrete planned fix');

    const managed = await gatherSources(
      { repoPath: dir },
      { sources: { cosMetrics: true } },
      { cosPath: dir, isPortos: false }
    );
    expect(managed.churnSignals).toBeUndefined();
    expect(JSON.parse(managed.cosMetrics)['self-improve:branch-reconcile'].churn).toBeUndefined();
  });

  it('renders only active churn entries and caps the signal list', () => {
    const rendered = renderChurnSignals({
      calm: { lifetimeCompleted: 2 },
      noisy: { churn: { signal: 'short-lived-burst', windowCompleted: 8, windowMs: 1000, shortLivedCount: 8, shortLivedSampleSize: 8, medianDurationMs: 20, medianGapMs: 30 } },
      noisy2: { churn: { signal: 'rapid-succession', windowCompleted: 9, windowMs: 1000, shortLivedCount: 0, shortLivedSampleSize: 0, medianDurationMs: null, medianGapMs: 30 } }
    }, { maxItems: 1 });
    expect(rendered).toContain('noisy');
    expect(rendered).not.toContain('noisy2');
    expect(rendered).not.toContain('calm');
    expect(rendered).toContain('additional churn signal(s) omitted');
  });

  it('does not emit scopeGuidance when cosMetrics is off (#2760)', async () => {
    await writeLearning({
      byTaskType: { 'accessibility': { completed: 4, succeeded: 0, failed: 4, successRate: 0, recentOutcomes: [] } }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: false } }, { cosPath: dir, isPortos: true });
    expect(out.scopeGuidance).toBeUndefined();
  });
});
