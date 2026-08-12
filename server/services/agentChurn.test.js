import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CHURN_WINDOW_MS,
  CHURN_MIN_RUNS,
  CHURN_SLUG_PREFIX,
  summarizeRecentRuns,
  computeChurn,
  buildChurnIssueTitle,
  buildChurnIssueBody,
  shouldFileChurnAlert,
  findOpenChurnIssue,
  fileChurnIssue,
  observeAgentChurn,
  alertsPath
} from './agentChurn.js';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function ring({ n, now, durationMs = 90_000, gapMs = 10 * MIN, withDuration = true }) {
  return Array.from({ length: n }, (_, i) => {
    const sample = {
      t: new Date(now - (n - 1 - i) * gapMs).toISOString(),
      s: true
    };
    if (withDuration) sample.d = durationMs;
    return sample;
  });
}

describe('summarizeRecentRuns / computeChurn', () => {
  const now = Date.parse('2026-08-12T08:00:00.000Z');

  it('flags the last-night shape: many short-lived completions of the same task', () => {
    const recentOutcomes = ring({ n: 24, now, durationMs: 90_000, gapMs: 8 * MIN });
    const churn = computeChurn(recentOutcomes, { now });
    expect(churn.flagged).toBe(true);
    expect(churn.reason).toBe('short-lived-burst');
    expect(churn.windowCompleted).toBe(24);
    expect(churn.shortLivedCount).toBe(24);
    expect(churn.medianDurationMs).toBe(90_000);
  });

  it('flags a pre-instrumentation burst from completion spacing alone', () => {
    const recentOutcomes = ring({ n: 12, now, withDuration: false, gapMs: 10 * MIN });
    const churn = computeChurn(recentOutcomes, { now });
    expect(churn.flagged).toBe(true);
    expect(churn.reason).toBe('rapid-succession');
    expect(churn.shortLivedRatio).toBeNull();
    expect(churn.medianGapMs).toBe(10 * MIN);
  });

  it('does not flag a healthy drain of a few long runs', () => {
    const recentOutcomes = ring({ n: 3, now, durationMs: 25 * MIN, gapMs: 40 * MIN });
    expect(computeChurn(recentOutcomes, { now }).flagged).toBe(false);
  });

  it('does not flag many long runs (real work finishing, just busy)', () => {
    const recentOutcomes = ring({ n: 10, now, durationMs: 20 * MIN, gapMs: 30 * MIN });
    const churn = computeChurn(recentOutcomes, { now });
    expect(churn.flagged).toBe(false);
    expect(churn.windowCompleted).toBe(10);
    expect(churn.shortLivedRatio).toBe(0);
  });

  it('does not flag a thin window below the run-count floor', () => {
    const recentOutcomes = ring({ n: CHURN_MIN_RUNS - 1, now, durationMs: 30_000, gapMs: 5 * MIN });
    expect(computeChurn(recentOutcomes, { now }).flagged).toBe(false);
  });

  it('drops samples outside the burst window', () => {
    const recentOutcomes = [
      ...ring({ n: 20, now: now - CHURN_WINDOW_MS - HOUR, durationMs: 30_000, gapMs: 5 * MIN }),
      ...ring({ n: 2, now, durationMs: 30_000, gapMs: 5 * MIN })
    ];
    const stats = summarizeRecentRuns(recentOutcomes, { now });
    expect(stats.windowCompleted).toBe(2);
    expect(computeChurn(recentOutcomes, { now }).flagged).toBe(false);
  });

  it('treats an empty / missing ring as not-churning, with null duration sentinels', () => {
    const empty = computeChurn([], { now });
    expect(empty.flagged).toBe(false);
    expect(empty.medianDurationMs).toBeNull();
    expect(empty.shortLivedRatio).toBeNull();
    expect(computeChurn(undefined, { now }).flagged).toBe(false);
  });
});

