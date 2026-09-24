/**
 * One-form scheduling of a managed app's quality audits.
 *
 * Three questions the Quality tab's schedule form needs answered, and the
 * write that acts on them:
 *
 *   1. WHICH audits are worth running here — an app with no user interface
 *      should not burn a weekly provider call on an accessibility audit.
 *   2. WHEN is already spoken for — the app's own release job, its reconcile
 *      drains, and every other cron-scheduled task, so a newly planned audit
 *      does not run inside a release window.
 *   3. WHAT does the resulting week look like — computed by the pure planner in
 *      `lib/qualitySchedulePlan.js`, previewed before anything is saved.
 *
 * The write itself goes through `updateAppTaskTypeOverrides`, the same path the
 * Schedule page uses, so a plan produces ordinary per-app overrides a user can
 * afterwards edit or delete one at a time.
 */

import { readdir } from 'fs/promises';
import { execGit } from '../lib/execGit.js';
import { query } from '../lib/db.js';
import {
  AUDIT_CAPABILITY_MISSING_REASON,
  AUDIT_DEFINITIONS,
  AUDIT_REPO_CAPABILITIES,
  AUDIT_TASK_TYPE_LIST,
  normalizeAuditTaskType,
  auditCapabilityRequirement,
} from '../lib/auditCatalog.js';
import {
  CLAIM_DRAIN_TASK_TYPES,
  buildBusySlots,
  isPlannedClaimCron,
  planQualitySchedule,
  resolveQualityScheduleOptions,
} from '../lib/qualitySchedulePlan.js';
import { cronWeekdayHours } from '../lib/cronFields.js';
import { AUDIT_FRESHNESS_MS } from '../lib/auditQuality.js';
import { getAppById, getAppTaskTypeOverrides, updateAppTaskTypeOverrides } from './apps.js';
import { loadSchedule } from './taskScheduleStore.js';
import { INTERVAL_TYPES, decodeIntervalType, isCronExpression } from './taskScheduleConstants.js';
import { INSTALL_WIDE_TASK_TYPES } from '../lib/taskTargetScope.js';

/** Paths that describe the repository's own shape rather than its sources. */
const VENDOR_SEGMENTS = /(^|\/)(node_modules|vendor|dist|build|out|coverage|\.venv|third_party|__pycache__)(\/|$)/;

