/**
 * Audit quality helpers: category discovery strategies, slice-scored assessment prompt, v1/v2 report
 * schema, sentinel parsing, and per-category rolling app quality aggregation.
 *
 * Category discovery strategies, slice-scored assessment prompt and v1/v2 report schema, sentinel
 * parsing, and freshness-aware app quality aggregation: per-category rolling window of recent run
 * scores across local, peer and snapshot evidence.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { CONSOLIDATED_AUDIT_DOMAINS, MAX_AUDIT_SLICE_CHARS, QUALITY_HEALTHY_THRESHOLD, QUALITY_SCORE_BANDS, QUALITY_RECENCY_HALF_LIFE_DAYS, auditDomainFor, isPriorityExemptAuditType } from './auditDomains.js';
import { AUDIT_DEFINITIONS, isAuditTaskType, normalizeAuditTaskType } from './auditCatalog.js';
import { safeJSONParse } from './jsonIo.js';

const REPORT_PREFIX = 'QUALITY_AUDIT_JSON: ';
const SLICE_PREFIX = 'AUDIT_SLICE: ';
export const MAX_SLICE_CHARS = MAX_AUDIT_SLICE_CHARS;
export const BROAD_COVERAGE_MIN_RATIO = 0.95;
const broadCoverageMinPercent = BROAD_COVERAGE_MIN_RATIO * 100;

// Each lens must explain how to find candidates before choosing a slice.
const profileDiscovery = Object.freeze({
  security: 'Inventory trust boundaries, credential handling, process execution and input-to-sink paths; rank reachable exploit impact under the documented trust model.',
  'code-quality': 'Inventory source directories and convention violations; search brittle conditions, duplicated policy and magic values, ranking demonstrated defects and recurring maintenance cost.',
  'test-coverage': 'Map public routes, workflows and destructive actions to integration tests; rank untested high-impact outcomes, not uncovered line counts.',
  performance: 'Inventory hot routes, loops, queries and large payloads; use existing profiling or bounded measurements to rank latency, memory and repeated work.',
  accessibility: 'Inventory shared controls and screens; scan semantic roles, labels, focus and contrast, then verify the most reused controls and critical keyboard journeys.',
  documentation: 'Compare setup, upgrade and public API documentation against scripts and implementations; rank instructions that break installation or cause data loss first.',
  'app-bugs': 'Inventory server routes, background and scheduled jobs, imports and syncs; trace each against what its callers, docs and tests promise, ranking wrong results and silent no-ops on primary workflows and races a user or job of this app can trigger first.',
  'ui-bugs': 'Inventory routes and shared components; trace primary actions, loading/error/empty states and navigation, then reproduce the highest-reach broken workflows.',
  'mobile-responsive': 'Scan all layouts for fixed widths, grids, overflow and touch targets; test the most reused layouts and primary journeys at narrow widths.',
  'error-handling': 'Inventory external I/O and failure boundaries; search swallowed rejections and missing recovery, ranking data loss and stranded user operations first.',
  typing: 'Inventory unsafe casts, any, nullable values and external schemas; rank mismatches at public and persistence boundaries by reachable failure.',
  'console-errors': 'Inventory startup and critical routes, inspect available browser/server diagnostics, then reproduce recurring errors with the widest user impact.',
  design: 'Inventory rendered screens, shared media and controls, polished states and authored theme standards; rank observed composition defects, then rotate a bounded screenshot sample using recent audit slices.',
  ux: 'Inventory primary user goals and route flows; rank blocked task completion, onboarding friction, navigation dead ends and missing recovery, then walk the worst journeys.',
  'data-safety': 'Inventory destructive writes, migrations, backup/restore and cross-version payloads; rank irreversible data loss and incompatible upgrades first.',
  simplify: 'Scan source exports, callers and repeated blocks across the repository; rank proven dead subsystems and duplicated behavior by maintenance cost and drift.',
  'over-engineering': 'Inventory validation, recovery, archive, ledger, retry and verification layers, CI stages and local gates, and the docs that mandate them; for each, name the failure it demonstrably prevented (history, tests, incidents) and measure its time or maintenance cost. Rank by cost with no demonstrated harm.',
  'module-hygiene': 'Inventory module sizes, imports, responsibilities and catalogs across source roots; inspect the largest responsibility tangles and most reused missing abstractions.',
  'api-contract': 'Inventory all routes, schemas and clients; compare request/response and version contracts, prioritizing destructive writes and widely consumed APIs.',
  'ui-lifecycle': 'Identify the UI runtime, then scan resource lifetimes, subscriptions, async state updates and shared state across views; rank resource leaks, stale writes and corrupted user state.',
  observability: 'Inventory critical workflows and their failure/status signals; rank invisible data loss, silent failures and operations that cannot be diagnosed.',
  copy: 'Inventory shared messages, destructive confirmations, setup and empty/error screens; rank wording that causes wrong actions or prevents task completion.',
  'better-complexity': 'If the target repository has server/scripts/complexity-report.js, run npm run quality:complexity from its root and use its bounded source and test shortlists for investigation. Report its classic cyclomatic complexity counts as measured, including optional chains and default arguments; record scan failures and separately analyze first-party languages the report does not cover. If the command is absent or fails, use another language-aware complexity analyzer or repository-wide branching searches to shortlist functions and count decision points manually. Include the top measured functions and counts in the run narrative, not QUALITY_AUDIT_JSON; file length is only a discovery hint. A high count alone is not a finding.',
  'better-cognitive-load': 'Scan deeply nested control flow, boolean flags, mixed abstraction levels and misleading names across source roots; rank reader cost in critical, widely used workflows.',
  'better-structural-drift': 'Inventory generators, duplicated registries and derived artifacts; inspect independently edited sources of truth and position-keyed records, ranking demonstrated drift and merge churn.',
  'better-runtime-safety': 'Scan asynchronous callbacks, resource cleanup, nullable access and process lifecycles across source roots; rank reachable crashes, corrupted state and leaked resources.',
  'better-dependency-freedom': 'Inventory manifests and actual imports across packages; rank dependency cost, advisory exposure and removable surface against the complexity of a concrete replacement.',
  'better-test-quality': 'Inventory suites and public boundaries; search assertion-free tests, overmocking, tautologies and redundant cases, prioritizing suites that falsely protect critical behavior.',
  'better-dev-environment': 'Diff host state around one bounded run of the dev commands (see the mission), then inventory the fixture, spawn, watcher and cache sites behind each change; rank by what accumulates per run times how often the loop runs.',
  infrastructure: 'Inventory infrastructure-as-code, container, orchestration, deployment and CI files; scan exposure, identity grants, secrets, pinning, resource limits and probes, rank deployment risk alongside measured CI waste. Trace CI planners/runners; measure run frequency, job duration and critical path, then inspect trigger/path selection, duplicate work, dependencies, cache/artifact reuse, cancellation/concurrency and risk-based PR/MR versus merge/nightly/release placement. Coordinate test-value evidence with Test Quality; preserve essential correctness/security coverage.',
  'data-integrity': 'Inventory every durable user-record write path, ingestion entry point, consumer, batch/backfill job and stored data format (excluding ephemeral runtime state, git worktrees and caches); trace retry and redelivery behavior and multi-step writes, ranking silent duplication, loss and wrong results first.',
  reliability: 'Inventory process entry points, signal handling, health endpoints, queues, workers and scheduled jobs; trace startup, restart and overload behavior under the deployment model in the reachability check (for a single install, excluding multi-instance leases and shutdown job checkpointing for idempotent/regenerable work), ranking primary data corruption and outage amplification first.',
  privacy: 'Inventory personal and sensitive fields in schemas and payloads, then trace them to logs, errors, analytics, caches, exports, third-party calls and deletion paths; rank exposure already happening over missing governance.',
  'feature-completeness': 'Scan for not-implemented/501/placeholder returns, permanently disabled or "coming soon" controls, settings written but never read, endpoints and jobs with no caller, server events with no listener, and to-do references to missing or closed tracker items; trace each to the control or document that offers it, ranking what users are offered today over internal gaps.',
  'workflow-recovery': 'Inventory persisted server-side in-progress states for long-running, multi-minute or paid user generation workflows (excluding short request-bound operations, git worktree cleanup and in-memory re-entrancy guards) and the client chains that drive them; trace each state to the page that must show it and its resume/cancel/reattach exit, ranking user records left blocked with no visible exit first.',
  'upgrade-rehearsal': 'Inventory migrations, seeds, the migration runner and its ledger, and the backup/restore path; build scratch installs from the fixture shapes the migration tests carry and execute upgrade, restore and boot against them, ranking a migration or restore that fails or silently no-ops on a real older shape first.',
  'cost-efficiency': 'Inventory metered dependencies (paid APIs, model providers, cloud storage/query/compute, egress) and their call sites, schedules and retry paths; rank spend by frequency times unit cost and growth with usage.',
});

export const AUDIT_DISCOVERY = Object.freeze({
  ...Object.fromEntries(Object.entries(profileDiscovery).filter(([id]) => auditDomainFor(id) === id)),
  ...Object.fromEntries(Object.entries(CONSOLIDATED_AUDIT_DOMAINS).map(([id, { members }]) =>
    [id, members.map(member => profileDiscovery[member]).join(' ')])),
});

// Historical series keep the label they used when measured.
const HISTORICAL_SERIES_LABELS = {
  'code-quality': 'Code quality',
  'better-structural-drift': 'Structural drift & sources of truth',
  'module-hygiene': 'Module hygiene',
  'typing': 'Typing',
  'simplify': 'Dead code & duplication',
  'over-engineering': 'Over-engineering',
  'better-complexity': 'Cyclomatic complexity',
  'better-cognitive-load': 'Cognitive load & readability',
  'app-bugs': 'App bugs',
  'ui-bugs': 'UI bugs',
  'console-errors': 'Console errors',
  'ui-lifecycle': 'UI lifecycle & state',
  'error-handling': 'Error handling',
  'better-runtime-safety': 'Runtime safety & async correctness',
  'reliability': 'Reliability & operability',
  'workflow-recovery': 'Workflow recovery',
  'observability': 'Logging & observability',
  'data-safety': 'Data & upgrade safety',
  'data-integrity': 'Data integrity & pipelines',
  'upgrade-rehearsal': 'Upgrade & restore rehearsal',
  'test-coverage': 'Test coverage',
  'better-test-quality': 'Test quality',
  'performance': 'Performance',
  'cost-efficiency': 'Cost & resource efficiency',
  'infrastructure': 'Infrastructure & deployment',
  'better-dev-environment': 'Development environment',
  'design': 'Design',
  'ux': 'UX',
  'mobile-responsive': 'Mobile & responsive',
  'documentation': 'Documentation',
  'copy': 'Copy & text clarity',
};

const MAX_DEPLOYMENT_MODEL_CHARS = 2000;

/**
 * The deployment model every audit weighs reachability against: the owner's
 * own words from the app record when set, else the repository's documentation.
 */
