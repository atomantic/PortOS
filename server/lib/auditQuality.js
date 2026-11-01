import { z } from 'zod';
import { AUDIT_DEFINITIONS, normalizeAuditTaskType } from './auditCatalog.js';
import { safeJSONParse } from './jsonIo.js';

const REPORT_PREFIX = 'QUALITY_AUDIT_JSON: ';
const SLICE_PREFIX = 'AUDIT_SLICE: ';
const MAX_SLICE_CHARS = 500;

// Each lens must explain how to find candidates before choosing a slice.
export const AUDIT_DISCOVERY = Object.freeze({
  security: 'Inventory trust boundaries, credential handling, process execution and input-to-sink paths; rank reachable exploit impact under the documented trust model.',
  'code-quality': 'Inventory source directories and convention violations; search brittle conditions, duplicated policy and magic values, ranking demonstrated defects and recurring maintenance cost.',
  'test-coverage': 'Map public routes, workflows and destructive actions to integration tests; rank untested high-impact outcomes, not uncovered line counts.',
  performance: 'Inventory hot routes, loops, queries and large payloads; use existing profiling or bounded measurements to rank latency, memory and repeated work.',
  accessibility: 'Inventory shared controls and screens; scan semantic roles, labels, focus and contrast, then verify the most reused controls and critical keyboard journeys.',
  documentation: 'Compare setup, upgrade and public API documentation against scripts and implementations; rank instructions that break installation or cause data loss first.',
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
  'better-complexity': 'If the target repository has server/scripts/complexity-report.js, run npm run quality:complexity from its root and use its bounded source and test shortlists for investigation. Report its ESLint classic counts as measured, including optional chains and default arguments; record scan failures and separately analyze first-party languages the report does not cover. If the command is absent or fails, use another language-aware complexity analyzer or repository-wide branching searches to shortlist functions and count decision points manually. Include the top measured functions and counts in the run narrative, not QUALITY_AUDIT_JSON; file length is only a discovery hint. A high count alone is not a finding.',
  'better-cognitive-load': 'Scan deeply nested control flow, boolean flags, mixed abstraction levels and misleading names across source roots; rank reader cost in critical, widely used workflows.',
  'better-structural-drift': 'Inventory generators, duplicated registries and derived artifacts; inspect independently edited sources of truth and position-keyed records, ranking demonstrated drift and merge churn.',
  'better-runtime-safety': 'Scan asynchronous callbacks, resource cleanup, nullable access and process lifecycles across source roots; rank reachable crashes, corrupted state and leaked resources.',
  'better-dependency-freedom': 'Inventory manifests and actual imports across packages; rank dependency cost, advisory exposure and removable surface against the complexity of a concrete replacement.',
  'better-test-quality': 'Inventory suites and public boundaries; search assertion-free tests, overmocking, tautologies and redundant cases, prioritizing suites that falsely protect critical behavior.',
  'better-dev-environment': 'Diff host state around one bounded run of the dev commands (see the mission), then inventory the fixture, spawn, watcher and cache sites behind each change; rank by what accumulates per run times how often the loop runs.',
  infrastructure: 'Inventory infrastructure-as-code, container, orchestration, deployment and CI files; scan exposure, identity grants, secrets, pinning, resource limits and probes, rank deployment risk alongside measured CI waste. Trace CI planners/runners; measure run frequency, job duration and critical path, then inspect trigger/path selection, duplicate work, dependencies, cache/artifact reuse, cancellation/concurrency and risk-based PR/MR versus merge/nightly/release placement. Coordinate test-value evidence with Test Quality; preserve essential correctness/security coverage.',
  'data-integrity': 'Inventory every durable user-record write path, ingestion entry point, consumer, batch/backfill job and stored data format (excluding ephemeral runtime state, git worktrees and caches); trace retry and redelivery behavior and multi-step writes, ranking silent duplication, loss and wrong results first.',
  reliability: 'Inventory process entry points, signal handling, health endpoints, queues, workers and scheduled jobs; trace startup, restart and overload behavior under the documented single-install deployment model (excluding multi-instance leases and shutdown job checkpointing for idempotent/regenerable work), ranking primary data corruption and outage amplification first.',
  privacy: 'Inventory personal and sensitive fields in schemas and payloads, then trace them to logs, errors, analytics, caches, exports, third-party calls and deletion paths; rank exposure already happening over missing governance.',
  'feature-completeness': 'Scan for not-implemented/501/placeholder returns, permanently disabled or "coming soon" controls, settings written but never read, endpoints and jobs with no caller, server events with no listener, and to-do references to missing or closed tracker items; trace each to the control or document that offers it, ranking what users are offered today over internal gaps.',
  'workflow-recovery': 'Inventory persisted server-side in-progress states for long-running, multi-minute or paid user generation workflows (excluding short request-bound operations, git worktree cleanup and in-memory re-entrancy guards) and the client chains that drive them; trace each state to the page that must show it and its resume/cancel/reattach exit, ranking user records left blocked with no visible exit first.',
  'upgrade-rehearsal': 'Inventory migrations, seeds, the migration runner and its ledger, and the backup/restore path; build scratch installs from the fixture shapes the migration tests carry and execute upgrade, restore and boot against them, ranking a migration or restore that fails or silently no-ops on a real older shape first.',
  'cost-efficiency': 'Inventory metered dependencies (paid APIs, model providers, cloud storage/query/compute, egress) and their call sites, schedules and retry paths; rank spend by frequency times unit cost and growth with usage.',
});

