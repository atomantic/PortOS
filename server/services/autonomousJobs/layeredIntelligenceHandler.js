/**
 * Layered Intelligence Loop — the Engine-B sweep handler.
 *
 * Registered in SCRIPT_HANDLERS as `layered-intelligence`. On each fire it sweeps
 * getActiveApps() and processes every app whose `layeredIntelligence.enabled ===
 * true`, honoring a per-app `intervalMs`. For each due app it runs the four
 * layers: GATHER → REASON → DECIDE → ACT. The reasoning model only returns
 * structured JSON; all side effects (dedup, scope-gate, pause, filing) are the
 * deterministic helpers in ../layeredIntelligence.js.
 *
 * Runs OUTSIDE the request lifecycle, so — per the CLAUDE.md no-try/catch rule —
 * a per-app failure is wrapped, logged emoji-style, and the sweep continues; one
 * bad app never aborts the whole sweep. Off by default (AI-provider policy).
 */

import { PORTOS_APP_ID, getActiveApps, updateAppLayeredIntelligence } from '../apps.js'
import {
  getEffectiveConfig,
  buildPrompt,
  gatherSources,
  listForgeIssues,
  listBlockingIssues,
  isAppParked,
  validateReasonerResponse,
  isScopeAllowed,
  isProposalDuplicate,
  filerForTracker,
  trackerSupportsPause,
  resolveBlockOnIssue,
  fileProposalToForge,
  applyBlockingLabel,
  appendProposalToPlan,
  extractPlanSlugs
} from '../layeredIntelligence.js'
import { resolveAppWorkTracker } from '../../lib/workTracker.js'
import { tryReadFile, safeJSONParse } from '../../lib/fileUtils.js'
import { stripCodeFences } from '../../lib/aiProvider.js'
import { join } from 'path'

/**
 * Whether an app is DUE this run — its per-app interval has elapsed since the
 * last recorded run. A never-run app (no lastRunAt) is always due.
 */
export function isAppDue(config, lastRunAt, now = Date.now()) {
  if (!lastRunAt) return true
  const last = Date.parse(lastRunAt)
  if (!Number.isFinite(last)) return true
  return now - last >= (config.intervalMs || 0)
}

/**
 * Process ONE app end-to-end (the four layers). Returns a structured outcome for
 * logging/telemetry: { app, action, ... }. Never throws — the caller's sweep
 * wrap is the async boundary, but this stays defensive so a partial failure of
 * one layer degrades to a no-op outcome rather than aborting.
 *
 * `deps` is injectable for tests (callLLM, forge listers/filers, plan append).
 */