function deploymentModelSource(app) {
  const stated = typeof app?.deploymentModel === 'string' ? app.deploymentModel.trim().slice(0, MAX_DEPLOYMENT_MODEL_CHARS) : '';
  return stated
    ? `The app's owner states its deployment model, and it is binding:\n\n> ${stated.replace(/\r?\n/g, '\n> ')}\n\nWhere the repository's requirements, PRD, spec or AGENTS.md are more specific, they refine it.`
    : "Take the deployment model from the app's own requirements: its PRD, spec, PLAN or design docs, AGENTS.md, README and deployment config (who uses it, whether several people share one install or record, which processes, schedulers and syncs run beside the user). If none says, infer it from the code and name the assumption in your report.";
}

/**
 * Shared calibration for every audit: hunt the concurrency and edge cases a
 * real deployment can produce, and drop the ones it cannot.
 */
function reachabilityCheck(app) {
  return `## Reachability check: likely bugs, not imaginable ones

${deploymentModelSource(app)}

Weigh every candidate by how likely it is to happen under that model, and rank by likelihood times impact. Drop a finding that needs a condition the model rules out, and do not add machinery against it; keep every condition the model allows. For example, a single-user install rules out two different people editing the same record, while a multi-user app keeps those races, permission boundaries and tenant isolation in scope. Even one person produces concurrency, so these stay in scope for every model: the same action fired twice (double click, retry after a timeout), two tabs or devices on one record, background or scheduled jobs running while the user works, parallel jobs sharing a file, record or external resource, sync with the user's other machines, and a restart in the middle of an operation. A race finding names both actors and how they come to overlap in real use; if you cannot name a realistic pair, it is not a finding.`;
}

const scopeAreas = areas => (Array.isArray(areas) ? areas : [])
  .filter(entry => typeof entry?.label === 'string' && Array.isArray(entry.globs) && entry.globs.length > 0);