export function auditQualityInstructions(taskType) {
  const category = normalizeAuditTaskType(taskType);
  if (!Object.hasOwn(AUDIT_DEFINITIONS, category)) return '';
  return `## Repository-wide discovery, worst offender first, and quality assessment

This contract overrides narrower slice-selection or ranking advice in the mission, including customized prompts. Preserve the selected file-issues/fix mode and documented non-issues. Read the lane-health block: do not re-file a finding it lists as reverted or not-planned without new evidence.
1. Inventory all first-party source roots with git ls-files or rg --files, excluding vendored/generated/build/dependency output. Do a cheap repository-wide signal scan BEFORE choosing where to investigate. Do not deep-read the entire repository.
2. Category search: ${AUDIT_DISCOVERY[category]}
3. Rank at least the top five candidates (or all if fewer), with paths, measured signals, impact, reach, confidence and why higher candidates win. Validate the top candidates through callers, tests and relevant history before filing or fixing. Severity and user impact outrank ease, small scope and recency. Churn and fan-in break ties; inactivity alone never dismisses a severe offender. If the raw worst is exempt, already filed or not actionable, report why and continue down the ranking. Existing unresolved issues still count against quality. Never pick a nit while a verified major problem remains actionable.
   Proportionality check, before filing or fixing any candidate: the proposed fix must be the smallest change that removes the demonstrated harm, and must not add a new validation layer, archive, ledger, retry or recovery workflow, extra CI stage, or slower process. Speed of execution (CI time, agent turnaround, local build/test gate time) counts as a cost: a fix that slows CI or process needs a measured harm that outweighs it. Defer to the project's existing sources of truth (for example its code host or CI system, whether GitHub, GitLab or a self-hosted/enterprise instance, for branch, merge and review state; the platform toolchain for build and signing state) instead of building a parallel verification of them. If a finding is only defensible by adding such machinery, or you cannot show a reachable failure that justifies it, do not file a robust-process fix; file at most one documentation or decision-gap item stating the question and the simple options, and score the slice without penalizing the gap. When the audited code is itself machinery of that kind, prefer a finding that removes or simplifies it.
4. Keep investigation bounded after this scan. Report scanned roots, tools/commands, candidate ranking, exclusions, reviewed paths, unreviewed inventory and stopping reason. If tools or budget prevent broad discovery, report partial coverage, never claim a global worst or a clean repository.
5. Assess the PRE-FIX state of the SLICE you deep-reviewed on 0–100 (higher is healthier): 90–100 no material defect found in the slice after real inspection; 70–89 localized moderate debt; 40–69 significant recurring or widespread problems; 10–39 severe/core-workflow defects; 0–9 pervasive critical failure. Name the slice (the top-level paths or area actually read, not the whole inventory) and rate only what you read; the dashboard derives the category trend server-side from recent slice scores, so never extrapolate a repository-wide number from a signal scan. Rate the slice, not the agent's performance or issue count. Explain the sliceScore using severity, prevalence and concrete evidence from the slice. Do not award points merely for filing or fixing this run. Use sliceScore:null for unavailable or inapplicable assessment; zero is a real score.
6. Score the worst finding's severity separately on 1–10: 1–3 minor localized impact, 4–6 material recurring cost, 7–8 major workflow/reliability impact, 9–10 critical data/security/availability failure. Use 0 only when no material finding was verified. List this severity for every finding in the narrative.
7. Include exactly one single-line QUALITY_AUDIT_JSON: {...} in your completion sentinel summary AND final response, with no secrets or personal data. Replace the example values with observed evidence. The category is fixed to this task; do not rate other categories. Beside it, include exactly one line AUDIT_SLICE: <comma-separated top-level paths or areas deep-reviewed> naming the same slice; PortOS records it so later runs of this lane rotate to other areas. Keep ordinary completion/PR instructions and summaries too.
QUALITY_AUDIT_JSON: {"version":2,"category":"${category}","slice":"top-level paths or area deep-reviewed","sliceScore":null,"worstSeverity":0,"coverage":"unavailable","confidence":"low","summary":"Explain the slice assessment and strongest evidence","scannedFiles":0,"totalFiles":0}
Allowed coverage: broad, partial, unavailable, not-applicable. Allowed confidence: low, medium, high. coverage describes the signal scan in step 1, not the deep review: scannedFiles counts files actually included in the category signal scan; totalFiles is the eligible inventory. Broad requires the whole inventory to be scanned (deep review remains bounded). Partial assessments are excluded from the overall score. For partial coverage, use sliceScore:null when the inspected evidence cannot support a slice score; explain why rather than inventing one. A numeric partial score is provisional. If unavailable or not-applicable, sliceScore must be null and explain why. Even a zero-finding audit returns this assessment.`;
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
const categorySchema = z.string().transform(normalizeAuditTaskType)
  .refine(value => Object.hasOwn(AUDIT_DEFINITIONS, value));
// Key order is the stored JSON order; keep the score fields where v1 wrote them.
const reportFields = {
  worstSeverity: z.number().int().min(0).max(10),
  coverage: z.enum(['broad', 'partial', 'unavailable', 'not-applicable']),
  confidence: z.enum(['low', 'medium', 'high']),
  summary: z.string().trim().min(1).max(2000),
  scannedFiles: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
};

/**
 * Two report shapes are stored side by side (#12076). v1 carried a category-wide
 * `score` the agent extrapolated from a bounded slice, which moved with the slice
 * it happened to pick. v2 names the `slice` and rates only it (`sliceScore`); the
 * category figure is derived server-side from a rolling window of run scores
 * (`summarizeAppQuality`). Both shapes stay parseable forever: stored v1 rows and
 * older peers keep rendering, and the run score is read from either.
 */
export const auditQualityReportSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), category: categorySchema, score: scoreSchema, ...reportFields }).strict(),
  z.object({ version: z.literal(2), category: categorySchema, slice: z.string().trim().min(1).max(500), sliceScore: scoreSchema, ...reportFields }).strict(),
]).refine(r => r.scannedFiles <= r.totalFiles)
  .refine(r => ['unavailable', 'not-applicable'].includes(r.coverage) ? qualityRunScore(r) === null : r.scannedFiles > 0 && (r.coverage === 'partial' || qualityRunScore(r) !== null))
  .refine(r => r.coverage !== 'broad' || (r.totalFiles > 0 && r.scannedFiles === r.totalFiles));