describe('churn issue copy', () => {
  it('uses a stable title keyed on the task type', () => {
    expect(buildChurnIssueTitle('self-improve:branch-reconcile'))
      .toBe('CoS churn: self-improve:branch-reconcile is looping on short-lived executions');
  });

  it('embeds the slug marker and no live-instance data', () => {
    const body = buildChurnIssueBody({
      taskType: 'self-improve:branch-reconcile',
      churn: {
        reason: 'short-lived-burst',
        windowCompleted: 24,
        windowMs: CHURN_WINDOW_MS,
        shortLivedCount: 24,
        shortLivedSampleSize: 24,
        medianDurationMs: 90_000,
        medianGapMs: 8 * MIN
      },
      signatureRepeatCount: 4,
      generatedAt: '2026-08-12T08:00:00.000Z'
    });
    expect(body).toContain(`<!-- lil-slug: ${CHURN_SLUG_PREFIX}:self-improve:branch-reconcile -->`);
    expect(body).toContain('short-lived-burst');
    expect(body).toContain('24');
    expect(body).toContain('**Same-finding park count:** 4');
    expect(body).not.toMatch(/\/Users\//);
    expect(body).not.toMatch(/origin\//);
  });

  // The durations are rendered by `formatDurationShort`, which agentChurn shares
  // with selfDiagnostics. Pin the rendered strings here so a diagnostics-motivated
  // tweak to that formatter can't silently reword the auto-filed churn issue.
  it('renders the durations through the shared short-duration formatter', () => {
    const body = buildChurnIssueBody({
      taskType: 'self-improve:branch-reconcile',
      churn: {
        reason: 'short-lived-burst',
        windowCompleted: 24,
        windowMs: CHURN_WINDOW_MS,
        shortLivedCount: 24,
        shortLivedSampleSize: 24,
        medianDurationMs: 90_000,
        medianGapMs: 8 * MIN
      },
      generatedAt: '2026-08-12T08:00:00.000Z'
    });
    expect(body).toContain('**Short-lived (< 5m):** 24 of 24 timed runs');
    expect(body).toContain('**Median duration:** 1m 30s');
    expect(body).toContain('**Median gap between completions:** 8m');
  });

  it('renders absent durations as the em-dash sentinel', () => {
    const body = buildChurnIssueBody({
      taskType: 'self-improve:branch-reconcile',
      churn: {
        reason: 'rapid-succession',
        windowCompleted: 12,
        windowMs: CHURN_WINDOW_MS,
        shortLivedCount: 0,
        shortLivedSampleSize: 0,
        medianDurationMs: null,
        medianGapMs: null
      },
      generatedAt: '2026-08-12T08:00:00.000Z'
    });
    expect(body).toContain('**Median duration:** —');
    expect(body).toContain('**Median gap between completions:** —');
    expect(body).toContain('(no per-run duration recorded — used completion spacing)');
  });
});

describe('shouldFileChurnAlert', () => {
  const now = Date.parse('2026-08-12T08:00:00.000Z');

  it('files when nothing has been recorded for the type', () => {
    expect(shouldFileChurnAlert({ byTaskType: {} }, 'self-improve:branch-reconcile', { now })).toBe(true);
  });

  it('suppresses a re-file inside the cooldown', () => {
    expect(shouldFileChurnAlert({
      byTaskType: { 'self-improve:branch-reconcile': { filedAt: '2026-08-11T08:00:00.000Z' } }
    }, 'self-improve:branch-reconcile', { now })).toBe(false);
  });

  it('re-files after the cooldown elapses', () => {
    expect(shouldFileChurnAlert({
      byTaskType: { 'self-improve:branch-reconcile': { filedAt: '2026-08-01T08:00:00.000Z' } }
    }, 'self-improve:branch-reconcile', { now })).toBe(true);
  });
});

describe('fileChurnIssue', () => {
  it('creates when no open issue exists', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: '[]' })
      .mockResolvedValueOnce({ code: 0, stdout: 'https://github.com/example/PortOS/issues/42\n', stderr: '' });
    const result = await fileChurnIssue({
      taskType: 'self-improve:branch-reconcile',
      churn: { reason: 'short-lived-burst', windowCompleted: 12, windowMs: CHURN_WINDOW_MS, shortLivedCount: 12, shortLivedSampleSize: 12 },
      exec,
      now: () => '2026-08-12T08:00:00.000Z'
    });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.issue.number).toBe(42);
    expect(exec.mock.calls[1][0]).toBe('gh');
    expect(exec.mock.calls[1][1][0]).toBe('issue');
    expect(exec.mock.calls[1][1][1]).toBe('create');
  });

  it('edits an existing open issue instead of creating a duplicate', async () => {
    const existing = [{
      number: 7,
      title: buildChurnIssueTitle('self-improve:branch-reconcile'),
      body: `old\n<!-- lil-slug: ${CHURN_SLUG_PREFIX}:self-improve:branch-reconcile -->`,
      url: 'https://github.com/example/PortOS/issues/7'
    }];
    const exec = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(existing) })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const result = await fileChurnIssue({
      taskType: 'self-improve:branch-reconcile',
      churn: { reason: 'short-lived-burst', windowCompleted: 20, windowMs: CHURN_WINDOW_MS, shortLivedCount: 18, shortLivedSampleSize: 20 },
      exec
    });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(false);
    expect(result.issue.number).toBe(7);
    expect(exec.mock.calls[1][1]).toEqual(['issue', 'edit', '7', '--body', expect.any(String)]);
  });

  it('refuses to create when the open-issue list fails', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'gh: auth' });
    const result = await fileChurnIssue({
      taskType: 'self-improve:branch-reconcile',
      churn: { reason: 'short-lived-burst', windowCompleted: 12, windowMs: CHURN_WINDOW_MS },
      exec
    });
    expect(result).toEqual({ ok: false, issue: null, reason: 'list-failed' });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('findOpenChurnIssue', () => {
  it('returns ok:false when gh fails so a caller will not create a duplicate', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '' });
    await expect(findOpenChurnIssue('self-improve:branch-reconcile', { exec }))
      .resolves.toEqual({ ok: false, issue: null });
  });
});