const scopeAreaLines = areas => areas.map(({ label, globs }) => `  - ${label}: ${globs.map(glob => `\`${glob}\``).join(', ')}`).join('\n');

/**
 * The install's feature tiers as audit scope (#18524). Reads each area's label and globs only, so a usage count,
 * date or tier source can never reach a prompt, and returns '' when there is nothing to say so the prompt stays
 * byte-identical to the unscoped one. An exempt lane (security, privacy, data integrity) keeps dormant areas in
 * scope; every other lane drops them from the inventory its coverage counts are measured against.
 */
function featurePriorityScope(category, priorityScope) {
  const [p0, p2, p3] = ['p0', 'p2', 'p3'].map(tier => scopeAreas(priorityScope?.[tier]));
  const exempt = isPriorityExemptAuditType(category);
  if (exempt ? !p3.length : !(p0.length || p2.length || p3.length)) return '';
  const rules = exempt
    ? [`- P3 areas stay fully in scope for this lane and nothing is removed from the inventory: a vulnerability or migration bug in a dormant feature still shares the server, database, credentials and host privileges. Do not skip or down-rank these paths because the feature is unused.\n${scopeAreaLines(p3)}`]
    : [
      p3.length ? `- P3, out of scope for this lane: remove every path matching these globs from the step 1 inventory before the signal scan, and never choose one as the slice or name it in AUDIT_SLICE. totalFiles and scannedFiles count only the inventory that remains, so coverage "broad" requires scanning at least ${broadCoverageMinPercent}% of that inventory. A verified defect in P3 code met while tracing something else is still filed.\n${scopeAreaLines(p3)}` : '',
      p3.length && AUDIT_DISCOVERY[auditDomainFor(category)].includes('quality:complexity') ? `- Complexity shortlist without the P3 paths (only where the repository has the quality:complexity script): npm run quality:complexity -- ${p3.flatMap(({ globs }) => globs).map(glob => `--exclude '${glob}'`).join(' ')}` : '',
      p2.length ? `- P2: file or fix verified functional or reliability defects only. No polish, micro-optimization, refactor, copy or speculative test work.\n${scopeAreaLines(p2)}` : '',
      p0.length ? `- P0: the first tie-break after severity and user impact, ahead of churn and fan-in, and preferred when rotating slices.\n${scopeAreaLines(p0)}` : '',
      '- A path matching none of the globs above is audited as P1 under the steps above: it belongs to a normally used area or is shared code.',
    ].filter(Boolean);
  return `## Feature priority scope

This install ranks its feature areas by tier, from P0 (heavy daily use) to P3 (dormant). The tiers describe this install only: do not restate tiers, these lists or this section in issues, pull requests or commit messages. The patterns are Node path.matchesGlob globs over repository-relative paths (brace lists and !(...) negations included), not git pathspecs.
${rules.join('\n')}

`;
}

/**
 * `priorityScope` is `{ p0, p2, p3 }`, each a list of `{ label, globs }` (see `resolveAuditPriorityScope`); the
 * caller resolves it so this module stays pure. Absent, null or empty leaves the prompt unchanged.
 */
export function auditQualityInstructions(taskType, app, { priorityScope = null } = {}) {
  const category = normalizeAuditTaskType(taskType);
  if (!isAuditTaskType(category)) return '';
  return `## Repository-wide discovery, remediation verification, and quality assessment