/** The one run's 0–100 assessment from either report shape; `null` when unscored. */
function qualityRunScore(report) {
  if (!report || typeof report !== 'object') return null;
  return (report.version === 2 ? report.sliceScore : report.score) ?? null;
}

/**
 * The numeric wire/file shape (`PORTOS_SCHEMA_VERSIONS.appQuality` v1, the
 * `.quality.json` row) for any stored report: a v2 run score travels in the v1
 * `score` field, so an older peer reads it as the per-run score it already
 * expects, and the `slice` text — which names repository paths — never leaves
 * the machine. The result is still validated by its consumer's schema.
 */
export function numericQualityReport(report) {
  if (!report || typeof report !== 'object' || report.version !== 2) return report;
  const { category, worstSeverity, coverage, confidence, scannedFiles, totalFiles } = report;
  return { version: 1, category, score: qualityRunScore(report), worstSeverity, coverage, confidence, scannedFiles, totalFiles };
}

export function parseAuditQualityReport(summary, category) {
  if (typeof summary !== 'string') return null;
  const lines = summary.split(/\r?\n/).filter(line => line.startsWith(REPORT_PREFIX));
  if (lines.length !== 1) return null;
  const raw = safeJSONParse(lines[0].slice(REPORT_PREFIX.length), null);
  // An agent that scanned only part of the inventory but labelled it "broad"
  // (the common slip) still measured something real. Record it as the partial
  // assessment it honestly is rather than dropping the whole run's measurement.
  const claim = raw && typeof raw === 'object' && raw.coverage === 'broad' && qualityRunScore(raw) !== null
    && Number.isFinite(raw.scannedFiles) && Number.isFinite(raw.totalFiles)
    && raw.scannedFiles > 0 && raw.scannedFiles < raw.totalFiles
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

/** How many recent run scores a category's dashboard figure averages (#12076). */
export const QUALITY_WINDOW_RUNS = 5;
// A low-confidence run never contributes; the window weights the rest so a
// hedged assessment moves the figure half as far as a confident one.
const CONFIDENCE_WEIGHT = Object.freeze({ high: 1, medium: 0.5 });

/** Whether one run's parsed report qualifies for the category window: fresh, broad signal scan, not hedged, scored. */
function qualifiesForWindow(run, now) {
  return run.valid && isFreshAssessment(run.record.assessedAt, now) && run.report.coverage === 'broad'
    && run.report.confidence !== 'low' && qualityRunScore(run.report) !== null;
}

/** Confidence-weighted mean of the window's run scores, rounded; `null` for an empty window. */
function windowScore(window) {
  if (!window.length) return null;
  const weighted = window.reduce((acc, run) => {
    const weight = CONFIDENCE_WEIGHT[run.report.confidence];
    return { sum: acc.sum + weight * qualityRunScore(run.report), weight: acc.weight + weight };
  }, { sum: 0, weight: 0 });
  return Math.round(weighted.sum / weighted.weight);
}

/**
 * Roll each category's recent measurements into the app's quality summary.
 *
 * A category's `score` is the confidence-weighted mean of its newest
 * `QUALITY_WINDOW_RUNS` qualifying runs (fresh, broad coverage, medium/high
 * confidence, scored); `window` reports how many runs fed it and the worst
 * severity any of them found. One run's slice score is slice noise — a 20-point
 * swing between consecutive runs carried no information — so the newest run
 * alone no longer decides the figure, and a newer partial run does not erase a
 * fresh scored one. With no qualifying run the row falls back to the newest
 * run's own score, shown beside its stale/partial/low-confidence evidence as
 * before, and does not contribute. Everything else about the row (coverage,
 * confidence, slice, `runScore`, summary, provenance, staleness) describes the
 * newest run.
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
export function summarizeAppQuality(records = [], now = Date.now(), { inapplicable = {} } = {}) {
  const runsByCategory = new Map();
  for (const record of records) {
    const category = normalizeAuditTaskType(record.category);
    const report = auditQualityReportSchema.safeParse(record.report);
    const valid = report.success && report.data.category === category;
    if (!runsByCategory.has(category)) runsByCategory.set(category, []);
    runsByCategory.get(category).push({ record, valid, report: valid ? report.data : null });
  }
  const categories = Object.entries(AUDIT_DEFINITIONS).map(([id, definition]) => {
    const runs = (runsByCategory.get(id) || []).sort((a, b) => compareQualityRecords(b.record, a.record));
    const latest = runs[0];
    const record = latest?.record;
    const valid = Boolean(latest?.valid);
    const assessedAt = record?.assessedAt;
    const stale = valid && !isFreshAssessment(assessedAt, now);
    const window = runs.filter(run => qualifiesForWindow(run, now)).slice(0, QUALITY_WINDOW_RUNS);
    const contributes = window.length > 0;
    // Only this install's own ruling, as the dispatch gate reads it: a peer's
    // or a release snapshot's describes a different checkout of the repository.
    const local = !record?.sourcePeerId && !record?.sourcePeerName;
    const reportedNotApplicable = valid && !stale && local && latest.report.coverage === 'not-applicable';
    const detectedReason = Object.hasOwn(inapplicable, id) ? inapplicable[id] : null;
    const applicable = contributes || !(reportedNotApplicable || detectedReason);
    const inapplicableReason = applicable ? null
      : detectedReason || 'the latest audit reported this category as not applicable';
    const { version: _version, category: _category, score: _score, sliceScore: _sliceScore, slice, ...latestFields } = latest?.report || {};
    const runScore = valid ? qualityRunScore(latest.report) : null;
    return { id, label: definition.label, ...(valid ? latestFields : { coverage: 'unavailable' }),
      score: contributes ? windowScore(window) : runScore, runScore, slice: valid ? slice ?? null : null,
      window: { runs: window.length, worstSeverity: window.length ? Math.max(...window.map(run => run.report.worstSeverity)) : null },
      assessedAt: assessedAt || null, agentId: record?.agentId || null, sourcePeerId: record?.sourcePeerId || null, sourcePeerName: record?.sourcePeerName || null, stale, contributes, applicable, inapplicableReason };
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
    const summary = summarizeAppQuality(known, asOf);
    points.push({ date: new Date(day).toISOString().slice(0, 10), score: summary.score,
      ratedCategories: summary.ratedCategories,
      categories: Object.fromEntries(summary.categories.map(c => [c.id, {
        score: c.stale ? null : c.score, coverage: c.coverage, confidence: c.confidence ?? null,
      }])) });
  }
  return { days, totalCategories: Object.keys(AUDIT_DEFINITIONS).length, points };
}

/**
 * One measurement per category per UTC day — the newest run that day, with a
 * stable run tie-break across all installs — in ascending order. The same run
 * can reach a reader twice: as the local row and again through the release
 * snapshot it was published into, which keeps only the day. Collapsing to the
 * day is what stops the rolling window counting that run twice, and matches the
 * daily winners the history query and the wire export already select.
 */
export function dailyQualityRecords(records) {
  const byDay = new Map();
  for (const record of [...records].sort(compareQualityRecords)) {
    const normalized = { ...record, category: normalizeAuditTaskType(record.category) };
    const time = Date.parse(normalized.assessedAt);
    const day = Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : String(normalized.assessedAt);
    byDay.set(`${normalized.category}|${day}`, normalized);
  }
  return [...byDay.values()].sort(compareQualityRecords);
}

export function compareQualityRecords(a, b) {
  return Date.parse(a.assessedAt) - Date.parse(b.assessedAt)
    || (a.measurementId || a.agentId || '').localeCompare(b.measurementId || b.agentId || '');
}

export const appQualityFederationQuerySchema = appQualityHistoryQuerySchema.extend({
  repository: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // The categories the requesting install can parse, comma-separated. Absent on
  // a request from an install that predates it — see FEDERATION_LEGACY_CATEGORIES.
  categories: z.string().max(4000).regex(/^[a-z0-9-]+(,[a-z0-9-]+)*$/).optional()
    .transform(value => (value ? value.split(',') : undefined)),
});
