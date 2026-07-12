/**
 * Autonomous Jobs — self-diagnostics script handler (#2464).
 *
 * A deterministic `type: 'script'` job that surfaces CoS self-healing failures
 * (claim-work / layered-intelligence / any task category) so operators get an
 * automated pulse on system health. On each run it:
 *   1. Reads the task-learning per-category metrics (`byTaskType`) — the same
 *      completion data the Learning tab renders.
 *   2. For every category with `failed > 0`, records a structured single-line log
 *      entry (slug, total/failed counts, lastCompleted, avg/max duration).
 *   3. Aggregates the failing categories, ordered by impact, into ONE persistent
 *      GitHub summary issue — reusing an existing issue marked `monitoring` so the
 *      loop never files a fresh duplicate each cycle.
 *   4. Applies a `needs attention` label while failures exist (and removes it once
 *      the categories recover) so the same summary isn't re-reported as stale.
 *
 * NO LLM calls — this is a pure metrics-read + `gh` issue write, safe to run on a
 * schedule under the cold-bootstrap AI policy. The pure helpers (compute/sort,
 * title/body/log builders) are side-effect-free and unit-tested; the I/O handler
 * takes injectable deps so tests drive it without a live `gh` or filesystem.
 */

import { spawn } from 'child_process'
import { PATHS, safeJSONParse } from '../../lib/fileUtils.js'
import { loadLearningData } from '../taskLearning/store.js'

// The label that marks the ONE persistent summary issue to reuse across runs, and
// the attention label the loop toggles so a still-open summary isn't re-filed.
export const MONITORING_LABEL = 'monitoring'
export const NEEDS_ATTENTION_LABEL = 'needs attention'

// Stable dedup marker embedded in the summary issue body. Lets a run recognize
// its own prior summary even if the `monitoring` label was hand-applied to an
// unrelated issue, and lets a human/label read find it.
export const DIAGNOSTICS_SLUG = 'cos-self-diagnostics'
const SLUG_MARKER = `<!-- lil-slug: ${DIAGNOSTICS_SLUG} -->`

const STABLE_TITLE = 'CoS self-diagnostics: self-healing failures'

/**
 * Reduce the learning `byTaskType` map to the categories that have at least one
 * failure, projected onto the fields the summary + logs need, ordered by impact.
 * Pure. Impact order: most failures first, then lowest success rate, then most
 * total runs (a big-sample low-rate category outranks a one-off flake).
 *
 * @param {Record<string, object>} byTaskType
 * @param {{ minCompleted?: number }} [opts] - ignore thin categories below this
 *   completion count (default 1 — any category with a recorded failure qualifies).
 * @returns {Array<{ slug, total, failed, succeeded, successRate, lastCompleted, avgDurationMs, maxDurationMs }>}
 */
export function computeFailingCategories(byTaskType, { minCompleted = 1 } = {}) {
  if (!byTaskType || typeof byTaskType !== 'object') return []
  return Object.entries(byTaskType)
    .map(([slug, m]) => ({
      slug,
      total: m?.completed ?? 0,
      failed: m?.failed ?? 0,
      succeeded: m?.succeeded ?? 0,
      // Prefer the stored rate; fall back to a derived one so an older record
      // without `successRate` still sorts/renders correctly.
      successRate: Number.isFinite(m?.successRate)
        ? m.successRate
        : (m?.completed > 0 ? Math.round(((m.succeeded ?? 0) / m.completed) * 100) : 0),
      lastCompleted: m?.lastCompleted ?? null,
      avgDurationMs: m?.avgDurationMs ?? null,
      maxDurationMs: m?.maxDurationMs ?? null
    }))
    .filter(c => c.failed > 0 && c.total >= minCompleted)
    .sort((a, b) =>
      b.failed - a.failed ||
      a.successRate - b.successRate ||
      b.total - a.total
    )
}

/**
 * Human-friendly ms → minutes/seconds. Pure. Null-safe (`—` when absent).
 * Distinct from `fileUtils.formatDuration` (which floors to whole minutes and
 * renders sub-minute as "0m") and the client `formatDurationMs`: diagnostics
 * durations are often seconds, and absent must read as `—`, not a zero duration.
 */
export function formatDurationShort(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec ? `${min}m ${sec}s` : `${min}m`
}

