/**
 * Layered Intelligence as programmatic-I/O hooks (issue-follow-up to #2322).
 *
 * LI used to run as a HANDLER-BACKED task — an inline `runPromptThroughProvider`
 * call wrapped in `runLayeredIntelligenceForApp`, invisible to the CoS queue /
 * Active Agents and un-attachable in a TUI. It is now a NORMAL agent-backed
 * scheduled task with two programmatic slots (see taskTypeHooks.js +
 * docs/plans/2026-07-09-programmatic-io-scheduled-tasks.md):
 *
 *   - `buildTaskInput({ app })` — the GATHER layer: park-check (skip if parked),
 *     gather the app's sources + open issues, and build the reasoning prompt the
 *     agent runs. Returns `{ prompt, skip? }`.
 *   - `processTaskOutput({ appId, payload, ... })` — the DECIDE + ACT layers:
 *     validate the agent's structured `.agent-done` payload, scope-gate, dedup
 *     (exact + semantic), file exactly one tracker issue, pause, optional Engine-A
 *     hand-off, and record last-run bookkeeping.
 *
 * The REASON layer is now the agent itself (visible, TUI-capable). Its worktree
 * is discarded without a commit (LI's task metadata sets discardWorktree), so the
 * agent can't land code — the structured payload is its only channel out, exactly
 * the "reasoner never writes code" guarantee the old handler enforced by never
 * spawning an agent at all. Every deterministic side effect stays in these hooks.
 *
 * Runs OUTSIDE the request lifecycle (scheduler tick / agent completion), so per
 * the CLAUDE.md no-try/catch rule the dispatchers own the async boundary; these
 * stay defensive so a partial failure degrades to a recorded no-op.
 */

import { PORTOS_APP_ID, updateAppLayeredIntelligence, getAppById } from '../apps.js'
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
  checkSemanticDuplicate,
  isHandoffEligible,
  buildHandoffTask,
  filerForTracker,
  trackerSupportsPause,
  resolveBlockOnIssue,
  fileProposalToForge,
  applyBlockingLabel,
  appendProposalToPlan,
  extractPlanSlugs,
  listJiraIssues,
  listJiraBlockingIssues,
  fileProposalToJira,
  resolveJiraBlockKey,
  applyJiraBlockingLabel,
  computeOutcomesReport
} from '../layeredIntelligence.js'
import { recordFiledProposal, listOutcomes, reconcileOutcomes } from '../layeredIntelligenceOutcomes.js'

// The outcome feedback loop (#2428) can only reconcile a proposal's fate on a
// tracker that reports closed-state. All three now qualify: a forge (gh/glab
// issues) and jira report a real closed state, and since #2435 the `plan`
// tracker preserves each `[lil-*]` item's checkbox — a `- [x]` item reads
// `closed` (deriveOutcome → 'merged'), so a completed PLAN proposal reconciles
// like any other. (A `- [ ]` item stays open and unresolved, as before.)
function outcomesTrackerSupported(filer) {
  return filer === 'forge' || filer === 'jira' || filer === 'plan'
}
import { resolveAppWorkTracker } from '../../lib/workTracker.js'
import { tryReadFile } from '../../lib/fileUtils.js'
import { join } from 'path'

/**
 * Resolve the per-app LI execution context shared by both hooks: effective
 * config (with the per-app task provider/model overlaid), whether this app IS
 * the PortOS install, the resolved work tracker + filer, and the Jira coords when
 * jira-tracked. Mirrors the old handler's L91–126 setup so the split hooks agree
 * on WHERE work files.
 */
async function resolveLiContext(app) {
  const isPortos = app.id === PORTOS_APP_ID
  const config = getEffectiveConfig({ ...app, isPortos })

  // Option A: provider/model live in the per-app scheduled-task override; overlay
  // them onto the effective config so `config.providerId`/`config.model` express
  // the app's PER-APP choice — the input resolveLiAgentProvider walks (per-app →
  // schedule pin → default) to produce LI's final agent provider.
  const override = (app.taskTypeOverrides && typeof app.taskTypeOverrides === 'object')
    ? (app.taskTypeOverrides['layered-intelligence'] || {})
    : {}
  if (override.providerId != null) config.providerId = override.providerId
  if (override.model != null) config.model = override.model

  const tracker = await resolveAppWorkTracker(app).catch(() => ({ resolved: 'plan', forge: null }))
  const filer = filerForTracker(tracker.resolved)
  const forgeCli = tracker.forge // 'gh' | 'glab' | null
  const cwd = app.repoPath
  const jira = (filer === 'jira' && app.jira?.enabled && app.jira?.instanceId && app.jira?.projectKey)
    ? { instanceId: app.jira.instanceId, projectKey: app.jira.projectKey, issueType: app.jira.issueType || 'Task' }
    : null

  return { isPortos, config, tracker, filer, forgeCli, cwd, jira }
}