This contract overrides narrower slice-selection or ranking advice in the mission, including customized prompts. Preserve the selected file-issues/fix mode and documented non-issues. Read the lane-health block: do not re-file a finding it lists as reverted or not-planned without new evidence.
1. Inventory all first-party source roots with git ls-files or rg --files, excluding vendored/generated/build/dependency output. Do a cheap repository-wide signal scan BEFORE choosing where to investigate. Do not deep-read the entire repository.
2. Category search: ${AUDIT_DISCOVERY[auditDomainFor(category)]}
3. Check \`audit-slice-history\` FIRST for any slice that scored below ${QUALITY_HEALTHY_THRESHOLD} whose filed issues or fix PRs have landed in the checkout (skip slices already re-verified since those fixes). Prefer to re-verify one such remediated slice before rotating to a new area, still completing the cheap Step 1 signal scan so the run qualifies as \`broad\` and supersedes the older slice, and retaining the same canonical primary path or covering all original paths in AUDIT_SLICE. When rotating to a new area, rank at least the top five candidates (or all if fewer), with paths, measured signals, impact, reach, confidence and why higher candidates win. Validate the top candidates through callers, tests and relevant history before filing or fixing. Severity and user impact outrank ease, small scope and recency. Churn and fan-in break ties; inactivity alone never dismisses a severe offender. If the raw worst is exempt, already filed or not actionable, report why and continue down the ranking. Existing unresolved issues still count against quality. Never pick a nit while a verified major problem remains actionable. Scope a new rotation to a cohesive feature or subsystem slice (for example an entire router/service family or feature directory, typically 5–15 related files) rather than narrowing the slice to only the 1–2 files containing a defect, and place the specific feature or store path first in AUDIT_SLICE (not a shared hub file). Use canonical repo-relative paths in AUDIT_SLICE, never prose descriptions.
   Proportionality check, before filing or fixing any candidate: the proposed fix must be the smallest change that removes the demonstrated harm, and should avoid unnecessary validation layers, archives, ledgers, retries, recovery workflows, extra CI stages or slower processes. A demonstrated security boundary may require a new or strengthened control; do not reject one solely because it adds validation. Speed of execution (CI time, agent turnaround, local build/test gate time) counts as a cost: a fix that slows CI or process needs a measured harm that outweighs it. Defer to the project's existing sources of truth (for example its code host or CI system, whether GitHub, GitLab or a self-hosted/enterprise instance, for branch, merge and review state; the platform toolchain for build and signing state) instead of building a parallel verification of them. If proposed process machinery lacks demonstrated harm or a reachable failure to justify it, do not file that robust-process fix; file at most one documentation or decision-gap item stating the question and the simple options, and score the slice without penalizing the gap. When the audited code is itself machinery of that kind, prefer a finding that removes or simplifies it.
   Reachability check, before ranking: apply the section below to every candidate.
${category === 'security' ? `   Security assessment: require evidence of attacker control, a reachable sink and unauthorized impact, including configuration and existing controls. Distinguish accidental owner-input reliability harm, conditional exposure, unconfirmed candidates and justified dispositions. Calibrate severity by exploitability under the threat model: host-local or conditional defense-in-depth gaps without a direct exploit path are severity 3–5, not 7–8. Do not count rejected or unconfirmed candidates as verified security defects. Preserve defenses against compromised dependencies, external content and browser-origin access to local services; trace and reuse existing screening only where the actual path invokes it. For PortOS, follow docs/SECURITY_RISK_ASSESSMENT.md, search prior dispositions and record conditions for reevaluation.` : ''}${category === 'privacy' ? `   Privacy calibration: distinguish remote, external-API or operational-log personal-data exfiltration (severity 7–9) from single-user host-local file-mode or temp-file umask tightening (severity 3–5).` : ''}${category === 'test-quality-coverage' ? `   Coverage verification: before marking a split helper or route untested, inspect parent routers, facade service suites and shared assertion harnesses to confirm whether the behavior is already covered at a higher public boundary.` : ''}
4. Keep investigation bounded after this scan. Report scanned roots, tools/commands, candidate ranking, exclusions, reviewed paths, unreviewed inventory and stopping reason. If tools or budget prevent broad discovery, report partial coverage, never claim a global worst or a clean repository.
5. Assess the PRE-FIX state of the SLICE you deep-reviewed on 0–100 (higher is healthier). Score the whole reviewed slice proportionally using the severity, prevalence and reach of verified defects across all deep-reviewed paths. A finding that led you to choose the slice is only one part of that evidence. Record the worst defect separately in step 6. Use these anchors:
${QUALITY_SCORE_BANDS.map(([band, meaning]) => `   - ${band}: ${meaning}.`).join('\n')}
   For a clean slice with worstSeverity 0, score 90–95. Simplicity earns no deduction. The pragmatic target band is 85–95. Avoid speculative hardening, defensive layers, micro-optimizations or extra abstractions to chase 100. Scores above 95 are optional.
   Name the slice by the canonical repo-relative top-level paths or area you actually read, with the primary feature path first. The dashboard derives the category trend from recent slice scores. Never extrapolate a repository-wide score from a signal scan. Explain the sliceScore with concrete evidence from the reviewed paths. Filing an issue earns no points for this pre-fix assessment. In audit-and-fix mode only, when your run lands and verifies fixes for defects in this slice (passing tests and merged/delivered PR), you may also include optional "postFixSliceScore" and "postFixWorstSeverity" fields in QUALITY_AUDIT_JSON reflecting the verified post-fix state of the same slice; the server retains them only on verified fix deliveries and ignores them in file-issues or leave-open PR runs. Use sliceScore:null for unavailable or inapplicable assessment. Zero is a real score.
6. Score the worst finding's severity separately on 1–10: 1–3 minor localized impact, 4–6 material recurring cost, 7–8 major workflow/reliability impact, 9–10 critical data/security/availability failure. Use 0 only when no material finding was verified. List this severity for every finding in the narrative.
7. Include exactly one single-line QUALITY_AUDIT_JSON: {...} in your completion sentinel summary AND final response, with no secrets or personal data. Replace the example values with observed evidence. The category is fixed to this task; do not rate other categories. Beside it, include exactly one line AUDIT_SLICE: <comma-separated top-level paths or areas deep-reviewed> naming the same slice; PortOS records it so later runs of this lane can re-verify remediated slices or rotate to uncovered areas. Keep ordinary completion/PR instructions and summaries too. The report's inner JSON "summary" field must contain plain assessment prose only, with no QUALITY_AUDIT_JSON: or AUDIT_SLICE: lines.
QUALITY_AUDIT_JSON: {"version":2,"category":"${category}","slice":"top-level paths or area deep-reviewed","sliceScore":null,"worstSeverity":0,"coverage":"unavailable","confidence":"low","summary":"Explain the slice assessment and strongest evidence","scannedFiles":0,"totalFiles":0}
Allowed coverage: broad, partial, unavailable, not-applicable. Allowed confidence: low, medium, high. coverage describes the signal scan in step 1, not the deep review: scannedFiles counts files actually included in the category signal scan; totalFiles is the eligible inventory. Broad requires scanning at least ${broadCoverageMinPercent}% of a nonempty inventory (deep review remains bounded). Partial assessments are excluded from the overall score. For partial coverage, use sliceScore:null when the inspected evidence cannot support a slice score; explain why rather than inventing one. A numeric partial score is provisional. If unavailable or not-applicable, sliceScore must be null and explain why. Even a zero-finding audit returns this assessment.

${featurePriorityScope(category, priorityScope)}${reachabilityCheck(app)}`;
}

export const appQualityQuerySchema = z.object({ includeQuality: z.enum(['true', 'false']).optional() });

// The list endpoint has two intentionally narrow projections in addition to
// its frozen default response: the sidebar/navigation shape and the PM2-backed
// peer-probe shape. Keep the detail endpoint on appQualityQuerySchema so a
// view flag cannot silently change its response contract.
export const appListQuerySchema = appQualityQuerySchema.extend({
  view: z.enum(['nav', 'probe']).optional(),
});

const scoreSchema = z.number().int().min(0).max(100).nullable();
const historicalCategorySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).transform(normalizeAuditTaskType);
const categorySchema = historicalCategorySchema.refine(isAuditTaskType);
// Key order is the stored JSON order; keep the score fields where v1 wrote them.
const reportFields = {
  worstSeverity: z.number().int().min(0).max(10),
  coverage: z.enum(['broad', 'partial', 'unavailable', 'not-applicable']),
  confidence: z.enum(['low', 'medium', 'high']),
  summary: z.string().trim().min(1).max(2000),
  scannedFiles: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
};

const meetsBroadCoverageMinimum = (scannedFiles, totalFiles) =>
  totalFiles > 0 && scannedFiles / totalFiles >= BROAD_COVERAGE_MIN_RATIO;

/**
 * Two report shapes are stored side by side (#12076). v1 carried a category-wide
 * `score` the agent extrapolated from a bounded slice, which moved with the slice
 * it happened to pick. v2 names the `slice` and rates only it (`sliceScore`); the
 * category figure is derived server-side from a rolling window of run scores
 * (`summarizeAppQuality`). Both shapes stay parseable forever: stored v1 rows and
 * older peers keep rendering, and the run score is read from either.
 */