/**
 * Structured single-line log entry for one failing category. Pure — the handler
 * emits it via console so logs stay single-line + emoji-prefixed (CLAUDE.md).
 */
export function formatCategoryLogLine(c) {
  return `🩺 ${c.slug}: ${c.failed}/${c.total} failed (${c.successRate}% success) · ` +
    `last ${c.lastCompleted || 'n/a'} · avg ${formatDurationShort(c.avgDurationMs)} · max ${formatDurationShort(c.maxDurationMs)}`
}

/** Stable summary-issue title. Pure. */
export function buildDiagnosticsIssueTitle() {
  return STABLE_TITLE
}

/**
 * Markdown body for the summary issue. Pure. Lists failing categories in impact
 * order as a table, embeds the dedup slug marker, and stamps the run time so a
 * reused issue shows freshness. `failing:[]` renders an explicit all-clear.
 */
export function buildDiagnosticsIssueBody(failing, { generatedAt = new Date().toISOString() } = {}) {
  const lines = []
  lines.push('_Automated CoS self-diagnostics — regenerated each run. Do not hand-edit; edits are overwritten._')
  lines.push('')
  if (!failing || failing.length === 0) {
    lines.push('✅ **All self-healing categories are passing** — no categories with recorded failures.')
  } else {
    lines.push(`Found **${failing.length}** self-healing categor${failing.length === 1 ? 'y' : 'ies'} with recorded failures, ordered by impact:`)
    lines.push('')
    lines.push('| Category | Failed / Total | Success rate | Last completed | Avg duration | Max duration |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const c of failing) {
      lines.push(`| \`${c.slug}\` | ${c.failed} / ${c.total} | ${c.successRate}% | ${c.lastCompleted || '—'} | ${formatDurationShort(c.avgDurationMs)} | ${formatDurationShort(c.maxDurationMs)} |`)
    }
    lines.push('')
    lines.push('These are candidates for human diagnosis (model routing, tooling, or pipeline issues). Investigate the highest-impact rows first.')
  }
  lines.push('')
  lines.push(`_Last run: ${generatedAt}_`)
  lines.push('')
  lines.push(SLUG_MARKER)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// I/O layer — `gh` shell + the handler. Injectable deps keep them testable.
// ---------------------------------------------------------------------------

/** Run a CLI, resolving `{ code, stdout, stderr }` (never rejects). Pure I/O. */
function runCli(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, ...options })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.stderr?.on('data', d => { stderr += d.toString() })
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.on('error', err => resolve({ code: -1, stdout: '', stderr: err.message }))
  })
}

/**
 * Locate the persistent summary issue to reuse. Prefers an open `monitoring`
 * issue carrying our slug marker; falls back to the first open `monitoring`
 * issue. Returns `{ ok, issue }` — `ok:false` means the read FAILED (do NOT then
 * create a new one, or a transient `gh` blip files a duplicate; sentinel rule).
 */
export async function findMonitoringIssue({ cwd = PATHS.root, exec = runCli } = {}) {
  const { code, stdout } = await exec('gh',
    ['issue', 'list', '--label', MONITORING_LABEL, '--state', 'open', '--limit', '20', '--json', 'number,title,body,labels,url'],
    { cwd })
  if (code !== 0) return { ok: false, issue: null }
  if (!stdout.trim()) return { ok: true, issue: null }
  const parsed = safeJSONParse(stdout, null, { logError: false })
  if (!Array.isArray(parsed)) return { ok: false, issue: null }
  const norm = parsed.map(i => ({
    number: i.number ?? null,
    title: i.title || '',
    body: i.body || '',
    url: i.url || null,
    labels: (i.labels || []).map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
  }))
  const bySlug = norm.find(i => i.body.includes(SLUG_MARKER))
  return { ok: true, issue: bySlug || norm[0] || null }
}

/**
 * Ensure the labels exist before the first `issue create` (gh fails creating an
 * issue with a non-existent label). Idempotent — `--force` is a no-op when the
 * label already exists.
 */
export async function ensureDiagnosticsLabels({ cwd = PATHS.root, exec = runCli } = {}) {
  const labels = [
    { name: MONITORING_LABEL, color: '0e8a16', desc: 'Persistent monitoring / self-diagnostics summary issue' },
    { name: NEEDS_ATTENTION_LABEL, color: 'd93f0b', desc: 'Flagged by CoS self-diagnostics — needs human diagnosis' }
  ]
  for (const l of labels) {
    await exec('gh', ['label', 'create', l.name, '--color', l.color, '--description', l.desc, '--force'], { cwd })
  }
}