/**
 * Resolve LI's reasoning-AGENT provider/model — the SINGLE source of truth, so the
 * spawn path's hookOverride carries the fully-resolved choice rather than
 * re-deriving the schedule pin in cosTaskGenerator. Walks per-app → schedule pin →
 * default and applies the "must be a file-writing CLI/TUI harness" filter.
 *
 * The reasoning agent needs a CLI/TUI harness to emit its `.agent-done` sentinel —
 * an HTTP `api` provider (ollama / lmstudio / kimi) has none, so an agent-backed
 * run pinned to one fails provider resolution and the task sits pending forever.
 * Pre-#2322 LI called the API path directly, so an api provider was valid then;
 * migration 184 faithfully carried whatever `layeredIntelligence.providerId` held
 * — INCLUDING ollama/lmstudio/kimi — into the per-app override, which now outranks
 * everything at spawn (cosTaskGenerator applies the hook's providerId LAST). So any
 * install that ran LI on an api provider before #2322 is wedged, and the user's
 * natural fix — picking a CLI/TUI provider on the global Schedule page — silently
 * misses, because that only sets the schedule pin (the FALLBACK) while the stale
 * per-app override still wins.
 *
 * SELF-HEAL that residue: when the per-app override is api-only but the schedule
 * pin IS a real CLI/TUI provider, adopt the pin (provider + its matched model)
 * instead of wedging — this makes the Schedule page's selection finally take
 * effect. Only when NO CLI/TUI provider is configured anywhere the user chose
 * (per-app api with no usable pin, or an api pin) do we return an actionable
 * `skipReason` — guiding them to pick a real CLI/TUI provider beats silently
 * substituting one they never chose. A null/absent resolved provider is fine: it
 * inherits the default coding agent (a spawn-time api resolution still falls to the
 * lifecycle block).
 *
 * Reads the global schedule pin AT MOST ONCE and mutates nothing — `config` is a
 * read-only input (its `providerId`/`model` are the per-app effective override).
 * Returns `{ providerId, model, skipReason }`; the caller gates on `skipReason`.
 */
async function resolveLiAgentProvider(app, config) {
  const { getProviderById } = await import('../providers.js')
  const providerTypeOf = async (id) => {
    if (!id) return null
    const provider = await getProviderById(id).catch(() => null)
    return provider?.type ?? null
  }
  // The global schedule pin is LI's provider FALLBACK; read it via the canonical
  // getTaskInterval (returns a defaulted { providerId: null, ... } when absent).
  const readPin = async () => {
    const { getTaskInterval } = await import('../taskSchedule.js')
    return getTaskInterval('layered-intelligence')
  }

  let providerId = config.providerId || null
  let model = config.model ?? null
  let type = await providerTypeOf(providerId)

  if (type === 'api') {
    const pin = await readPin()
    const pinId = pin?.providerId || null
    const pinType = await providerTypeOf(pinId)
    // Adopt the pin only when it RESOLVES to a real non-api provider. `pinType` is
    // null for an unresolvable id (deleted/renamed/typo'd pin) — treating that as
    // "not api" and adopting it would re-wedge the task on a doomed provider with a
    // misleading "healed" warning, so require a positively-known type.
    if (pinId && pinType && pinType !== 'api') {
      console.warn(`⚠️ Layered Intelligence: ${app.name} per-app provider '${providerId}' is API-only (no coding harness) — using the schedule provider '${pinId}' instead`)
      // Adopt the pin's model too — provider+model are a matched pair the user set
      // together on the Schedule page (an api-provider model name may not be valid
      // for the CLI/TUI provider).
      providerId = pinId
      model = pin?.model ?? null
      type = pinType
    }
  } else if (!providerId) {
    // No per-app override → resolve the schedule pin here so the returned override
    // carries it, rather than delegating that leg to the generator's
    // interval.providerId. An api pin still skips; a non-api pin becomes LI's
    // provider; no pin inherits the default coding agent.
    const pin = await readPin()
    const pinId = pin?.providerId || null
    type = await providerTypeOf(pinId)
    if (type && type !== 'api') {
      providerId = pinId
      // Keep an explicit per-app model if the user set one (provider absent but
      // model present); only fall back to the pin's model when there's no per-app
      // model. This matches the pre-refactor net spawn behavior, where the hook's
      // returned model (the per-app model) overrode the generator's interval.model.
      model = config.model ?? pin?.model ?? null
    }
  }

  if (type === 'api') return { providerId: null, model: null, skipReason: 'provider-not-agent-capable' }
  return { providerId, model, skipReason: null }
}

