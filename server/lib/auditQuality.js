import { z } from 'zod';
import { AUDIT_DEFINITIONS } from './auditCatalog.js';
import { safeJSONParse } from './jsonIo.js';

const REPORT_PREFIX = 'QUALITY_AUDIT_JSON: ';

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
  ux: 'Inventory primary user goals and route flows; rank blocked task completion, onboarding friction, navigation dead ends and missing recovery, then walk the worst journeys.',
  'data-safety': 'Inventory destructive writes, migrations, backup/restore and cross-version payloads; rank irreversible data loss and incompatible upgrades first.',
  simplify: 'Scan source exports, callers and repeated blocks across the repository; rank proven dead subsystems and duplicated behavior by maintenance cost and drift.',
  'module-hygiene': 'Inventory module sizes, imports, responsibilities and catalogs across source roots; inspect the largest responsibility tangles and most reused missing abstractions.',
  'api-contract': 'Inventory all routes, schemas and clients; compare request/response and version contracts, prioritizing destructive writes and widely consumed APIs.',
  'react-lifecycle': 'Scan effects, subscriptions, async state updates and shared hooks across components; rank resource leaks, stale writes and corrupted user state.',
  observability: 'Inventory critical workflows and their failure/status signals; rank invisible data loss, silent failures and operations that cannot be diagnosed.',
  copy: 'Inventory shared messages, destructive confirmations, setup and empty/error screens; rank wording that causes wrong actions or prevents task completion.',
  'better-complexity': 'Run an available language-aware complexity analyzer over all first-party source roots. Otherwise use repository-wide branching searches to shortlist functions, then count decision points manually. Publish the top measured functions and counts; file length is only a discovery hint.',
  'better-cognitive-load': 'Scan deeply nested control flow, boolean flags, mixed abstraction levels and misleading names across source roots; rank reader cost in critical, widely used workflows.',
  'better-structural-drift': 'Inventory generators, duplicated registries and derived artifacts; inspect independently edited sources of truth and position-keyed records, ranking demonstrated drift and merge churn.',
  'better-runtime-safety': 'Scan asynchronous callbacks, resource cleanup, nullable access and process lifecycles across source roots; rank reachable crashes, corrupted state and leaked resources.',
  'better-dependency-freedom': 'Inventory manifests and actual imports across packages; rank dependency cost, advisory exposure and removable surface against the complexity of a concrete replacement.',
  'better-test-quality': 'Inventory suites and public boundaries; search assertion-free tests, overmocking, tautologies and redundant cases, prioritizing suites that falsely protect critical behavior.',
});

export function auditQualityInstructions(taskType) {
  if (!Object.hasOwn(AUDIT_DEFINITIONS, taskType)) return '';
  return `## Repository-wide discovery, worst offender first, and quality assessment

This contract overrides narrower slice-selection or ranking advice in the mission, including customized prompts. Preserve the selected file-issues/fix mode and documented non-issues.
1. Inventory all first-party source roots with git ls-files or rg --files, excluding vendored/generated/build/dependency output. Do a cheap repository-wide signal scan BEFORE choosing where to investigate. Do not deep-read the entire repository.
2. Category search: ${AUDIT_DISCOVERY[taskType]}
3. Rank at least the top five candidates (or all if fewer), with paths, measured signals, impact, reach, confidence and why higher candidates win. Validate the top candidates through callers, tests and relevant history before filing or fixing. Severity and user impact outrank ease, small scope and recency. Churn and fan-in break ties; inactivity alone never dismisses a severe offender. If the raw worst is exempt, already filed or not actionable, report why and continue down the ranking. Existing unresolved issues still count against quality. Never pick a nit while a verified major problem remains actionable.
4. Keep investigation bounded after this scan. Report scanned roots, tools/commands, candidate ranking, exclusions, reviewed paths, unreviewed inventory and stopping reason. If tools or budget prevent broad discovery, report partial coverage, never claim a global worst or a clean repository.
5. Assess the PRE-FIX codebase for this category on 0–100 (higher is healthier): 90–100 no material defect found after broad evidence; 70–89 localized moderate debt; 40–69 significant recurring or widespread problems; 10–39 severe/core-workflow defects; 0–9 pervasive critical failure. Score the category, not the agent's performance or issue count. Explain the score using severity, prevalence and concrete evidence. Do not award points merely for filing or fixing this run. Use score:null for unavailable or inapplicable assessment; zero is a real score.
6. Score the worst finding's severity separately on 1–10: 1–3 minor localized impact, 4–6 material recurring cost, 7–8 major workflow/reliability impact, 9–10 critical data/security/availability failure. Use 0 only when no material finding was verified. List this severity for every finding in the narrative.
7. Include exactly one single-line QUALITY_AUDIT_JSON: {...} in your completion sentinel summary AND final response, with no secrets or personal data. Replace the example values with observed evidence. The category is fixed to this task; do not rate other categories. Keep ordinary completion/PR instructions and summaries too.
QUALITY_AUDIT_JSON: {"version":1,"category":"${taskType}","score":null,"worstSeverity":0,"coverage":"unavailable","confidence":"low","summary":"Explain the assessment and strongest evidence","scannedFiles":0,"totalFiles":0}
Allowed coverage: broad, partial, unavailable, not-applicable. Allowed confidence: low, medium, high. scannedFiles counts files actually included in the category signal scan; totalFiles is the eligible inventory. Broad requires the whole inventory to be scanned (deep review remains bounded). Partial scores are provisional and excluded from the overall score. If unavailable or not-applicable, score must be null and explain why. Even a zero-finding audit returns this assessment.`;
}