describe('observeAgentChurn', () => {
  let dir;
  const now = Date.parse('2026-08-12T08:00:00.000Z');

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cos-churn-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const burstRing = ring({ n: 20, now, durationMs: 80_000, gapMs: 8 * MIN });

  it('no-ops when the type is not churning', async () => {
    const park = vi.fn();
    const exec = vi.fn();
    const out = await observeAgentChurn(
      { result: { duration: 20 * MIN } },
      { metadata: { analysisType: 'branch-reconcile', app: 'app-1' } },
      {
        loadLearning: async () => ({ byTaskType: { 'self-improve:branch-reconcile': { recentOutcomes: ring({ n: 2, now, durationMs: 20 * MIN }) } } }),
        now: () => now,
        park,
        exec,
        cosDir: dir,
        forgeGate: async () => ({ ok: true })
      }
    );
    expect(out.flagged).toBe(false);
    expect(park).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('parks a looping coordinator and files one issue (the last-night branch-reconcile case)', async () => {
    const park = vi.fn(async () => ({}));
    const exec = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: '[]' })
      .mockResolvedValueOnce({ code: 0, stdout: 'https://github.com/example/PortOS/issues/99\n', stderr: '' });
    const out = await observeAgentChurn(
      { result: { duration: 80_000 } },
      { metadata: { analysisType: 'branch-reconcile', app: 'app-1' } },
      {
        loadLearning: async () => ({ byTaskType: { 'self-improve:branch-reconcile': { recentOutcomes: burstRing } } }),
        now: () => now,
        park,
        exec,
        cosDir: dir,
        cwd: dir,
        forgeGate: async () => ({ ok: true }),
        readPark: async () => ({ signatureRepeatCount: 6 })
      }
    );
    expect(out.flagged).toBe(true);
    expect(out.filed).toBe(true);
    expect(out.created).toBe(true);
    expect(out.parked).toBe(true);
    expect(park).toHaveBeenCalledWith('branch-reconcile', 'app-1', {
      reason: 'churn-detected',
      actionableCount: 20
    });
    const createBody = exec.mock.calls[1][1][exec.mock.calls[1][1].indexOf('--body') + 1];
    expect(createBody).toContain('**Same-finding park count:** 6');
    const saved = JSON.parse(await readFile(alertsPath(dir), 'utf8'));
    expect(saved.byTaskType['self-improve:branch-reconcile'].issueNumber).toBe(99);
  });

  it('files but does not park a non-coordinator task type', async () => {
    const park = vi.fn();
    const exec = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: '[]' })
      .mockResolvedValueOnce({ code: 0, stdout: 'https://github.com/example/PortOS/issues/3\n', stderr: '' });
    const out = await observeAgentChurn(
      { result: { duration: 40_000 } },
      { metadata: { analysisType: 'claim-issue', app: 'app-1' } },
      {
        loadLearning: async () => ({ byTaskType: { 'self-improve:claim-issue': { recentOutcomes: burstRing } } }),
        now: () => now,
        park,
        exec,
        cosDir: dir,
        cwd: dir,
        forgeGate: async () => ({ ok: true })
      }
    );
    expect(out.flagged).toBe(true);
    expect(out.filed).toBe(true);
    expect(out.parked).toBe(false);
    expect(park).not.toHaveBeenCalled();
  });

  it('does not re-file inside the cooldown, but still parks a coordinator', async () => {
    const { writeFile, mkdir } = await import('fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(alertsPath(dir), JSON.stringify({
      byTaskType: { 'self-improve:branch-reconcile': { filedAt: new Date(now - HOUR).toISOString(), issueNumber: 1 } }
    }));
    const park = vi.fn(async () => ({}));
    const exec = vi.fn();
    const out = await observeAgentChurn(
      { result: { duration: 80_000 } },
      { metadata: { taskAnalysisType: 'branch-reconcile', taskApp: 'app-1' } },
      {
        loadLearning: async () => ({ byTaskType: { 'self-improve:branch-reconcile': { recentOutcomes: burstRing } } }),
        now: () => now,
        park,
        exec,
        cosDir: dir,
        forgeGate: async () => ({ ok: true })
      }
    );
    expect(out.flagged).toBe(true);
    expect(out.filed).toBe(false);
    expect(out.reason).toBe('cooldown');
    expect(out.parked).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('skips filing when the forge is unreachable', async () => {
    const park = vi.fn(async () => ({}));
    const exec = vi.fn();
    const out = await observeAgentChurn(
      { result: { duration: 80_000 } },
      { metadata: { analysisType: 'branch-reconcile', app: 'app-1' } },
      {
        loadLearning: async () => ({ byTaskType: { 'self-improve:branch-reconcile': { recentOutcomes: burstRing } } }),
        now: () => now,
        park,
        exec,
        cosDir: dir,
        forgeGate: async () => ({ ok: false, status: 'error' })
      }
    );
    expect(out.filed).toBe(false);
    expect(out.reason).toBe('forge-unavailable');
    expect(out.parked).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
});