/**
 * Read the app's open + existing tracker issues for the reasoner (open issues) and
 * the dedup guard (all existing). Returns `{ openIssues, existingIssues,
 * trackerReadFailed }`. A failed read is surfaced (never treated as "no issues")
 * so the caller can suppress filing rather than risk a blind duplicate.
 */
async function readIssues({ filer, forgeCli, cwd, jira, config }) {
  let openIssues = []
  let existingIssues = []
  let trackerReadFailed = false
  if (filer === 'forge' && forgeCli) {
    const listed = await listForgeIssues({ cli: forgeCli, cwd })
    trackerReadFailed = !listed.ok
    existingIssues = listed.issues
    if (config.sources?.openIssues !== false) openIssues = existingIssues.filter(i => i.state === 'open')
  } else if (filer === 'jira' && jira) {
    const listed = await listJiraIssues({ instanceId: jira.instanceId, projectKey: jira.projectKey })
    trackerReadFailed = !listed.ok
    existingIssues = listed.issues
    if (config.sources?.openIssues !== false) openIssues = existingIssues.filter(i => i.state === 'open')
  } else if (filer === 'plan' && cwd) {
    const planContent = await tryReadFile(join(cwd, 'PLAN.md'))
    // extractPlanSlugs preserves each tag's checkbox state ({ slug, state }): a
    // `- [x]` item reads 'closed' (with no closedAt) so the outcome loop can
    // reconcile it, and it stays PERMANENTLY within the dedup window — a completed
    // plan item never needs re-proposal (#2620) — while `- [ ]` stays open.
    existingIssues = extractPlanSlugs(planContent || '')
  }
  return { openIssues, existingIssues, trackerReadFailed }
}

/**
 * The completion contract appended to the reasoning prompt: the agent must NOT
 * write code or open a PR (its worktree is discarded anyway) — it reasons and
 * writes its structured result to the `.agent-done` sentinel so the
 * processTaskOutput hook can file it. `payload` is the exact reasoner-JSON shape
 * buildPrompt already documents.
 */
function buildCompletionContract() {
  return [
    '',
    '---',
    '',
    '## How to finish',
    '',
    'You are a REASONING agent, not a coding agent. Do NOT edit code, run `/do:pr`,',
    'commit, or open a pull request — any changes you make to this worktree are',
    'discarded. Your ONLY output is the JSON described above.',
    '',
    'When you have decided, write a file named `.agent-done` in the current',
    'directory containing a single JSON object with this shape:',
    '',
    '```json',
    '{ "summary": "<one-line human summary of what you proposed, or that you proposed nothing>",',
    '  "payload": <the exact JSON object described above> }',
    '```',
    '',
    'The file MUST contain ONLY that raw JSON object — no ``` fences, no prose',
    'before or after it, and every newline inside a string value escaped as \\n.',
    '',
    'Then stop. Do nothing else.'
  ].join('\n')
}

/**
 * Pre-agent GATHER hook. Resolves context, skips a parked/unfileable app, gathers
 * sources + open issues, and returns the fully-rendered reasoning prompt for the
 * agent. `{ skip: { reason } }` short-circuits dispatch (no agent spawned).
 */
