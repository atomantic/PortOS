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

// A sample byTaskType map mirroring the learning.json shape.
const sampleMetrics = {
  'self-improve:claim-issue': { completed: 192, succeeded: 137, failed: 55, successRate: 71, lastCompleted: '2026-07-01T00:00:00.000Z', avgDurationMs: 160000, maxDurationMs: 900000 },
  'self-improve:console': { completed: 3, succeeded: 1, failed: 2, successRate: 33, lastCompleted: '2026-06-01T00:00:00.000Z', avgDurationMs: 40000, maxDurationMs: 60000 },
  'user-task': { completed: 1177, succeeded: 1002, failed: 175, successRate: 85, lastCompleted: '2026-07-02T00:00:00.000Z', avgDurationMs: 120000, maxDurationMs: 500000 },
  'self-improve:update': { completed: 7, succeeded: 7, failed: 0, successRate: 100, lastCompleted: '2026-02-04T00:00:00.000Z', avgDurationMs: 160000, maxDurationMs: 200000 }
}

describe('computeFailingCategories', () => {
  it('returns only categories with failures, ordered by impact (failed desc, then successRate asc)', () => {
    const out = computeFailingCategories(sampleMetrics)
    expect(out.map(c => c.slug)).toEqual([
      'user-task',              // 175 failures — most
      'self-improve:claim-issue', // 55 failures
      'self-improve:console'    // 2 failures
    ])
    // The passing category is excluded entirely.
    expect(out.find(c => c.slug === 'self-improve:update')).toBeUndefined()
  })

  it('projects the required fields (slug, total, failed, successRate, lastCompleted, avg/max duration)', () => {
    const [top] = computeFailingCategories(sampleMetrics)
    expect(top).toMatchObject({
      slug: 'user-task',
      total: 1177,
      failed: 175,
      succeeded: 1002,
      successRate: 85,
      lastCompleted: '2026-07-02T00:00:00.000Z',
      avgDurationMs: 120000,
      maxDurationMs: 500000
    })
  })

  it('derives successRate when the stored value is missing', () => {
    const [c] = computeFailingCategories({ x: { completed: 4, succeeded: 1, failed: 3 } })
    expect(c.successRate).toBe(25)
  })

  it('honors minCompleted to drop thin categories', () => {
    const out = computeFailingCategories(sampleMetrics, { minCompleted: 10 })
    expect(out.map(c => c.slug)).not.toContain('self-improve:console') // only 3 completions
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
  it('is a single line with the required fields', () => {
    const line = formatCategoryLogLine(computeFailingCategories(sampleMetrics)[1])
    expect(line).not.toContain('\n')
    expect(line).toContain('self-improve:claim-issue')
    expect(line).toContain('55/192 failed')
    expect(line).toContain('71% success')
  })
})

describe('buildDiagnosticsIssueBody', () => {
  it('lists failing categories as a table and embeds the dedup slug marker', () => {
    const body = buildDiagnosticsIssueBody(computeFailingCategories(sampleMetrics), { generatedAt: '2026-07-12T00:00:00.000Z' })
    expect(body).toContain(`lil-slug: ${DIAGNOSTICS_SLUG}`)
    expect(body).toContain('| `user-task` | 175 / 1177 |')
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
    const allGood = async () => ({ byTaskType: { 'self-improve:update': sampleMetrics['self-improve:update'] } })
    const exec = makeExec([{ match: argsHave('issue', 'list'), result: { code: 0, stdout: '[]' } }])
    const res = await runSelfDiagnostics({ loadLearning: allGood, exec, now: () => '2026-07-12T00:00:00.000Z' })
    expect(res.failingCount).toBe(0)
    expect(res.issue).toBeNull()
    expect(exec.mock.calls.find(c => c[1].includes('create') && c[1].includes('issue'))).toBeUndefined()
  })

  it('clears the needs-attention label when a previously-failing summary recovers', async () => {
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