const severitySchema = z.number().int().min(0).max(10);
const qualityReportSchema = category => z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), category, score: scoreSchema, ...reportFields }).strict(),
  z.object({
    version: z.literal(2), category, slice: z.string().trim().min(1).max(500), sliceScore: scoreSchema,
    postFixSliceScore: scoreSchema.optional(),
    postFixWorstSeverity: severitySchema.optional(),
    ...reportFields,
  }).strict(),
]).refine(r => r.scannedFiles <= r.totalFiles)
  .refine(r => r.version !== 2 || (r.postFixSliceScore ?? null) === null || r.sliceScore !== null)
  .refine(r => ['unavailable', 'not-applicable'].includes(r.coverage)
    ? qualityRunScore(r) === null
    : r.scannedFiles > 0 && (r.coverage === 'partial' || qualityRunScore(r) !== null))
  .refine(r => r.coverage !== 'broad' || meetsBroadCoverageMinimum(r.scannedFiles, r.totalFiles));
export const auditQualityReportSchema = qualityReportSchema(categorySchema);
// Historical files can carry a retired or newer category without registering it
// as an active audit or admitting it to the older peer wire contract.
export const historicalQualityReportSchema = qualityReportSchema(historicalCategorySchema);

/** The one run's 0–100 assessment from either report shape (preferring server-verified post-fix score when stored); `null` when unscored. */
export function qualityRunScore(report) {
  if (!report || typeof report !== 'object') return null;
  if (report.version === 2) return report.postFixSliceScore ?? report.sliceScore ?? null;
  return report.score ?? null;
}

/** The one run's effective worst severity (preferring server-verified post-fix severity when stored). */
export function qualityWorstSeverity(report) {
  if (!report || typeof report !== 'object') return null;
  if (report.version === 2 && Number.isFinite(report.postFixWorstSeverity)) return report.postFixWorstSeverity;
  return Number.isFinite(report.worstSeverity) ? report.worstSeverity : null;
}

/**
 * The numeric wire/file shape (`PORTOS_SCHEMA_VERSIONS.appQuality` v1, the
 * `.quality.json` row) for any stored report: a v2 run score travels in the v1
 * `score` field, so an older peer reads it as the per-run score it already
 * expects, and the `slice` text — which names repository paths — never leaves
 * the machine. The result is still validated by its consumer's schema.
 */
export function numericQualityReport(report) {
  if (!report || typeof report !== 'object') return report;
  const { category, coverage, confidence, scannedFiles, totalFiles } = report;
  const worstSeverity = qualityWorstSeverity(report) ?? report.worstSeverity;
  // Older readers require equal counts for broad rows. Keep the raw counts
  // on the stored report and project only counts that meet the local minimum.
  const projectedScannedFiles = coverage === 'broad' && scannedFiles < totalFiles
    && Number.isSafeInteger(scannedFiles) && Number.isSafeInteger(totalFiles)
    && meetsBroadCoverageMinimum(scannedFiles, totalFiles) ? totalFiles : scannedFiles;
  if (report.version === 1 && projectedScannedFiles !== scannedFiles) return { ...report, scannedFiles: projectedScannedFiles };
  if (report.version !== 2) return report;
  return { version: 1, category, score: qualityRunScore(report), worstSeverity, coverage, confidence, scannedFiles: projectedScannedFiles, totalFiles };
}

function sanitizeReportSummary(value) {
  return value.split(/\r?\n/)
    .filter(line => !/^\s*(?:AUDIT_SLICE|QUALITY_AUDIT_JSON):/.test(line))
    .join('\n');
}

export function parseAuditQualityReport(summary, category) {
  if (typeof summary !== 'string') return null;
  const lines = summary.split(/\r?\n/).filter(line => line.startsWith(REPORT_PREFIX));
  if (lines.length !== 1) return null;
  const raw = safeJSONParse(lines[0].slice(REPORT_PREFIX.length), null);
  if (typeof raw?.summary === 'string') raw.summary = sanitizeReportSummary(raw.summary);
  // Keep scored evidence below the broad coverage minimum as a partial assessment.
  const claim = raw && typeof raw === 'object' && raw.coverage === 'broad' && qualityRunScore(raw) !== null
    && Number.isFinite(raw.scannedFiles) && Number.isFinite(raw.totalFiles)
    && raw.scannedFiles > 0 && raw.totalFiles > 0 && !meetsBroadCoverageMinimum(raw.scannedFiles, raw.totalFiles)
    ? { ...raw, coverage: 'partial' } : raw;
  const parsed = auditQualityReportSchema.safeParse(claim);
  return parsed.success && parsed.data.category === normalizeAuditTaskType(category) ? parsed.data : null;
}

/**
 * The `AUDIT_SLICE: <paths or areas>` line from a completion summary (#12090),
 * trimmed and bounded, or null when absent or empty. The first such line wins;
 * the stored value drives the lane's slice rotation on later runs.
 */
export function parseAuditSlice(summary) {
  if (typeof summary !== 'string') return null;
  const line = summary.split(/\r?\n/).find(candidate => candidate.startsWith(SLICE_PREFIX));
  const slice = line ? line.slice(SLICE_PREFIX.length).trim().slice(0, MAX_SLICE_CHARS) : '';
  return slice || null;
}

const RECOMMENDED_AUDITS_HEADING = /^\s*(?:#{1,6}\s*|\*\*)?Recommended next audits\b/i;
const RECOMMENDED_AUDIT_LINE = /^\s*(?:\d+[.)]|[-*])\s+(.+?)\s*$/;
const MAX_RECOMMENDED_AUDITS = 3;

/**
 * The code-quality lane's triage output (#12085): the ranked audits listed
 * under a `Recommended next audits` heading in the completion summary. Reads
 * the list lines that follow the heading, up to the first blank line, another
 * heading, or three entries; each entry keeps the line text the agent wrote
 * (`<task-type> — <evidence>: <paths>`) with the list marker stripped. Returns
 * `[]` for a summary with no such block, and ignores a second block.
 */
export function parseRecommendedAudits(summary) {
  if (typeof summary !== 'string') return [];
  const lines = summary.split(/\r?\n/);
  const start = lines.findIndex(line => RECOMMENDED_AUDITS_HEADING.test(line));
  if (start < 0) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line) || items.length >= MAX_RECOMMENDED_AUDITS) break;
    const match = RECOMMENDED_AUDIT_LINE.exec(line);
    if (!match) break;
    items.push(match[1].slice(0, 300));
  }
  return items;
}

export const AUDIT_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether an assessment taken at `assessedAt` still counts at `now` (not future-dated, not older than the window). */
export function isFreshAssessment(assessedAt, now = Date.now()) {
  const age = now - Date.parse(assessedAt);
  return Number.isFinite(age) && age >= 0 && age <= AUDIT_FRESHNESS_MS;
}