export async function buildTaskInput({ app } = {}) {
  if (!app) return { skip: { reason: 'no-app' } }
  const ctx = await resolveLiContext(app)
  const { isPortos, config, tracker, filer, forgeCli, cwd, jira } = ctx

  // A skip means no agent spawns, so processTaskOutput never records the run —
  // record the last-run outcome HERE (mirrors the old handler's settle()) so the
  // Intelligence tab's "Last run: parked / skipped" explanation stays accurate.
  const skip = async (action, reason) => {
    await recordRun(app, { action, reason })
    return { skip: { reason } }
  }

  // Resolve LI's reasoning-agent provider/model in one place (per-app → schedule
  // pin → default, with the api-only self-heal). The resolver is the single source
  // of truth: its `{ providerId, model }` flows out as this hook's return so the
  // spawn path pins the agent to the fully-resolved choice.
  const agent = await resolveLiAgentProvider(app, config)
  if (agent.skipReason) return skip('skipped', agent.skipReason)

  // A jira-tracked app with no usable instance/project can't file — skip before
  // burning an agent on a result we couldn't land.
  if (filer === 'jira' && !jira) return skip('skipped', 'jira-not-configured')

  // Park check (forge + jira; plan has no issue to block on). A FAILED read is not
  // "no blocking issues" — skip rather than resume work the user parked.
  if (trackerSupportsPause(tracker.resolved)) {
    const blocking = filer === 'jira'
      ? await listJiraBlockingIssues({ instanceId: jira.instanceId, projectKey: jira.projectKey })
      : (forgeCli ? await listBlockingIssues({ cli: forgeCli, cwd }) : null)
    if (blocking && !blocking.ok) return skip('skipped', 'blocking-read-failed')
    if (blocking && isAppParked(blocking.issues)) return skip('parked', 'blocking-open')
  }

  // Independent reads (app source set vs the tracker's open-issue list) — overlap
  // them so the non-parked path pays one round-trip, not two.
  const [sources, issuesRead] = await Promise.all([
    gatherSources(app, config),
    readIssues({ filer, forgeCli, cwd, jira, config })
  ])
  const { openIssues, existingIssues, trackerReadFailed } = issuesRead

  // Feedback loop (#2428): reconcile past proposals' outcomes against the fresh
  // tracker read, then fold the merge-rate report into the prompt so the reasoner
  // calibrates on its own history. Gated on the per-app `outcomes` source toggle
  // AND an outcomes-capable tracker (forge / jira / plan — #2435 taught the plan
  // parse to read a checked `- [x]` item as closed). A failed tracker read skips
  // reconciliation (never mark closed on a blind read).
  let outcomesReport = ''
  if (config.sources?.outcomes && outcomesTrackerSupported(filer)) {
    if (!trackerReadFailed) await reconcileOutcomes({ appId: app.id, existingIssues })
    const outcomes = await listOutcomes({ appId: app.id })
    outcomesReport = computeOutcomesReport({ outcomes })
  }

  const prompt = buildPrompt({ app, config, sources, openIssues, isPortos, outcomesReport }) + buildCompletionContract()
  // Option A: surface the fully-resolved LI agent provider/model (from
  // resolveLiAgentProvider — per-app override, else the resolved schedule pin) so
  // the generator pins the AGENT to it. Resolving the pin HERE (not delegating it
  // to the generator's interval.providerId) keeps this hook the single source of
  // truth for LI's provider.
  return { prompt, providerId: agent.providerId, model: agent.model }
}

/**
 * File the proposal via the resolved tracker's filer (forge / jira / plan).
 */
async function fileProposal({ filer, forgeCli, cwd, app, proposal, jira }) {
  if (filer === 'forge' && forgeCli) {
    return fileProposalToForge({ cli: forgeCli, cwd, title: proposal.title, body: proposal.body, slug: proposal.slug })
  }
  if (filer === 'jira' && jira) {
    return fileProposalToJira({
      instanceId: jira.instanceId, projectKey: jira.projectKey, issueType: jira.issueType,
      title: proposal.title, body: proposal.body, slug: proposal.slug
    })
  }
  if (filer === 'plan' && cwd) {
    const res = await appendProposalToPlan({ repoPath: cwd, appName: app.name, slug: proposal.slug, title: proposal.title, body: proposal.body })
    // Propagate `duplicate`: appendProposalToPlan dedups on the raw `[lil-<slug>]`
    // tag regardless of checkbox, so a CHECKED item the reasoner re-proposed (now
    // out of the dedup window, #2435) writes nothing and returns duplicate. The
    // caller must NOT treat that as a fresh file — see processTaskOutput.
    return { success: res.success, number: null, duplicate: res.duplicate }
  }
  return { success: false, error: `filer "${filer}" not implemented` }
}