/**
 * Self-diagnostics handler (SCRIPT_HANDLERS['self-diagnostics']).
 *
 * @param {object} [deps]
 * @param {() => Promise<object>} [deps.loadLearning] - learning-data loader
 * @param {(cmd,args,opts)=>Promise<{code,stdout,stderr}>} [deps.exec] - CLI runner
 * @param {string} [deps.cwd] - repo root for `gh`
 * @param {() => string} [deps.now] - ISO clock (test seam)
 * @returns {Promise<{ failingCount, categories, issue }>}
 */
export async function runSelfDiagnostics({
  loadLearning = loadLearningData,
  exec = runCli,
  cwd = PATHS.root,
  now = () => new Date().toISOString()
} = {}) {
  const data = await loadLearning()
  const failing = computeFailingCategories(data?.byTaskType)

  if (failing.length === 0) {
    console.log('🩺 Self-diagnostics: no self-healing categories with recorded failures — all clear')
  } else {
    console.log(`🩺 Self-diagnostics: ${failing.length} failing categor${failing.length === 1 ? 'y' : 'ies'} (top: ${failing[0].slug} ${failing[0].failed}/${failing[0].total})`)
    for (const c of failing) console.log(formatCategoryLogLine(c))
  }

  const generatedAt = now()
  const title = buildDiagnosticsIssueTitle()
  const body = buildDiagnosticsIssueBody(failing, { generatedAt })

  const found = await findMonitoringIssue({ cwd, exec })
  if (!found.ok) {
    // Read failed — refuse to file, or a transient gh blip duplicates the summary.
    console.warn('⚠️ Self-diagnostics: could not read monitoring issues (gh unavailable?) — skipping issue update')
    return { failingCount: failing.length, categories: failing, issue: null }
  }

  const hasFailures = failing.length > 0
  await ensureDiagnosticsLabels({ cwd, exec })

  if (found.issue) {
    // Reuse the existing monitoring issue: refresh the body, and toggle the
    // attention label to match the current state (add on failures, clear on all-green).
    const editArgs = ['issue', 'edit', String(found.issue.number), '--body', body]
    if (hasFailures && !found.issue.labels.includes(NEEDS_ATTENTION_LABEL)) {
      editArgs.push('--add-label', NEEDS_ATTENTION_LABEL)
    } else if (!hasFailures && found.issue.labels.includes(NEEDS_ATTENTION_LABEL)) {
      editArgs.push('--remove-label', NEEDS_ATTENTION_LABEL)
    }
    const { code, stderr } = await exec('gh', editArgs, { cwd })
    if (code !== 0) {
      console.warn(`⚠️ Self-diagnostics: failed to update issue #${found.issue.number}: ${stderr.trim()}`)
      return { failingCount: failing.length, categories: failing, issue: null }
    }
    console.log(`🩺 Self-diagnostics: updated monitoring issue #${found.issue.number} (${failing.length} failing)`)
    return { failingCount: failing.length, categories: failing, issue: { number: found.issue.number, url: found.issue.url, created: false } }
  }

  if (!hasFailures) {
    // Nothing failing and no existing summary — don't create noise.
    console.log('🩺 Self-diagnostics: no failures and no existing summary issue — nothing to file')
    return { failingCount: 0, categories: [], issue: null }
  }

  const createArgs = ['issue', 'create', '--title', title, '--body', body, '--label', MONITORING_LABEL, '--label', NEEDS_ATTENTION_LABEL]
  const { code, stdout, stderr } = await exec('gh', createArgs, { cwd })
  if (code !== 0) {
    console.warn(`⚠️ Self-diagnostics: failed to create monitoring issue: ${stderr.trim()}`)
    return { failingCount: failing.length, categories: failing, issue: null }
  }
  const url = (stdout.trim().match(/(https?:\/\/\S+)/) || [])[1] || stdout.trim()
  const number = Number((url.match(/(\d+)\s*$/) || [])[1]) || null
  console.log(`🩺 Self-diagnostics: filed monitoring issue ${url} (${failing.length} failing)`)
  return { failingCount: failing.length, categories: failing, issue: { number, url, created: true } }
}