export async function processApp(app, deps = {}) {
  const {
    callLLM,
    now = Date.now()
  } = deps

  const isPortos = app.id === PORTOS_APP_ID
  const config = getEffectiveConfig({ ...app, isPortos })

  if (!config.enabled) return { app: app.id, action: 'skipped', reason: 'disabled' }
  if (!isAppDue(config, app.layeredIntelligence?.lastRunAt, now)) {
    return { app: app.id, action: 'skipped', reason: 'not-due' }
  }

  // Resolve where this app files work — branch up front so a `plan` app never
  // hits the forge-only label/issue paths.
  const tracker = await resolveAppWorkTracker(app).catch(() => ({ resolved: 'plan', forge: null }))
  const filer = filerForTracker(tracker.resolved)
  const forgeCli = tracker.forge // 'gh' | 'glab' | null
  const cwd = app.repoPath

  // Jira filing is deferred to a follow-up (see PR Remaining). Skip a jira-tracked
  // app BEFORE reasoning so we never burn an LLM call that can't file the result.
  if (filer === 'jira') {
    await recordRun(app, config, now)
    return { app: app.id, action: 'skipped', reason: 'jira-filer-not-implemented' }
  }

  // ---- Park check (forge only; plan has no issue to block on) ----
  if (trackerSupportsPause(tracker.resolved) && filer === 'forge' && forgeCli) {
    const blocking = await listBlockingIssues({ cli: forgeCli, cwd })
    // A FAILED read (ok:false) is not "no blocking issues" — skip this app rather
    // than risk resuming work the user parked, and try again next run.
    if (!blocking.ok) {
      console.warn(`⚠️ Layered Intelligence: ${app.name} blocking-issue read failed — skipping this run`)
      await recordRun(app, config, now)
      return { app: app.id, action: 'skipped', reason: 'blocking-read-failed' }
    }
    if (isAppParked(blocking.issues)) {
      console.log(`⏸️ Layered Intelligence: ${app.name} parked on ${blocking.issues.length} blocking issue(s) — skipping`)
      await recordRun(app, config, now)
      return { app: app.id, action: 'parked', blocking: blocking.issues.length }
    }
  }

  // ---- Layer 1: GATHER ----
  const sources = await gatherSources(app, config)
  let openIssues = []
  let existingIssues = []
  let trackerReadFailed = false
  if (filer === 'forge' && forgeCli) {
    const listed = await listForgeIssues({ cli: forgeCli, cwd })
    trackerReadFailed = !listed.ok
    existingIssues = listed.issues
    // Only surface open issues to the reasoner when the openIssues source is on;
    // dedup still runs against ALL existing issues regardless of the toggle.
    if (config.sources?.openIssues !== false) {
      openIssues = existingIssues.filter(i => i.state === 'open')
    }
  } else if (filer === 'plan' && cwd) {
    const planContent = await tryReadFile(join(cwd, 'PLAN.md'))
    const planSlugs = extractPlanSlugs(planContent || '')
    existingIssues = planSlugs.map(slug => ({ slug, state: 'open' }))
  }

  // ---- Layer 2: REASON ----
  const prompt = buildPrompt({ app, config, sources, openIssues, isPortos })
  const llm = await resolveLLM(config, callLLM)
  if (!llm.ok) {
    await recordRun(app, config, now)
    return { app: app.id, action: 'no-op', reason: llm.reason }
  }
  const llmResult = await llm.call(prompt)
  if (llmResult?.error) {
    await recordRun(app, config, now)
    return { app: app.id, action: 'no-op', reason: `llm-error: ${llmResult.error}` }
  }

  const parsed = safeParse(llmResult?.text)
  const { proposal, pause } = validateReasonerResponse(parsed)

  // ---- Layer 3: DECIDE (scope-gate + dedup) ----
  let filedNumber = null
  let filedAction = 'no-op'
  if (proposal) {
    const scopeOk = isScopeAllowed({ scope: proposal.scope, allowedScopes: config.allowedScopes, isPortos })
    if (!scopeOk) {
      console.log(`🚫 Layered Intelligence: ${app.name} proposal scope "${proposal.scope}" not allowed — suppressed`)
    } else if (trackerReadFailed) {
      // Dedup would be blind against a failed tracker read — never file, or a
      // transient forge blip files a duplicate. Retry next run (CLAUDE.md sentinel).
      console.warn(`⚠️ Layered Intelligence: ${app.name} tracker read failed — suppressing proposal to avoid a blind duplicate`)
      filedAction = 'tracker-read-failed'
    } else if (isProposalDuplicate({ slug: proposal.slug, existingIssues, now })) {
      console.log(`♻️ Layered Intelligence: ${app.name} proposal "${proposal.slug}" is a duplicate — suppressed`)
      filedAction = 'duplicate'
    } else {
      // ---- Layer 4: ACT (file exactly one) ----
      const filed = await fileProposal({ filer, forgeCli, cwd, app, proposal })
      if (filed.success) {
        filedNumber = filed.number ?? null
        filedAction = 'filed'
        console.log(`📌 Layered Intelligence: ${app.name} filed "${proposal.title}" [${proposal.slug}]${filedNumber ? ` (#${filedNumber})` : ''}`)
      } else {
        console.error(`❌ Layered Intelligence: ${app.name} failed to file proposal: ${filed.error || 'unknown'}`)
      }
    }
  }

  // ---- Pause (forge only; resolve blockOnIssue after filing) ----
  let paused = false
  if (pause && filer === 'forge' && forgeCli) {
    const number = resolveBlockOnIssue(pause, filedNumber)
    if (Number.isInteger(number)) {
      const res = await applyBlockingLabel({ cli: forgeCli, cwd, number })
      paused = res.success
      if (paused) console.log(`⏸️ Layered Intelligence: ${app.name} paused on #${number} — ${pause.reason}`)
    }
  }

  await recordRun(app, config, now)
  return { app: app.id, action: filedAction, filedNumber, paused }
}

/** File the proposal via the resolved tracker's filer. */
async function fileProposal({ filer, forgeCli, cwd, app, proposal }) {
  if (filer === 'forge' && forgeCli) {
    return fileProposalToForge({ cli: forgeCli, cwd, title: proposal.title, body: proposal.body, slug: proposal.slug })
  }
  if (filer === 'plan' && cwd) {
    const res = await appendProposalToPlan({ repoPath: cwd, appName: app.name, slug: proposal.slug, title: proposal.title, body: proposal.body })
    return { success: res.success, number: null }
  }
  // Jira filing is deferred to a follow-up (see PR Remaining).
  return { success: false, error: `filer "${filer}" not implemented` }
}

/**
 * Resolve the LLM call function. Prefers an injected `callLLM(prompt)`; otherwise
 * resolves the active/overridden provider and returns a bound
 * callProviderAISimple. Returns `{ ok: false, reason }` when no provider is
 * available (a no-op for that app, never a throw).
 */
async function resolveLLM(config, injected) {
  if (typeof injected === 'function') return { ok: true, call: injected }
  const { getActiveProvider, getProviderById } = await import('../providers.js')
  const provider = config.providerId
    ? await getProviderById(config.providerId).catch(() => null)
    : await getActiveProvider().catch(() => null)
  if (!provider) return { ok: false, reason: 'no-provider' }
  const model = config.model || provider.defaultModel
  const { callProviderAISimple } = await import('../../lib/aiProvider.js')
  return {
    ok: true,
    call: (prompt) => callProviderAISimple(provider, model, prompt, {
      op: `layered-intelligence:${provider.id}`,
      opLabel: 'Layered Intelligence reasoning…',
      max_tokens: 1500
    })
  }
}

/**
 * Parse LLM JSON, returning null on failure (a no-op for that app). Reuses the
 * shared `stripCodeFences` + `safeJSONParse` helpers rather than a local
 * try/catch (repo convention: no non-boundary try/catch).
 */
function safeParse(text) {
  if (typeof text !== 'string') return null
  return safeJSONParse(stripCodeFences(text), null, { logError: false })
}

/**
 * Persist per-app run bookkeeping (lastRunAt) — run cadence, not issue memory.
 * Routes through updateAppLayeredIntelligence so the write RE-READS the current
 * stored config and merges ONLY `lastRunAt` over it, rather than writing back the
 * (possibly seconds-stale) snapshot captured at sweep start — so a user config
 * edit made mid-sweep isn't clobbered by the run-bookkeeping write.
 */
async function recordRun(app, config, now) {
  await updateAppLayeredIntelligence(app.id, { lastRunAt: new Date(now).toISOString() }).catch((err) => {
    console.error(`❌ Layered Intelligence: failed to record run for ${app.id}: ${err.message}`)
  })
}

/**
 * The SCRIPT_HANDLERS entry. Sweeps active apps and processes each enabled+due
 * one. Per-app failures are caught and logged so the sweep continues.
 */
export async function runLayeredIntelligence() {
  const apps = await getActiveApps()
  const results = []
  let processed = 0
  for (const app of apps) {
    const config = getEffectiveConfig({ ...app, isPortos: app.id === PORTOS_APP_ID })
    if (!config.enabled) continue
    const outcome = await processApp(app).catch((err) => {
      console.error(`❌ Layered Intelligence: ${app.name} sweep error: ${err.message}`)
      return { app: app.id, action: 'error', error: err.message }
    })
    if (outcome.action !== 'skipped') processed++
    results.push(outcome)
  }
  console.log(`🧠 Layered Intelligence sweep complete: ${processed} app(s) processed of ${apps.length} active`)
  return { processed, total: apps.length, results }
}