/** Semantic near-duplicate check (embedding similarity), best-effort. */
async function isSemanticDuplicate(app, proposal, existingIssues, now) {
  const semantic = await checkSemanticDuplicate({ proposal, existingIssues, now })
  if (!semantic.available || !semantic.duplicate) return false
  const m = semantic.match
  const ref = m?.number != null
    ? (typeof m.number === 'number' ? `#${m.number}` : String(m.number))
    : (m?.slug || 'an existing issue')
  const score = typeof m?.score === 'number' ? m.score.toFixed(2) : '?'
  console.log(`♻️ Layered Intelligence: ${app.name} proposal "${proposal.slug}" is a near-duplicate of ${ref} (score ${score}) — suppressed`)
  return true
}

/** The user-facing ref for a filed proposal (Jira key, else `#<number>`, else null). */
function filedRef(key, number) {
  return key || (number != null ? `#${number}` : null)
}

/**
 * Persist per-app run bookkeeping — run cadence AND the last run's OUTCOME.
 * Re-reads the current stored config and merges only these fields so a mid-run
 * user config edit isn't clobbered.
 */
async function recordRun(app, outcome = {}) {
  const patch = {
    lastRunAt: new Date().toISOString(),
    lastRunAction: outcome.action ?? null,
    lastRunReason: outcome.reason ?? null,
    lastRunRef: filedRef(outcome.filedKey, outcome.filedNumber)
  }
  await updateAppLayeredIntelligence(app.id, patch).catch((err) => {
    console.error(`❌ Layered Intelligence: failed to record run for ${app.id}: ${err.message}`)
  })
}

/** Default hand-off enqueue: an approval-gated internal CoS task for a coding agent. */
async function defaultEnqueueHandoff(taskData) {
  const { addTask } = await import('../cos.js')
  return addTask(taskData, 'internal')
}

/**
 * Post-agent DECIDE + ACT hook. Validates the agent's `.agent-done` payload
 * (the reasoner JSON), scope-gates, dedups against a FRESH tracker read, files
 * exactly one issue, applies a pause, optionally hands the proposal to a coding
 * agent, and records the run. Every terminal path records an outcome so the UI's
 * last-run status matches what happened. Injectable deps for tests.
 */
