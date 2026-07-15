import { describe, it, expect, vi } from 'vitest'
import {
  computeFailingCategories,
  formatDurationShort,
  formatCategoryLogLine,
  buildDiagnosticsIssueTitle,
  buildDiagnosticsIssueBody,
  findMonitoringIssue,
  runSelfDiagnostics,
  MONITORING_LABEL,
  NEEDS_ATTENTION_LABEL,
  DIAGNOSTICS_SLUG
} from './selfDiagnostics.js'

// Deterministic clock shared by the windowed fixtures and the tests (#2617).
const NOW = Date.parse('2026-07-12T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

// A recent-outcomes ring ending at `endAt`, oldest first.
const ring = (results, { endAt = NOW, stepMs = 60000 } = {}) =>
  results.map((s, i) => ({ t: new Date(endAt - (results.length - i) * stepMs).toISOString(), s }))

// A sample byTaskType map mirroring the learning.json shape. Since #2617 the
// failing set comes from the recency-windowed `recentOutcomes` ring, NOT the
// lifetime counters — so each bucket carries both, and `self-improve:update`
// is the acceptance case: heavy lifetime failures but a clean recent window.
const sampleMetrics = {
  // Windowed: 4 failed / 12 (67%)
  'self-improve:claim-issue': {
    completed: 192, succeeded: 137, failed: 55, successRate: 71, lastCompleted: '2026-07-01T00:00:00.000Z', avgDurationMs: 160000, maxDurationMs: 900000,
    recentOutcomes: ring([true, false, true, true, false, true, true, false, true, true, false, true])
  },
  // Windowed: 2 failed / 3 (33%)
  'self-improve:console': {
    completed: 3, succeeded: 1, failed: 2, successRate: 33, lastCompleted: '2026-06-01T00:00:00.000Z', avgDurationMs: 40000, maxDurationMs: 60000,
    recentOutcomes: ring([false, true, false])
  },
  // Windowed: 6 failed / 20 (70%)
  'user-task': {
    completed: 1177, succeeded: 1002, failed: 175, successRate: 85, lastCompleted: '2026-07-02T00:00:00.000Z', avgDurationMs: 120000, maxDurationMs: 500000,
    recentOutcomes: ring([...Array(6).fill(false), ...Array(14).fill(true)])
  },
  // Lifetime-failed (55 failures during a since-fixed bug) but CLEAN recent
  // window → must drop off the monitoring issue (#2617 acceptance criterion).
  'self-improve:update': {
    completed: 100, succeeded: 45, failed: 55, successRate: 45, lastCompleted: '2026-07-10T00:00:00.000Z', avgDurationMs: 160000, maxDurationMs: 200000,
    recentOutcomes: ring(Array(6).fill(true))
  }
}

describe('computeFailingCategories', () => {
  it('returns only categories with RECENT failures, ordered by impact (windowed failed desc, then windowed successRate asc)', () => {
    const out = computeFailingCategories(sampleMetrics, { now: NOW })
    expect(out.map(c => c.slug)).toEqual([
      'user-task',                // 6 recent failures — most
      'self-improve:claim-issue', // 4 recent failures
      'self-improve:console'      // 2 recent failures
    ])
    // Historically-failed but window-clean category is excluded entirely (#2617).
    expect(out.find(c => c.slug === 'self-improve:update')).toBeUndefined()
  })

  it('projects the required fields with WINDOWED counts (slug, total, failed, successRate) plus lifetime metadata', () => {
    const [top] = computeFailingCategories(sampleMetrics, { now: NOW })
    expect(top).toMatchObject({
      slug: 'user-task',
      total: 20,
      failed: 6,
      succeeded: 14,
      successRate: 70,
      lastCompleted: '2026-07-02T00:00:00.000Z',
      avgDurationMs: 120000,
      maxDurationMs: 500000
    })
  })

  it('excludes a category whose lifetime counter has failures but whose ring is empty (stale row drops off)', () => {
    // Pre-#2460 bucket shape (no ring) or a type with no runs in the window:
    // lifetime failed > 0 must no longer keep it on the monitoring issue.
    const out = computeFailingCategories({
      x: { completed: 40, succeeded: 10, failed: 30, successRate: 25 }
    }, { now: NOW })
    expect(out).toEqual([])
  })

  it('ages old ring failures out of the window', () => {
    const out = computeFailingCategories({
      x: {
        completed: 10, succeeded: 4, failed: 6, successRate: 40,
        // The failure burst is 40 days old — outside the 30-day window; the
        // only in-window samples are successes.
        recentOutcomes: [
          ...ring(Array(6).fill(false), { endAt: NOW - 40 * DAY }),
          ...ring(Array(4).fill(true))
        ]
      }
    }, { now: NOW })
    expect(out).toEqual([])
  })

  it('derives the windowed successRate from the ring', () => {
    const [c] = computeFailingCategories({
      x: { recentOutcomes: ring([false, false, false, true]) }
    }, { now: NOW })
    expect(c.successRate).toBe(25)
    expect(c.failed).toBe(3)
    expect(c.total).toBe(4)
  })

  it('honors minCompleted (against the windowed run count) to drop thin categories', () => {
    const out = computeFailingCategories(sampleMetrics, { minCompleted: 10, now: NOW })
    expect(out.map(c => c.slug)).not.toContain('self-improve:console') // only 3 windowed runs
    expect(out.map(c => c.slug)).toContain('user-task') // 20 windowed runs
  })

  it('is null-safe', () => {
    expect(computeFailingCategories(null)).toEqual([])
    expect(computeFailingCategories(undefined)).toEqual([])
    expect(computeFailingCategories({})).toEqual([])
  })
})

describe('formatDurationShort', () => {
  it('renders seconds, minutes, and absent sentinel distinctly', () => {
    expect(formatDurationShort(40000)).toBe('40s')
    expect(formatDurationShort(160000)).toBe('2m 40s')
    expect(formatDurationShort(120000)).toBe('2m')
    expect(formatDurationShort(500)).toBe('500ms')
    expect(formatDurationShort(null)).toBe('—')
    expect(formatDurationShort(undefined)).toBe('—')
    // A genuine zero is NOT the same as absent.
    expect(formatDurationShort(0)).toBe('0ms')
  })
})

describe('formatCategoryLogLine', () => {
  it('is a single line with the required fields (windowed counts)', () => {
    const line = formatCategoryLogLine(computeFailingCategories(sampleMetrics, { now: NOW })[1])
    expect(line).not.toContain('\n')
    expect(line).toContain('self-improve:claim-issue')
    expect(line).toContain('4/12 recent failed')
    expect(line).toContain('67% success')
  })
})

describe('buildDiagnosticsIssueBody', () => {
  it('lists failing categories as a table and embeds the dedup slug marker', () => {
    const body = buildDiagnosticsIssueBody(computeFailingCategories(sampleMetrics, { now: NOW }), { generatedAt: '2026-07-12T00:00:00.000Z' })
    expect(body).toContain(`lil-slug: ${DIAGNOSTICS_SLUG}`)
    expect(body).toContain('| `user-task` | 6 / 20 |')
    expect(body).toContain('Last run: 2026-07-12T00:00:00.000Z')
    // Table order matches impact order.
    expect(body.indexOf('user-task')).toBeLessThan(body.indexOf('self-improve:claim-issue'))
  })

  it('renders an explicit all-clear when there are no failures', () => {
    const body = buildDiagnosticsIssueBody([], { generatedAt: '2026-07-12T00:00:00.000Z' })
    expect(body).toContain('All self-healing categories are passing')
    expect(body).toContain(`lil-slug: ${DIAGNOSTICS_SLUG}`)
  })
})

// A scripted `gh` runner: matches on args and returns { code, stdout, stderr }.
function makeExec(routes) {
  return vi.fn(async (cmd, args) => {
    for (const r of routes) {
      if (r.match(args)) return r.result
    }
    return { code: 0, stdout: '', stderr: '' }
  })
}

const argsHave = (...needles) => (args) => needles.every(n => args.includes(n))

describe('findMonitoringIssue', () => {
  it('prefers the issue carrying the diagnostics slug marker', async () => {
    const exec = makeExec([{
      match: argsHave('issue', 'list'),
      result: {
        code: 0,
        stdout: JSON.stringify([
          { number: 10, title: 'Unrelated monitoring', body: 'no marker', labels: [{ name: 'monitoring' }] },
          { number: 42, title: 'CoS self-diagnostics', body: `x\n<!-- lil-slug: ${DIAGNOSTICS_SLUG} -->`, labels: [{ name: 'monitoring' }, { name: 'needs attention' }] }
        ])
      }
    }])
    const { ok, issue } = await findMonitoringIssue({ exec })
    expect(ok).toBe(true)
    expect(issue.number).toBe(42)
    expect(issue.labels).toContain('needs attention')
  })

  it('does NOT hijack an unrelated monitoring issue with no marker and a different title', async () => {
    const exec = makeExec([{
      match: argsHave('issue', 'list'),
      result: {
        code: 0,
        stdout: JSON.stringify([
          { number: 10, title: 'My infra dashboard', body: 'hand-maintained notes', labels: [{ name: 'monitoring' }] }
        ])
      }
    }])
    const { ok, issue } = await findMonitoringIssue({ exec })
    expect(ok).toBe(true)
    expect(issue).toBeNull()
  })

  it('reuses a pre-marker summary by its exact stable title', async () => {
    const exec = makeExec([{
      match: argsHave('issue', 'list'),
      result: {
        code: 0,
        stdout: JSON.stringify([
          { number: 5, title: 'CoS self-diagnostics: self-healing failures', body: 'old body, no marker', labels: [{ name: 'monitoring' }] }
        ])
      }
    }])
    const { issue } = await findMonitoringIssue({ exec })
    expect(issue.number).toBe(5)
  })

  it('distinguishes a failed read (ok:false) from an empty list (ok:true)', async () => {
    const fail = makeExec([{ match: argsHave('issue', 'list'), result: { code: 1, stdout: '', stderr: 'gh boom' } }])
    expect(await findMonitoringIssue({ exec: fail })).toEqual({ ok: false, issue: null })

    const empty = makeExec([{ match: argsHave('issue', 'list'), result: { code: 0, stdout: '' } }])
    expect(await findMonitoringIssue({ exec: empty })).toEqual({ ok: true, issue: null })
  })
})

describe('runSelfDiagnostics', () => {
  const loadLearning = async () => ({ byTaskType: sampleMetrics })

  it('creates a new monitoring issue with both labels when none exists and there are failures', async () => {
    const exec = makeExec([
      { match: argsHave('issue', 'list'), result: { code: 0, stdout: '[]' } },
      { match: argsHave('label', 'create'), result: { code: 0, stdout: '' } },
      { match: argsHave('issue', 'create'), result: { code: 0, stdout: 'https://github.com/acme/repo/issues/99\n' } }
    ])
    const res = await runSelfDiagnostics({ loadLearning, exec, now: () => '2026-07-12T00:00:00.000Z' })
    expect(res.failingCount).toBe(3)
    expect(res.issue).toMatchObject({ number: 99, created: true })
    const createCall = exec.mock.calls.find(c => c[1].includes('create') && c[1].includes('issue'))
    expect(createCall[1]).toContain('--label')
    expect(createCall[1]).toContain(MONITORING_LABEL)
    expect(createCall[1]).toContain(NEEDS_ATTENTION_LABEL)
  })

  it('reuses (edits) an existing monitoring issue instead of filing a duplicate', async () => {
    const exec = makeExec([
      { match: argsHave('issue', 'list'), result: { code: 0, stdout: JSON.stringify([
        { number: 7, title: 't', body: `<!-- lil-slug: ${DIAGNOSTICS_SLUG} -->`, labels: [{ name: 'monitoring' }, { name: 'needs attention' }] }
      ]) } },
      { match: argsHave('label', 'create'), result: { code: 0, stdout: '' } },
      { match: argsHave('issue', 'edit'), result: { code: 0, stdout: '' } }
    ])
    const res = await runSelfDiagnostics({ loadLearning, exec, now: () => '2026-07-12T00:00:00.000Z' })
    expect(res.issue).toMatchObject({ number: 7, created: false })
    // No create call happened.
    expect(exec.mock.calls.find(c => c[1].includes('issue') && c[1].includes('create'))).toBeUndefined()
    // Edit happened; attention label already present so it isn't re-added.
    const editCall = exec.mock.calls.find(c => c[1].includes('edit'))
    expect(editCall[1]).toContain('--body')
    expect(editCall[1]).not.toContain('--add-label')
  })

  it('does NOT file when the issue read failed (avoids duplicate on a transient gh blip)', async () => {
    const exec = makeExec([{ match: argsHave('issue', 'list'), result: { code: 1, stdout: '', stderr: 'boom' } }])
    const res = await runSelfDiagnostics({ loadLearning, exec, now: () => '2026-07-12T00:00:00.000Z' })
    expect(res.issue).toBeNull()
    expect(exec.mock.calls.find(c => c[1].includes('create'))).toBeUndefined()
  })

  it('does not create a new issue when everything is passing and none exists', async () => {
    // Note the bucket has 55 LIFETIME failures — only the clean recent window
    // counts (#2617), so this is "passing" despite the lifetime counter.
    const allGood = async () => ({ byTaskType: { 'self-improve:update': sampleMetrics['self-improve:update'] } })
    const exec = makeExec([{ match: argsHave('issue', 'list'), result: { code: 0, stdout: '[]' } }])
    const res = await runSelfDiagnostics({ loadLearning: allGood, exec, now: () => '2026-07-12T00:00:00.000Z' })
    expect(res.failingCount).toBe(0)
    expect(res.issue).toBeNull()
    expect(exec.mock.calls.find(c => c[1].includes('create') && c[1].includes('issue'))).toBeUndefined()
  })

  it('clears the needs-attention label when the windowed failing set empties — even with lifetime failures on record (#2617)', async () => {
    // The category failed 55 times historically (lifetime `failed` can never
    // reach 0 organically) but its recent window is clean, so the label clears.
    const allGood = async () => ({ byTaskType: { 'self-improve:update': sampleMetrics['self-improve:update'] } })
    const exec = makeExec([
      { match: argsHave('issue', 'list'), result: { code: 0, stdout: JSON.stringify([
        { number: 7, title: 't', body: `<!-- lil-slug: ${DIAGNOSTICS_SLUG} -->`, labels: [{ name: 'monitoring' }, { name: 'needs attention' }] }
      ]) } },
      { match: argsHave('label', 'create'), result: { code: 0, stdout: '' } },
      { match: argsHave('issue', 'edit'), result: { code: 0, stdout: '' } }
    ])
    await runSelfDiagnostics({ loadLearning: allGood, exec, now: () => '2026-07-12T00:00:00.000Z' })
    const editCall = exec.mock.calls.find(c => c[1].includes('edit'))
    expect(editCall[1]).toContain('--remove-label')
    expect(editCall[1]).toContain(NEEDS_ATTENTION_LABEL)
  })

  it('has a stable title', () => {
    expect(buildDiagnosticsIssueTitle()).toBe('CoS self-diagnostics: self-healing failures')
  })
})