/** How many recent distinct-slice run scores a category's dashboard figure averages. */
export const QUALITY_WINDOW_RUNS = 5;
// A low-confidence run never contributes; the window weights the rest so a
// hedged assessment moves the figure half as far as a confident one.
const CONFIDENCE_WEIGHT = Object.freeze({ high: 1, medium: 0.5 });

/** A score at or above this is healthy; below it the category has real debt. */
export { QUALITY_HEALTHY_THRESHOLD };
export { QUALITY_RECENCY_HALF_LIFE_DAYS };
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeSliceText(value) {
  if (typeof value !== 'string') return null;
  const segments = value.split(',')
    .map(segment => segment.trim().toLowerCase().replaceAll('\\', '/').replace(/^\.\/+|\/+$/g, ''))
    .filter(Boolean);
  return segments.length ? [...new Set(segments)] : null;
}

/** Canonical slice segments in reported order, with the primary path first. */
function normalizeSliceSegments(run) {
  const raw = run?.record?.slice ?? (run?.report?.version === 2 ? run.report.slice : null);
  return normalizeSliceText(raw) ?? (run?.report?.version === 2 ? normalizeSliceText(run.report.slice) : null);
}

function coversSlice(newer, older) {
  return newer[0] === older[0] || older.every(path =>
    newer.some(candidate => path === candidate || path.startsWith(`${candidate}/`))
  );
}

function utcDay(assessedAt) {
  const time = Date.parse(assessedAt);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : String(assessedAt);
}

function isQualifyingReport(report) {
  return Boolean(report) && report.coverage === 'broad' && report.confidence !== 'low' && qualityRunScore(report) !== null;
}

/** Whether one run's parsed report qualifies for the category window: fresh, broad signal scan, not hedged, scored. */
function qualifiesForWindow(run, now) {
  return run.valid && isFreshAssessment(run.record.assessedAt, now) && isQualifyingReport(run.report);
}

/**
 * Select up to `QUALITY_WINDOW_RUNS` qualifying runs (already sorted newest-first) for a category:
 * - For a consolidated domain with >= 1 fresh qualifying domain-native run, drop pre-consolidation
 *   legacy member runs whose `assessedAt` is strictly earlier than the earliest domain-native run.
 * - Skip older slices when a newer qualifying run shares their canonical primary path or covers
 *   every segment. Directory prefixes match only on path boundaries.
 * - Prefer a retained slice over same-day slice-less evidence unless the imported run is strictly newer.
 * - Keep one slice-less winner per eligible day. Peer and snapshot rows must also be at
 *   least as recent as the newest qualifying local slice in the window's eligible set.
 */
function selectCategoryWindow(id, runs, now) {
  const qualifying = runs.filter(run => qualifiesForWindow(run, now));
  let eligible = qualifying;
  if (Object.hasOwn(CONSOLIDATED_AUDIT_DOMAINS, id)) {
    const domainNative = qualifying.filter(run => normalizeAuditTaskType(run.record.category) === id);
    if (domainNative.length > 0) {
      const earliestNativeMs = Math.min(...domainNative.map(run => Date.parse(run.record.assessedAt)));
      eligible = qualifying.filter(run =>
        normalizeAuditTaskType(run.record.category) === id || Date.parse(run.record.assessedAt) >= earliestNativeMs
      );
    }
  }
  const seenSlices = [];
  const newestSliceByDay = new Map();
  const candidates = [];
  let newestLocalSliceMs = -Infinity;
  // Check retained slices first so equal timestamps prefer identified slices regardless of tie order.
  for (const run of eligible) {
    const { assessedAt, category, sourcePeerId, sourcePeerName } = run.record;
    const slice = normalizeSliceSegments(run);
    const dayKey = `${normalizeAuditTaskType(category)}|${utcDay(assessedAt)}`;
    const imported = Boolean(sourcePeerId || sourcePeerName);
    if (slice !== null) {
      const superseded = seenSlices.some(newer => coversSlice(newer, slice));
      seenSlices.push(slice);
      if (superseded) continue;
      if (!newestSliceByDay.has(dayKey)) newestSliceByDay.set(dayKey, Date.parse(assessedAt));
      if (!imported) newestLocalSliceMs = Math.max(newestLocalSliceMs, Date.parse(assessedAt));
    }
    candidates.push({ run, slice, dayKey, imported });
  }
  const window = [];
  const sliceLessDays = new Set();
  for (const { run, slice, dayKey, imported } of candidates) {
    if (slice === null) {
      const assessedMs = Date.parse(run.record.assessedAt);
      const sameDaySlice = newestSliceByDay.get(dayKey);
      if (sliceLessDays.has(dayKey) || (imported && assessedMs < newestLocalSliceMs)) continue;
      if (sameDaySlice !== undefined && (!imported || assessedMs <= sameDaySlice)) continue;
      sliceLessDays.add(dayKey);
    }
    window.push(run);
    if (window.length >= QUALITY_WINDOW_RUNS) break;
  }
  return window;
}

/** Confidence- and recency-weighted mean of the window's run scores, rounded; `null` for an empty window. */
function windowScore(window, now = Date.now()) {
  if (!window.length) return null;
  const weighted = window.reduce((acc, run) => {
    const ageDays = Math.max(0, (now - Date.parse(run.record.assessedAt)) / DAY_MS);
    const weight = CONFIDENCE_WEIGHT[run.report.confidence] * Math.pow(0.5, ageDays / QUALITY_RECENCY_HALF_LIFE_DAYS);
    return { sum: acc.sum + weight * qualityRunScore(run.report), weight: acc.weight + weight };
  }, { sum: 0, weight: 0 });
  return Math.round(weighted.sum / weighted.weight);
}

/**
 * Roll each category's recent measurements into the app's quality summary.
 *
 * A category's `score` is the confidence- and recency-weighted mean of its newest
 * `QUALITY_WINDOW_RUNS` qualifying runs (fresh, broad coverage, medium/high
 * confidence, scored), superseding re-audited slices and isolating consolidated
 * domains from pre-consolidation legacy member runs older than the earliest
 * fresh qualifying domain-native run; `window` reports how many runs fed it and the worst
 * severity any of them found. One run's slice score is slice noise — a 20-point
 * swing between consecutive runs carried no information — so the newest run
 * alone no longer decides the figure, and a newer partial run does not erase a
 * fresh scored one. With no qualifying run the row falls back to the newest
 * run's own score, shown beside its stale/partial/low-confidence evidence as
 * before, and does not contribute. Everything else about the row (coverage,
 * confidence, slice, `runScore`, summary, provenance, staleness) describes the
 * newest run, or the window leader when same-day qualifying evidence competes.
 * The overall score stays the equal-weight mean of the contributing categories.
 *
 * `inapplicable` maps category → reason for categories this repository cannot
 * have findings for (from `resolveQualityChecks`; the caller supplies it only
 * where it can afford the repository scan). A category is inapplicable when that
 * map names it OR its own fresh report says `not-applicable` — unless it holds
 * a fresh rated assessment anyway, which is evidence that it does apply.
 * `applicableCategories` is the honest denominator: a backend API is not
 * "3 of 30 rated" because seven UI audits have nothing to look at.
 * `totalCategories` keeps its catalog-size meaning for existing readers.
 */