export async function processTaskOutput({ appId, success, payload, agentId } = {}, deps = {}) {
  const { enqueueHandoff = defaultEnqueueHandoff, now = Date.now() } = deps
  if (!appId) return { action: 'no-op', reason: 'no-app' }
  const app = await getAppById(appId).catch(() => null)
  if (!app) return { action: 'no-op', reason: 'app-not-found' }

  const settle = async (outcome) => {
    await recordRun(app, outcome)
    return { app: app.id, ...outcome }
  }

  // A failed/aborted agent produced no trustworthy reasoning — record and stop.
  if (success === false) return settle({ action: 'no-op', reason: 'agent-failed' })

  const ctx = await resolveLiContext(app)
  const { isPortos, config, tracker, filer, forgeCli, cwd, jira } = ctx

  // The payload IS the reasoner's JSON object (parsed from the sentinel). A null/
  // malformed payload is the "returned nothing usable" case.
  const { proposal, pause } = validateReasonerResponse(
    payload && typeof payload === 'object' ? payload : null
  )

  // Re-read issues NOW (not at gather time) so dedup sees the freshest tracker
  // state — the agent may have run for minutes.
  const { existingIssues, trackerReadFailed } = await readIssues({ filer, forgeCli, cwd, jira, config })

  let filedNumber = null
  let filedKey = null
  let filedAction = 'no-op'
  let reason = payload == null ? 'unparseable-response' : 'no-proposal'
  let handedOff = false

  if (proposal) {
    const scopeOk = isScopeAllowed({ scope: proposal.scope, allowedScopes: config.allowedScopes, isPortos })
    if (!scopeOk) {
      console.log(`🚫 Layered Intelligence: ${app.name} proposal scope "${proposal.scope}" not allowed — suppressed`)
      reason = 'scope-suppressed'
    } else if (trackerReadFailed) {
      console.warn(`⚠️ Layered Intelligence: ${app.name} tracker read failed — suppressing proposal to avoid a blind duplicate`)
      filedAction = 'tracker-read-failed'
      reason = 'tracker-read-failed'
    } else if (isProposalDuplicate({ slug: proposal.slug, existingIssues, now })) {
      console.log(`♻️ Layered Intelligence: ${app.name} proposal "${proposal.slug}" is a duplicate — suppressed`)
      filedAction = 'duplicate'
      reason = 'duplicate'
    } else if (await isSemanticDuplicate(app, proposal, existingIssues, now)) {
      filedAction = 'semantic-duplicate'
      reason = 'semantic-duplicate'
    } else {
      const filed = await fileProposal({ filer, forgeCli, cwd, app, proposal, jira })
      if (filed.success && filed.duplicate) {
        // The tracker already carries this slug's tag (a checked PLAN item the
        // reasoner re-proposed): appendProposalToPlan wrote nothing. Report a
        // duplicate and leave any recorded outcome untouched — reporting `filed`
        // here would clear the merged outcome and let the still-checked item
        // reconcile as a false fresh merge on the next run (#2435).
        filedAction = 'duplicate'
        reason = 'duplicate'
        console.log(`♻️ Layered Intelligence: ${app.name} proposal "${proposal.slug}" already tracked in PLAN.md — suppressed`)
      } else if (filed.success) {
        filedNumber = filed.number ?? null
        filedKey = filed.key ?? null
        filedAction = 'filed'
        reason = null
        const ref = filedRef(filedKey, filedNumber) ?? ''
        console.log(`📌 Layered Intelligence: ${app.name} filed "${proposal.title}" [${proposal.slug}]${ref ? ` (${ref})` : ''}`)
        // Feedback loop (#2428): remember what we just filed so a later run can
        // read back its outcome. Gated on the app's `outcomes` source toggle AND
        // an outcomes-capable tracker (forge / jira / plan — a checked `- [x]`
        // PLAN item now reconciles, #2435).
        if (config.sources?.outcomes && outcomesTrackerSupported(filer)) {
          await recordFiledProposal({
            appId: app.id, slug: proposal.slug, tracker: tracker.resolved,
            issueRef: filedRef(filedKey, filedNumber), scope: proposal.scope
          })
        }
        const issueRef = filedKey || filedNumber
        if (isHandoffEligible({ proposal, config, filed: issueRef })) {
          const task = await enqueueHandoff(buildHandoffTask({ app, proposal, issueRef }))
            .catch((err) => { console.error(`❌ Layered Intelligence: ${app.name} hand-off enqueue failed: ${err.message}`); return null })
          if (task && !task.duplicate) {
            handedOff = true
            console.log(`🤝 Layered Intelligence: ${app.name} handed off ${ref} to a coding agent (task ${task.id})`)
          }
        }
      } else {
        console.error(`❌ Layered Intelligence: ${app.name} failed to file proposal: ${filed.error || 'unknown'}`)
        reason = 'file-failed'
      }
    }
  }

  // Pause (forge + jira; resolve blockOnIssue after filing).
  let paused = false
  if (pause && filer === 'forge' && forgeCli) {
    const number = resolveBlockOnIssue(pause, filedNumber)
    if (Number.isInteger(number)) {
      const res = await applyBlockingLabel({ cli: forgeCli, cwd, number })
      paused = res.success
      if (paused) console.log(`⏸️ Layered Intelligence: ${app.name} paused on #${number} — ${pause.reason}`)
    }
  } else if (pause && filer === 'jira' && jira) {
    const key = resolveJiraBlockKey(pause, filedKey, jira.projectKey)
    if (key) {
      const res = await applyJiraBlockingLabel({ instanceId: jira.instanceId, key })
      paused = res.success
      if (paused) console.log(`⏸️ Layered Intelligence: ${app.name} paused on ${key} — ${pause.reason}`)
    }
  }

  return settle({ action: filedAction, reason, filedNumber, filedKey, paused, handedOff })
}