export const appQualityQuerySchema = z.object({ includeQuality: z.enum(['true', 'false']).optional() });

export const auditQualityReportSchema = z.object({
  version: z.literal(1),
  category: z.string().refine(value => Object.hasOwn(AUDIT_DEFINITIONS, value)),
  score: z.number().int().min(0).max(100).nullable(),
  worstSeverity: z.number().int().min(0).max(10),
  coverage: z.enum(['broad', 'partial', 'unavailable', 'not-applicable']),
  confidence: z.enum(['low', 'medium', 'high']),
  summary: z.string().trim().min(1).max(2000),
  scannedFiles: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
}).strict().refine(r => r.scannedFiles <= r.totalFiles)
  .refine(r => ['unavailable', 'not-applicable'].includes(r.coverage) ? r.score === null : r.score !== null && r.scannedFiles > 0)
  .refine(r => r.coverage !== 'broad' || (r.totalFiles > 0 && r.scannedFiles === r.totalFiles));

export function parseAuditQualityReport(summary, category) {
  if (typeof summary !== 'string') return null;
  const lines = summary.split(/\r?\n/).filter(line => line.startsWith(REPORT_PREFIX));
  if (lines.length !== 1) return null;
  const parsed = auditQualityReportSchema.safeParse(safeJSONParse(lines[0].slice(REPORT_PREFIX.length), null));
  return parsed.success && parsed.data.category === category ? parsed.data : null;
}

export const AUDIT_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

export function summarizeAppQuality(records = [], now = Date.now()) {
  const categories = Object.entries(AUDIT_DEFINITIONS).map(([id, definition]) => {
    const record = records.find(row => row.category === id);
    const report = auditQualityReportSchema.safeParse(record?.report);
    const valid = report.success && report.data.category === id;
    const assessedAt = record?.assessedAt;
    const age = now - Date.parse(assessedAt);
    const stale = valid && (!Number.isFinite(age) || age < 0 || age > AUDIT_FRESHNESS_MS);
    return { id, label: definition.label, ...(valid ? report.data : { score: null, coverage: 'unavailable' }), assessedAt: assessedAt || null, agentId: record?.agentId || null, stale };
  });
  const rated = categories.filter(c => !c.stale && c.coverage === 'broad' && c.confidence !== 'low' && c.score !== null);
  return {
    score: rated.length ? Math.round(rated.reduce((sum, c) => sum + c.score, 0) / rated.length) : null,
    ratedCategories: rated.length,
    totalCategories: categories.length,
    categories,
  };
}

export const appQualityHistoryQuerySchema = z.object({ days: z.enum(['30', '90', '365']).default('90').transform(Number) });

/** Daily UTC snapshots of evidence available then; never backfill past scores. */
export function buildAppQualityHistory(records, days, now = Date.now()) {
  const dayMs = 86400000;
  const today = Math.floor(now / dayMs) * dayMs;
  const sorted = records.filter(r => Number.isFinite(Date.parse(r.assessedAt)))
    .sort((a, b) => Date.parse(a.assessedAt) - Date.parse(b.assessedAt));
  const latest = new Map();
  let cursor = 0;
  const points = [];
  for (let day = today - (days - 1) * dayMs; day <= today; day += dayMs) {
    const asOf = Math.min(day + dayMs - 1, now);
    while (cursor < sorted.length && Date.parse(sorted[cursor].assessedAt) <= asOf) {
      const record = sorted[cursor++];
      latest.set(record.category, record);
    }
    const summary = summarizeAppQuality([...latest.values()], asOf);
    points.push({ date: new Date(day).toISOString().slice(0, 10), score: summary.score,
      ratedCategories: summary.ratedCategories,
      categories: Object.fromEntries(summary.categories.map(c => [c.id, {
        score: c.stale ? null : c.score, coverage: c.coverage, confidence: c.confidence ?? null,
      }])) });
  }
  return { days, totalCategories: Object.keys(AUDIT_DEFINITIONS).length, points };
}