export function summarizeAppQuality(records = [], now = Date.now(), { inapplicable = {}, includeHistoricalCategories = false } = {}) {
  const runsByCategory = new Map();
  for (const record of records) {
    const category = normalizeAuditTaskType(record.category);
    const report = (includeHistoricalCategories ? historicalQualityReportSchema : auditQualityReportSchema).safeParse(record.report);
    const valid = report.success && report.data.category === category;
    const domain = auditDomainFor(category);
    const run = { record, valid, report: valid ? report.data : null };
    for (const id of includeHistoricalCategories && category !== domain ? [domain, category] : [domain]) {
      if (!runsByCategory.has(id)) runsByCategory.set(id, []);
      runsByCategory.get(id).push(run);
    }
  }
  const definitions = Object.entries(AUDIT_DEFINITIONS);
  if (includeHistoricalCategories) {
    for (const id of runsByCategory.keys()) {
      if (!Object.hasOwn(AUDIT_DEFINITIONS, id) && historicalCategorySchema.safeParse(id).success) definitions.push([id, { label: id }]);
    }
  }
  const categories = definitions.map(([id, definition]) => {
    const runs = (runsByCategory.get(id) || []).sort((a, b) => compareQualityRecords(b.record, a.record));
    const window = selectCategoryWindow(id, runs, now);
    // When same-day evidence ties or a legacy slice-less run yields to a named
    // slice, describe the winner. A newer partial/stale result still describes itself.
    const newest = runs[0];
    const latest = window.length && qualifiesForWindow(newest, now) ? window[0] : newest;
    const record = latest?.record;
    const valid = Boolean(latest?.valid);
    const assessedAt = record?.assessedAt;
    const stale = valid && !isFreshAssessment(assessedAt, now);
    const contributes = Object.hasOwn(AUDIT_DEFINITIONS, id) && window.length > 0;
    // Only this install's own ruling, as the dispatch gate reads it: a peer's
    // or a release snapshot's describes a different checkout of the repository.
    const local = !record?.sourcePeerId && !record?.sourcePeerName;
    const reportedNotApplicable = valid && !stale && local && normalizeAuditTaskType(record.category) === id && latest.report.coverage === 'not-applicable';
    const detectedReason = Object.hasOwn(inapplicable, id) ? inapplicable[id] : null;
    const applicable = contributes || !(reportedNotApplicable || detectedReason);
    const inapplicableReason = applicable ? null
      : detectedReason || 'the latest audit reported this category as not applicable';
    const {
      version: _version, category: _category, score: _score, sliceScore: _sliceScore,
      postFixSliceScore: _postFixSliceScore, postFixWorstSeverity: _postFixWorstSeverity, slice, ...latestFields
    } = latest?.report || {};
    const runScore = valid ? qualityRunScore(latest.report) : null;
    const effectiveLatestWorst = valid ? qualityWorstSeverity(latest.report) : undefined;
    return {
      id, label: definition.label,
      ...(valid ? { ...latestFields, ...(effectiveLatestWorst != null ? { worstSeverity: effectiveLatestWorst } : {}) } : { coverage: 'unavailable' }),
      score: window.length ? windowScore(window, now) : runScore, runScore, slice: valid ? slice ?? (record?.slice || null) : null,
      window: { runs: window.length, worstSeverity: window.length ? Math.max(...window.map(run => qualityWorstSeverity(run.report) ?? run.report.worstSeverity)) : null },
      assessedAt: assessedAt || null, agentId: record?.agentId || null, sourcePeerId: record?.sourcePeerId || null, sourcePeerName: record?.sourcePeerName || null, stale, contributes, applicable, inapplicableReason,
      ...(Object.hasOwn(CONSOLIDATED_AUDIT_DOMAINS, id) ? { members: domainMemberSeries(id, runs, now) } : {}) };
  });
  const rated = categories.filter(c => c.contributes);
  return {
    score: rated.length ? Math.round(rated.reduce((sum, c) => sum + c.score, 0) / rated.length) : null,
    ratedCategories: rated.length,
    totalCategories: categories.length,
    applicableCategories: categories.filter(c => c.applicable).length,
    categories: categories.map(({ contributes: _contributes, ...category }) => category),
  };
}

/**
 * Each series a consolidated domain row folds in (the domain's own runs, then
 * every member profile), with that series' newest run. The row's score already
 * counts these runs; this keeps each legacy series visible by name so folding a
 * profile into a domain never hides its measurement. A member with no run is
 * listed with a null score, so the row shows what it covers.
 */
function domainMemberSeries(domainId, runs, now) {
  return [domainId, ...CONSOLIDATED_AUDIT_DOMAINS[domainId].members].map(seriesId => {
    const latest = runs.find(run => run.valid && normalizeAuditTaskType(run.record.category) === seriesId);
    return {
      id: seriesId,
      label: seriesId === domainId ? 'Combined audit' : HISTORICAL_SERIES_LABELS[seriesId] || seriesId,
      score: latest ? qualityRunScore(latest.report) : null,
      coverage: latest?.report.coverage ?? null,
      assessedAt: latest?.record.assessedAt ?? null,
      stale: latest ? !isFreshAssessment(latest.record.assessedAt, now) : false,
    };
  });
}

export const appQualityHistoryQuerySchema = z.object({ days: z.enum(['30', '90', '365']).default('90').transform(Number) });

/**
 * Daily UTC snapshots of evidence available then; never backfill past scores.
 * Each point applies the same rolling derivation as the live summary to the
 * runs known by that day, so the chart and the breakdown agree.
 */