// Keyed by AUDIT_REPO_CAPABILITIES — the catalog names the shape an audit
// requires, this table is how that shape is recognized in a checkout. The
// coverage guard below fails if the two ever disagree.
const CAPABILITY_PATTERNS = {
  ui: [/\.(jsx|tsx|vue|svelte|astro)$/i, /\.(html|htm)$/i, /\.(css|scss|sass|less)$/i, /\.storyboard$/i, /\.xib$/i],
  typescript: [/\.(ts|tsx|mts|cts)$/i, /(^|\/)tsconfig(\.\w+)?\.json$/i],
  tests: [/\.(test|spec)\.[cm]?[jt]sx?$/i, /(^|\/)tests?\//i, /(^|\/)__tests__\//i, /(^|\/)test_[^/]+\.py$/i, /[^/]+_test\.(py|go|rb)$/i, /Tests\.swift$/i],
  dependencies: [/(^|\/)package\.json$/i, /(^|\/)requirements[^/]*\.txt$/i, /(^|\/)pyproject\.toml$/i, /(^|\/)Cargo\.toml$/i, /(^|\/)go\.mod$/i, /(^|\/)Gemfile$/i, /(^|\/)composer\.json$/i, /(^|\/)Package\.swift$/i, /(^|\/)pubspec\.yaml$/i],
  api: [/(^|\/)(routes?|api|controllers|handlers|endpoints)\//i, /\.proto$/i, /(^|\/)openapi[^/]*\.(ya?ml|json)$/i, /(^|\/)swagger[^/]*\.(ya?ml|json)$/i, /(^|\/)urls\.py$/i],
  // Deployment described in the repository: IaC, containers and orchestration,
  // platform manifests, process managers, and CI pipelines (a CI workflow is a
  // deployment surface with its own supply-chain risk).
  infrastructure: [
    /\.(tf|tfvars|bicep)$/i, /(^|\/)(terraform|pulumi|cdk|k8s|kubernetes|helm|charts|ansible|infra|infrastructure|deploy|deployment)\//i,
    /(^|\/)(Dockerfile|Containerfile)[^/]*$/i, /(^|\/)(docker-)?compose[^/]*\.ya?ml$/i, /(^|\/)Chart\.yaml$/, /(^|\/)(Pulumi|serverless)[^/]*\.ya?ml$/i,
    /(^|\/)(cdk|vercel|firebase)\.json$/i, /(^|\/)(fly|netlify|wrangler)\.toml$/i, /(^|\/)(Procfile|Jenkinsfile)$/, /(^|\/)ecosystem\.config\.[cm]?js$/i,
    /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i, /(^|\/)\.gitlab-ci\.ya?ml$/i, /(^|\/)\.circleci\//i, /(^|\/)azure-pipelines\.ya?ml$/i, /(^|\/)cloudformation\//i,
  ],
};

/**
 * Repository shape changes on the scale of commits, not keystrokes, and the
 * schedule form re-previews on every control change — each of which would
 * otherwise re-run `git ls-files` over the whole checkout. A short TTL keeps
 * the form responsive while still noticing a repo that gained a test suite.
 */
const CAPABILITY_TTL_MS = 60 * 1000;
const capabilityCache = new Map();

const missingPatterns = AUDIT_REPO_CAPABILITIES.filter(capability => !CAPABILITY_PATTERNS[capability]);
if (missingPatterns.length) {
  throw new Error(`No repository detection for audit capability: ${missingPatterns.join(', ')}`);
}

/**
 * List the repository's tracked files. `git ls-files` is the cheap, honest
 * inventory — it already excludes ignored build output and dependency trees,
 * which a directory walk would have to re-derive. A non-repository (or a git
 * failure) falls back to the top two directory levels, enough to see a
 * `package.json` and a `client/` without walking a whole tree.
 */
async function listRepoFiles(repoPath) {
  const result = await execGit(['ls-files'], repoPath, { timeout: 20000, ignoreExitCode: true })
    .catch(() => null);
  if (result?.exitCode === 0 && result.stdout.trim()) {
    return { files: result.stdout.split('\n').map(line => line.trim()).filter(Boolean), complete: true };
  }
  const entries = await readdir(repoPath, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) { files.push(entry.name); continue; }
    const nested = await readdir(`${repoPath}/${entry.name}`, { withFileTypes: true }).catch(() => []);
    files.push(entry.name + '/');
    for (const child of nested) files.push(`${entry.name}/${child.name}${child.isDirectory() ? '/' : ''}`);
  }
  // `complete: false` on purpose — this listing stops at depth 2, so a miss is
  // "not looked at", never "not there".
  return { files, complete: false };
}

/**
 * Which repository shapes this app has, from its tracked files.
 *
 * `detected: false` on every capability with `scanned: 0` means the repository
 * could not be read at all — a caller must treat that as "unknown", never as
 * "this app has no tests", which is why the count is returned alongside.
 *
 * @param {object} app - The managed app record (needs `repoPath`, optionally `uiPort`)
 * @returns {Promise<{ capabilities: Record<string, boolean>, scanned: number }>}
 */
export async function detectRepoCapabilities(app) {
  const empty = Object.fromEntries(AUDIT_REPO_CAPABILITIES.map(key => [key, false]));
  if (!app?.repoPath) return { capabilities: empty, scanned: 0, complete: false };

  const cached = capabilityCache.get(app.repoPath);
  const scan = cached && Date.now() - cached.at < CAPABILITY_TTL_MS
    ? cached.value
    : await scanRepoCapabilities(app.repoPath);
  if (scan !== cached?.value) capabilityCache.set(app.repoPath, { at: Date.now(), value: scan });

  // `uiPort` is a property of the APP, not of the checkout, and two apps can
  // share one repoPath — so it is OR'd in AFTER the (path-keyed) cache read.
  // A compiled or templated front end leaves no .jsx behind, but a served UI
  // port is direct evidence there is an interface to audit.
  const capabilities = { ...scan.capabilities, ui: scan.capabilities.ui || Boolean(app.uiPort) };
  return { capabilities, scanned: scan.scanned, complete: scan.complete || Boolean(app.uiPort) };
}

/** The file-derived half of the verdict — cacheable because it is per-checkout. */
async function scanRepoCapabilities(repoPath) {
  const capabilities = Object.fromEntries(AUDIT_REPO_CAPABILITIES.map(key => [key, false]));
  const { files, complete } = await listRepoFiles(repoPath);
  const scanned = files.filter(path => !VENDOR_SEGMENTS.test(path));
  for (const path of scanned) {
    for (const [capability, patterns] of Object.entries(CAPABILITY_PATTERNS)) {
      if (!capabilities[capability] && patterns.some(pattern => pattern.test(path))) capabilities[capability] = true;
    }
  }
  return { capabilities, scanned: scanned.length, complete: complete && scanned.length > 0 };
}

/**
 * Categories a recent audit of THIS app reported as not applicable. The auditing
 * agent inspected the repository, so its ruling outranks the path heuristics
 * above — but only while it is fresh: a repository that later gains a UI or a
 * deployment manifest must get the audit back, so a ruling older than the
 * quality freshness window (the same 30 days after which a score goes stale)
 * no longer counts. Read directly rather than through `enrichAppsWithQuality`,
 * which also fans out to sync peers — a peer's view of a different checkout is
 * not evidence about this one.
 */
async function loadNotApplicableCategories(appId, now = Date.now()) {
  const result = await query(
    `SELECT DISTINCT ON (category) category, assessed_at, report FROM app_quality_measurements
     WHERE app_id = $1 ORDER BY category, assessed_at DESC, agent_id DESC`,
    [appId]
  ).catch(() => null);
  if (!result) return new Set();
  return new Set(result.rows.filter(row => row.report?.coverage === 'not-applicable'
    && now - Date.parse(row.assessed_at) <= AUDIT_FRESHNESS_MS)
    .map(row => normalizeAuditTaskType(row.category)));
}

/**
 * Every quality check with its applicability verdict and current schedule.
 *
 * Applicability is ADVISORY: the form pre-selects what applies and explains
 * what it skipped, but a user who disagrees can still select a skipped check.
 *
 * @param {object} app - The managed app record
 * @returns {Promise<{ checks: object[], capabilities: object, scanned: number }>}
 */
export async function resolveQualityChecks(app) {
  const [{ capabilities, scanned, complete }, notApplicable] = await Promise.all([
    detectRepoCapabilities(app),
    loadNotApplicableCategories(app.id),
  ]);
  // Only a COMPLETE inventory licenses a negative. An unreadable path scans
  // nothing, and the shallow fallback stops at depth 2 — in both cases a
  // capability reads false for want of evidence, and gating on that would
  // deselect most of the catalog over a repository nobody actually looked at.

  const checks = AUDIT_TASK_TYPE_LIST.map(taskType => {
    const requirement = auditCapabilityRequirement(taskType);
    let applicable = true;
    let reason = null;
    if (notApplicable.has(taskType)) {
      applicable = false;
      reason = 'a previous audit reported this category as not applicable here';
    } else if (requirement && complete && !capabilities[requirement]) {
      applicable = false;
      reason = AUDIT_CAPABILITY_MISSING_REASON[requirement];
    }
    return { taskType, label: AUDIT_DEFINITIONS[taskType].label, applicable, reason };
  });
  return { checks, capabilities, scanned, complete };
}

/**
 * Whether ONE audit is worth dispatching for this app — the programmatic
 * bail-out every dispatch lane consults before an agent is spawned, so a
 * mobile-responsive audit of a repository with no client code costs a
 * `git ls-files` (cached) instead of a provider call. Same verdict as the
 * schedule form's, by construction: both read `resolveQualityChecks`.
 *
 * Non-audit task types and apps with no checkout always apply — the gate only
 * ever REMOVES work it has evidence against.
 *
 * @param {object} app - The managed app record
 * @param {string} taskType - Scheduled task type
 * @returns {Promise<{ applicable: boolean, reason: string|null }>}
 */
export async function resolveAuditApplicability(app, taskType) {
  const category = normalizeAuditTaskType(taskType);
  if (!app?.id || !app.repoPath || !Object.hasOwn(AUDIT_DEFINITIONS, category)) return { applicable: true, reason: null };
  const { checks } = await resolveQualityChecks(app);
  const check = checks.find(entry => entry.taskType === category);
  return { applicable: check?.applicable !== false, reason: check?.reason || null };
}

/**
 * Every category this app's repository cannot have findings for, as
 * `{ [category]: reason }` — the shape `summarizeAppQuality` takes, so the
 * Quality tab's denominator and runner agree with the dispatch gate.
 *
 * @param {object} app - The managed app record
 * @returns {Promise<Record<string, string>>}
 */
export async function inapplicableAuditReasons(app) {
  const { checks } = await resolveQualityChecks(app);
  return Object.fromEntries(checks.filter(check => !check.applicable).map(check => [check.taskType, check.reason]));
}

/**
 * The same verdict keyed by app id, for the sequencing lanes (maintenance runs,
 * quota-burn steps) that hold an id rather than a record. Returns WHY the audit
 * does not apply, or null when it does — or when that cannot be determined, so
 * an unreadable app or a failed detection never blocks work.
 *
 * @param {string|null} appId - Managed app id
 * @param {string} taskType - Scheduled task type
 * @returns {Promise<string|null>}
 */
export async function inapplicableAuditReason(appId, taskType) {
  if (!appId || !Object.hasOwn(AUDIT_DEFINITIONS, normalizeAuditTaskType(taskType))) return null;
  // `.then` rather than a direct call, so even a synchronous throw from the
  // app lookup lands in the fail-open catch instead of the caller's lane.
  const verdict = await Promise.resolve(appId).then(id => getAppById(id))
    .then(app => (app ? resolveAuditApplicability(app, taskType) : null))
    .catch(() => null);
  return verdict && !verdict.applicable ? verdict.reason || 'not applicable to this repository' : null;
}

/**
 * The weekday/hour cells already claimed by something else on this app.
 *
 * Reads cadence the way `shouldRunTask` does: a task runs for this app when it
 * is enabled here (or is install-wide), and a per-app `interval` REPLACES the
 * global cadence rather than adding to it. A retired named cadence written by
 * an older install is decoded first, so a `weekly` override occupies its hour
 * instead of being read as "no cadence" and scheduled straight over.
 *
 * The types the plan is about to rewrite are excluded — otherwise re-running
 * the form would treat last week's plan as an obstacle to this week's.
 *
 * @param {object} app - The managed app record
 * @param {{ ignoreTaskTypes?: string[] }} [options]
 * @returns {Promise<object[]>} One entry per occupying cron: `{ taskType, cron, origin, days, hours }`
 */
export async function collectBusyOccupancies(app, { ignoreTaskTypes = [] } = {}) {
  const ignore = new Set(ignoreTaskTypes);
  const [schedule, overrides] = await Promise.all([loadSchedule(), getAppTaskTypeOverrides(app.id)]);
  const sources = [];

  const add = (taskType, cron, origin) => {
    if (!isCronExpression(cron)) return;
    const occupancy = cronWeekdayHours(cron);
    if (occupancy) sources.push({ taskType, cron, origin, ...occupancy });
  };

  for (const [taskType, config] of Object.entries(schedule.tasks || {})) {
    const override = overrides[taskType];
    if (ignore.has(taskType) || config.enabled === false) continue;
    if (!INSTALL_WIDE_TASK_TYPES.has(taskType) && override?.enabled !== true) continue;

    const perApp = override?.interval
      ? decodeIntervalType(override.interval, { intervalMs: override.intervalMs })
      : null;
    if (perApp) {
      if (perApp.type === INTERVAL_TYPES.CRON) add(taskType, perApp.cronExpression, 'app');
    } else if (config.type === INTERVAL_TYPES.CRON) {
      add(taskType, config.cronExpression, 'global');
    }
    // `perpetual` is a task-level global property: a per-app row overrides the
    // cadence only, so the recheck window applies either way.
    if (config.perpetual) add(taskType, config.recheckCron, 'recheck');
  }
  return sources;
}

/**
 * Plan the week for one app without writing anything.
 *
 * Returns the whole payload the three quality-schedule endpoints serve, so the
 * route layer adds nothing of its own and cannot drift from the service.
 *
 * @param {object} app - The managed app record
 * @param {object} [options] - Form options; `taskTypes` defaults to every applicable check
 * @returns {Promise<object>} `{ appId, appName, plan, checks, capabilities, scanned, busySources, claimTaskTypes }`
 */
export async function buildQualitySchedulePlan(app, options = {}) {
  const settings = resolveQualityScheduleOptions(options);
  // Independent: the repository scan and the schedule read share no input.
  const [{ checks, capabilities, scanned, complete }, sources] = await Promise.all([
    resolveQualityChecks(app),
    collectBusyOccupancies(app, { ignoreTaskTypes: [...AUDIT_TASK_TYPE_LIST, ...CLAIM_DRAIN_TASK_TYPES] }),
  ]);

  const requested = Array.isArray(options.taskTypes) ? options.taskTypes : null;
  const taskTypes = requested ?? checks.filter(check => check.applicable).map(check => check.taskType);

  const plan = planQualitySchedule({
    taskTypes,
    fileIssuesByType: options.fileIssuesByType || {},
    busy: buildBusySlots(sources, settings),
    options: settings,
  });
  return {
    appId: app.id,
    appName: app.name,
    plan,
    checks,
    capabilities,
    scanned,
    complete,
    // The drain types the form may choose between, so adding one here does not
    // also need a client edit.
    claimTaskTypes: CLAIM_DRAIN_TASK_TYPES,
    // What the plan worked around, so the preview can say WHY 03:00 is missing.
    busySources: sources.map(({ taskType, cron, origin }) => ({ taskType, cron, origin })),
  };
}

/**
 * Apply a plan: one per-app override per scheduled check, plus the claim drain.
 *
 * Checks the user left out are DISABLED rather than left alone — the form is
 * the whole picture of the app's quality cadence, so an audit dropped from the
 * selection must stop running. Only the audit types and the claim drain are
 * touched; every other task type the app has configured is left exactly as it is.
 *
 * @param {object} app - The managed app record
 * @param {object} [options] - The same option bag `buildQualitySchedulePlan` takes
 * @returns {Promise<object>} The built plan plus `{ applied, disabled }` counts
 */
export async function applyQualitySchedulePlan(app, options = {}) {
  const built = await buildQualitySchedulePlan(app, options);
  const { plan } = built;
  const scheduled = new Map(plan.slots.map(slot => [slot.taskType, slot]));
  const existing = await getAppTaskTypeOverrides(app.id);

  const inapplicable = new Set(built.checks.filter(check => !check.applicable).map(check => check.taskType));
  const patches = {};
  for (const taskType of AUDIT_TASK_TYPE_LIST) {
    const slot = scheduled.get(taskType);
    // A check the user selected although it was marked not applicable is an
    // explicit override: record it so the scheduled lane's applicability gate
    // runs it instead of skipping it. Cleared again once the check applies.
    const { runInapplicableAudit: _previousOverride, ...storedMetadata } = existing[taskType]?.taskMetadata || {};
    patches[taskType] = slot
      // Merge rather than replace: the stored metadata may carry a provider
      // pin or reviewer choice the user set on the Schedule page, and the plan
      // only has an opinion about the delivery mode.
      ? { enabled: true, interval: slot.cron, taskMetadata: { ...storedMetadata, fileIssues: slot.fileIssues, ...(inapplicable.has(taskType) ? { runInapplicableAudit: true } : {}) } }
      // Clearing the interval alongside `enabled: false` keeps a stale cron
      // from reviving on the next manual enable.
      : { enabled: false, interval: null };
  }
  if (plan.claim) patches[plan.claim.taskType] = { enabled: true, interval: plan.claim.cron };
  // Retire a drain an earlier plan planted. Without this, switching the drain
  // type leaves BOTH running daily, and "Do not run a claim job" leaves the old
  // one firing forever — the form would offer no way to undo what it created.
  // Only a cron of this planner's own shape is cleared (`isPlannedClaimCron`),
  // so a claim cadence a human set by hand on the Schedule page survives.
  for (const taskType of CLAIM_DRAIN_TASK_TYPES) {
    if (taskType === plan.claim?.taskType) continue;
    if (!isPlannedClaimCron(existing[taskType]?.interval)) continue;
    patches[taskType] = { enabled: false, interval: null };
  }

  await updateAppTaskTypeOverrides(app.id, patches);
  const applied = Object.values(patches).filter(patch => patch.enabled).length;
  const disabled = Object.values(patches).length - applied;
  console.log(`📅 Planned ${applied} quality schedule entries for ${app.name} (${disabled} checks disabled)`);
  return { ...built, applied, disabled };
}