export function buildAppQualityHistory(records, days, now = Date.now()) {
  const dayMs = 86400000;
  const today = Math.floor(now / dayMs) * dayMs;
  const sorted = dailyQualityRecords(records.filter(r => Number.isFinite(Date.parse(r.assessedAt))));
  const additionalCategories = [...new Set(sorted.map(record => record.category)
    .filter(id => !Object.hasOwn(AUDIT_DEFINITIONS, id) && historicalCategorySchema.safeParse(id).success))]
    .sort().map(id => ({ id, label: `Other / previous: ${id}` }));
  const latest = new Map();
  let known = [];
  let cursor = 0;
  const points = [];
  for (let day = today - (days - 1) * dayMs; day <= today; day += dayMs) {
    const asOf = Math.min(day + dayMs - 1, now);
    while (cursor < sorted.length && Date.parse(sorted[cursor].assessedAt) <= asOf) {
      const record = sorted[cursor++];
      latest.set(record.category, record);
      known.push(record);
    }
    // A run older than the freshness window can no longer feed any category's
    // rolling figure; only the newest per category still matters, as its evidence row.
    known = known.filter(record => Date.parse(record.assessedAt) >= asOf - AUDIT_FRESHNESS_MS || latest.get(record.category) === record);
    const summary = summarizeAppQuality(known, asOf, { includeHistoricalCategories: true });
    points.push({ date: new Date(day).toISOString().slice(0, 10), score: summary.score,
      ratedCategories: summary.ratedCategories,
      categories: Object.fromEntries(summary.categories.map(c => [c.id, {
        score: c.stale ? null : c.score, coverage: c.coverage, confidence: c.confidence ?? null,
      }])) });
  }
  return { days, totalCategories: Object.keys(AUDIT_DEFINITIONS).length, additionalCategories, points };
}

function isReleaseSnapshotRecord(record) {
  return !record?.sourcePeerId && Boolean(record?.sourcePeerName);
}

function isDayOnlyTimestamp(assessedAt) {
  return /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(String(assessedAt));
}

function numericReportFields(record) {
  const report = record.report ? numericQualityReport(record.report) : record;
  return [
    normalizeAuditTaskType(record.category ?? report?.category),
    qualityRunScore(report),
    report?.worstSeverity,
    report?.coverage,
    report?.confidence,
    report?.scannedFiles,
    report?.totalFiles,
  ];
}

function releaseCoveredByDayRecords(release, dayRecords) {
  if (!dayRecords.length) return false;
  const tieKey = qualityTieKey(release);
  if (dayRecords.some(other => qualityTieKey(other) === tieKey)) return true;
  if (release.measurementId && dayRecords.some(other => other.measurementId === release.measurementId)) return true;
  if (!isDayOnlyTimestamp(release.assessedAt)) return false;
  const reportKey = JSON.stringify(numericReportFields(release));
  if (dayRecords.some(other => JSON.stringify(numericReportFields(other)) === reportKey)) return true;
  if (isQualifyingReport(release.report)) return dayRecords.some(other => isQualifyingReport(other.report));
  return dayRecords.some(other => other.report?.coverage === release.report?.coverage);
}

/**
 * Normalize categories, deduplicate a local or peer run against its same-day
 * release snapshot (`.quality.json`) so published evidence is never counted
 * twice, and return remaining runs in ascending order. Distinct local runs
 * from the same UTC day stay intact so `selectCategoryWindow` can apply
 * qualification and slice superseding across all of them.
 */
export function dailyQualityRecords(records) {
  const nonReleaseByDay = new Map();
  const releaseByDay = new Map();
  const kept = [];
  for (const record of [...records].sort(compareQualityRecords)) {
    const normalized = { ...record, category: normalizeAuditTaskType(record.category) };
    const key = `${normalized.category}|${utcDay(normalized.assessedAt)}`;
    if (isReleaseSnapshotRecord(normalized)) {
      releaseByDay.set(key, normalized);
    } else {
      if (!nonReleaseByDay.has(key)) nonReleaseByDay.set(key, []);
      nonReleaseByDay.get(key).push(normalized);
      kept.push(normalized);
    }
  }
  for (const [key, release] of releaseByDay) {
    const dayRecords = nonReleaseByDay.get(key) || [];
    if (!releaseCoveredByDayRecords(release, dayRecords)) kept.push(release);
  }
  return kept.sort(compareQualityRecords);
}

export function compareQualityRecords(a, b) {
  const aDate = /^\d{4}-\d{2}-\d{2}$/.test(a.assessedAt);
  const bDate = /^\d{4}-\d{2}-\d{2}$/.test(b.assessedAt);
  const timeA = Date.parse(a.assessedAt);
  const timeB = Date.parse(b.assessedAt);
  const dayA = utcDay(a.assessedAt);
  const dayB = utcDay(b.assessedAt);
  return dayA.localeCompare(dayB) || (aDate !== bDate ? (aDate ? -1 : 1) : 0)
    || timeA - timeB
    || qualityTieKey(a).localeCompare(qualityTieKey(b))
    || Number(!a.sourcePeerId && !a.sourcePeerName) - Number(!b.sourcePeerId && !b.sourcePeerName);
}

/** Stable numeric tie-break shared by local, peer and checked-in records. */
export function qualityTieKey(record) {
  const value = record.assessedAt;
  const time = Date.parse(value);
  const assessedAt = /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time) ? value : new Date(time).toISOString();
  return createHash('sha256').update(JSON.stringify([assessedAt, ...numericReportFields(record)])).digest('hex');
}

/** How many repository hashes one `repositories=` pull may name. */
export const QUALITY_FEDERATION_MAX_REPOSITORIES = 100;

const repositoryHash = z.string().regex(/^[a-f0-9]{64}$/);

export const appQualityFederationQuerySchema = appQualityHistoryQuerySchema.extend({
  // v1 single-app pull. The response stays `{ schemaVersion, repository, measurements }`.
  repository: repositoryHash.optional(),
  // One pull for many apps. The response is `{ schemaVersion, repositories }` at the
  // same schema version. Absent on older callers, which keep the v1 body.
  repositories: z.string()
    .max(QUALITY_FEDERATION_MAX_REPOSITORIES * 64 + QUALITY_FEDERATION_MAX_REPOSITORIES - 1)
    .regex(/^[a-f0-9]{64}(,[a-f0-9]{64})*$/)
    .optional()
    .transform(value => (value ? value.split(',') : undefined)),
  // The categories the requesting install can parse, comma-separated. Absent on
  // a request from an install that predates it — see FEDERATION_LEGACY_CATEGORIES.
  categories: z.string().max(4000).regex(/^[a-z0-9-]+(,[a-z0-9-]+)*$/).optional()
    .transform(value => (value ? value.split(',') : undefined)),
}).refine(query => !(query.repository && query.repositories), {
  message: 'Use repository or repositories, not both',
  path: ['repositories'],
});
