// Pure helpers for the Editorial Checks page (#1285) — catalog grouping,
// findings triage grouping, and manuscript deep-link building. No React, no
// window: the page component and its unit tests both consume these.

// Scope display order + labels (mirrors server CHECK_SCOPES). A check whose
// scope isn't one of these still renders, bucketed under its raw scope last.
export const CHECK_SCOPE_ORDER = Object.freeze(['noun', 'scene', 'issue', 'series']);
export const CHECK_SCOPE_LABELS = Object.freeze({
  noun: 'Noun',
  scene: 'Scene',
  issue: 'Issue',
  series: 'Series',
});

export const scopeLabel = (scope) =>
  CHECK_SCOPE_LABELS[scope] || (scope ? scope[0].toUpperCase() + scope.slice(1) : 'Other');

// A finding's editorial category (continuity / pacing / style / …) — distinct
// from its check scope. Mirrors the server's normalization in editorialScore.js
// so the triage facet and the health panel's "open by category" agree.
export const normCategory = (comment) =>
  (typeof comment?.category === 'string' && comment.category) ? comment.category : 'other';

// Title-case a raw category token for display in the toolbar select.
export const categoryLabel = (category) =>
  category ? category[0].toUpperCase() + category.slice(1) : 'Other';

// URL params that persist the triage filters/sort (#1600). `f`-prefixed so they
// never collide with the page's own `series` / `custom` params. Exported (rather
// than living in the triage component) so the health panel can deep-link the
// triage to a category/check from its clickable breakdown rows (#1606).
export const FINDING_FILTER_PARAMS = Object.freeze({
  severity: 'fsev',
  status: 'fstatus',
  scope: 'fscope',
  check: 'fcheck',
  issue: 'fissue',
  category: 'fcat',
  query: 'fq',
  sort: 'fsort',
});
export const ALL_FINDING_FILTER_PARAMS = Object.freeze(Object.values(FINDING_FILTER_PARAMS));

// DOM id on the triage container so the health panel can scroll the findings
// list into view after deep-linking a filter (#1606) — single source of truth
// shared by the panel (scroll target) and the triage (anchor).
export const FINDINGS_TRIAGE_ANCHOR_ID = 'editorial-findings-triage';

const SEVERITY_ORDER = Object.freeze(['high', 'medium', 'low']);

// Tailwind badge classes for a finding/check severity (rose/amber/gray) — the
// shared editorial severity palette, used by the catalog card's severity badge
// and the custom-check preview's sample findings so the styling stays consistent
// across the editorial UI. Callers supply their own fallback level.
export const SEVERITY_BADGE_CLASSES = Object.freeze({
  high: 'bg-rose-500/15 text-rose-300',
  medium: 'bg-amber-500/15 text-amber-300',
  low: 'bg-gray-500/15 text-gray-300',
});

/**
 * Group catalog rows into ordered scope sections for the catalog view.
 * Returns `[{ scope, label, checks }]` in CHECK_SCOPE_ORDER, with any unknown
 * scope appended after the known ones (alphabetical). Empty scopes are omitted.
 */
export function groupChecksByScope(checks = []) {
  const byScope = new Map();
  for (const check of checks) {
    const scope = check?.scope || 'other';
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(check);
  }
  const known = CHECK_SCOPE_ORDER.filter((s) => byScope.has(s));
  const unknown = [...byScope.keys()].filter((s) => !CHECK_SCOPE_ORDER.includes(s)).sort();
  return [...known, ...unknown].map((scope) => ({
    scope,
    label: scopeLabel(scope),
    checks: byScope.get(scope),
  }));
}

const emptyCounts = () => ({ high: 0, medium: 0, low: 0 });

/**
 * Group review comments that came from an editorial check into per-check
 * sections for the triage view. Only comments carrying a `checkId` are
 * included (completeness findings have none). Returns
 *   `[{ checkId, label, description, scope, kind, comments, open, total, counts, stale }]`
 * ordered by the catalog's scope order then label, with `counts` tallying the
 * OPEN comments by severity and `stale` counting the OPEN findings whose
 * analyzed content has drifted since the check ran (#1345). `rowsById` is a
 * Map/object of catalog rows so each group can show its human label, kind, and
 * documented purpose (#1604) even when the check is currently disabled.
 */
export function groupFindingsByCheck(comments = [], rowsById = {}) {
  const lookup = rowsById instanceof Map ? rowsById : new Map(Object.entries(rowsById || {}));
  const groups = new Map();
  for (const c of comments) {
    if (!c?.checkId) continue;
    if (!groups.has(c.checkId)) {
      const row = lookup.get(c.checkId) || null;
      groups.set(c.checkId, {
        checkId: c.checkId,
        label: row?.label || c.checkId,
        description: row?.description || null,
        scope: row?.scope || 'other',
        kind: row?.kind || null,
        comments: [],
        open: 0,
        total: 0,
        counts: emptyCounts(),
        stale: 0,
        // Dismissal tally (#1605): `dismissed` counts every dismissed finding,
        // `falsePositive` the subset flagged as a broken check. The ratio drives
        // the per-check quality signal in the catalog/triage view.
        dismissed: 0,
        falsePositive: 0,
      });
    }
    const g = groups.get(c.checkId);
    g.comments.push(c);
    g.total += 1;
    if (c.status === 'open') {
      g.open += 1;
      const sev = SEVERITY_ORDER.includes(c.severity) ? c.severity : 'low';
      g.counts[sev] += 1;
      if (c.stale) g.stale += 1;
    } else if (c.status === 'dismissed') {
      g.dismissed += 1;
      if (c.dismissReason === 'false-positive') g.falsePositive += 1;
    }
  }
  // Stamp a stable false-positive rate over the FULL finding set (#1605) so the
  // catalog/triage quality signal stays correct even when a status filter later
  // recounts `total` to the matched subset (see applyFindingsView/recountGroup).
  for (const g of groups.values()) {
    g.falsePositiveRate = g.total > 0 ? g.falsePositive / g.total : null;
  }
  const scopeRank = (s) => {
    const i = CHECK_SCOPE_ORDER.indexOf(s);
    return i === -1 ? CHECK_SCOPE_ORDER.length : i;
  };
  return [...groups.values()].sort((a, b) =>
    scopeRank(a.scope) - scopeRank(b.scope) || a.label.localeCompare(b.label));
}

/** Total OPEN check-sourced findings across all groups — drives the header badge. */
export const openFindingsTotal = (groups = []) =>
  groups.reduce((sum, g) => sum + g.open, 0);

/**
 * Per-check false-positive rate (#1605): the fraction of a check's findings the
 * user flagged as a broken check (`false-positive` dismissals over total
 * findings). `null` when the check has surfaced nothing yet, so callers can
 * distinguish "no data" from a genuine 0%. Prefers the stable rate stamped by
 * `groupFindingsByCheck` (immune to status-filter recounts), falling back to a
 * direct compute for hand-built groups.
 */
export const checkFalsePositiveRate = (group) => {
  if (!group) return null;
  if (group.falsePositiveRate !== undefined) return group.falsePositiveRate;
  return group.total > 0 ? group.falsePositive / group.total : null;
};

/**
 * Deep-link a finding into the manuscript editor: focuses the finding's issue
 * (when it has one) and opens its comment card via the `?comment=` param the
 * editor honors. Series-scoped findings (no issueNumber) land on the bare
 * manuscript route with the card opened from the review sidebar.
 */
export function findingManuscriptLink(seriesId, comment) {
  const base = `/pipeline/series/${encodeURIComponent(seriesId)}/manuscript`;
  const path = Number.isInteger(comment?.issueNumber)
    ? `${base}/${comment.issueNumber}`
    : base;
  return comment?.id ? `${path}?comment=${encodeURIComponent(comment.id)}` : path;
}

// ---- Findings triage filtering + sorting (#1600). Pure so the page and its
// unit tests share them; the component owns the URL-param plumbing. ----

const FINDING_SEVERITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });
const FINDING_STATUS_RANK = Object.freeze({ open: 0, accepted: 1, dismissed: 2 });
const severityRank = (s) => (s in FINDING_SEVERITY_RANK ? FINDING_SEVERITY_RANK[s] : 2);
const statusRank = (s) => (s in FINDING_STATUS_RANK ? FINDING_STATUS_RANK[s] : 99);
const normSeverity = (c) => (c?.severity in FINDING_SEVERITY_RANK ? c.severity : 'low');
const normStatus = (c) => (c?.status === 'accepted' || c?.status === 'dismissed' ? c.status : 'open');

/** The issue facet key for a finding: its issue number as a string, or `none` for series-wide. */
export const findingIssueKey = (comment) =>
  (Number.isInteger(comment?.issueNumber) ? String(comment.issueNumber) : 'none');

/** Sort options offered in the triage toolbar. `id` is what persists in the URL. */
export const FINDING_SORT_OPTIONS = Object.freeze([
  { id: 'scope', label: 'Scope & check' },
  { id: 'severity', label: 'Severity' },
  { id: 'issue', label: 'Issue' },
  { id: 'status', label: 'Status' },
]);
const FINDING_SORT_IDS = Object.freeze(FINDING_SORT_OPTIONS.map((o) => o.id));
/** Coerce an arbitrary `sort` value to a known option id (default `scope`). */
export const normalizeFindingSort = (sort) => (FINDING_SORT_IDS.includes(sort) ? sort : 'scope');

/**
 * Enumerate the filter facets actually present in the current findings, so the
 * toolbar only offers values that exist. Takes the already-grouped findings
 * (groups carry the resolved scope + check label). Returns
 *   `{ severities:Set, statuses:Set, scopes:[{scope,label}], checks:[{id,label}], issues:[{key,label}] }`
 * with checks ordered as the groups are (scope→label) and issues numeric-ascending
 * with the series-wide bucket last.
 */
export function deriveFindingFacets(groups = []) {
  const severities = new Set();
  const statuses = new Set();
  const scopes = new Map();
  const checks = [];
  const issues = new Map();
  const categories = new Map();
  for (const g of groups) {
    if (!scopes.has(g.scope)) scopes.set(g.scope, scopeLabel(g.scope));
    checks.push({ id: g.checkId, label: g.label });
    for (const c of g.comments) {
      severities.add(normSeverity(c));
      statuses.add(normStatus(c));
      const cat = normCategory(c);
      if (!categories.has(cat)) categories.set(cat, categoryLabel(cat));
      const key = findingIssueKey(c);
      if (!issues.has(key)) issues.set(key, key === 'none' ? 'Series-wide' : `Issue ${c.issueNumber}`);
    }
  }
  const issueList = [...issues.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => {
      if (a.key === 'none') return 1;
      if (b.key === 'none') return -1;
      return Number(a.key) - Number(b.key);
    });
  return {
    severities,
    statuses,
    scopes: [...scopes.entries()].map(([scope, label]) => ({ scope, label })),
    checks,
    issues: issueList,
    categories: [...categories.entries()]
      .map(([category, label]) => ({ category, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

// A single comment passes the comment-level filters (severity/status/issue/query).
// Scope + check are group-level and filtered separately.
function commentPassesFilters(c, filters) {
  const { severities, statuses, issues, categories, query } = filters;
  if (severities?.size && !severities.has(normSeverity(c))) return false;
  if (statuses?.size && !statuses.has(normStatus(c))) return false;
  if (categories?.size && !categories.has(normCategory(c))) return false;
  if (issues?.size && !issues.has(findingIssueKey(c))) return false;
  if (query) {
    const hay = `${c.problem || ''} ${c.location || ''}`.toLowerCase();
    if (!hay.includes(query.toLowerCase())) return false;
  }
  return true;
}

// Recompute a group's open/total/severity counts + stale tally from a filtered
// comment subset so the header reflects what's actually shown (never lies).
function recountGroup(group, comments) {
  const counts = emptyCounts();
  let open = 0;
  let stale = 0;
  for (const c of comments) {
    if (normStatus(c) === 'open') {
      open += 1;
      counts[normSeverity(c)] += 1;
      if (c.stale) stale += 1;
    }
  }
  return { ...group, comments, open, total: comments.length, counts, stale };
}

function sortComments(comments, sort) {
  if (sort === 'scope') return comments;
  const cmp = {
    severity: (a, b) => severityRank(normSeverity(a)) - severityRank(normSeverity(b))
      || statusRank(normStatus(a)) - statusRank(normStatus(b)),
    status: (a, b) => statusRank(normStatus(a)) - statusRank(normStatus(b))
      || severityRank(normSeverity(a)) - severityRank(normSeverity(b)),
    issue: (a, b) => {
      const an = Number.isInteger(a.issueNumber) ? a.issueNumber : Infinity;
      const bn = Number.isInteger(b.issueNumber) ? b.issueNumber : Infinity;
      return an - bn || severityRank(normSeverity(a)) - severityRank(normSeverity(b));
    },
  }[sort];
  // Stable sort over a copy so the original grouping order is the tiebreak.
  return comments
    .map((c, i) => [c, i])
    .sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1])
    .map(([c]) => c);
}

// Order the groups to match the chosen sort, so a multi-check view reads as
// sorted across groups — not just within each one. Each group's lead value comes
// from its already-sorted comments (e.g. its lowest issue number / best status).
function sortGroups(groups, sort) {
  if (sort === 'severity') {
    // Surface the checks with the most severe findings first. Tally severity over
    // ALL visible comments (group.counts is open-only, so a resolved-only filtered
    // view would tie at zero) and compare tiers lexicographically (high, then
    // medium, then low) so a single high always outranks any volume of lower ones.
    const sevCounts = new Map(groups.map((g) => {
      const c = emptyCounts();
      for (const x of g.comments) c[normSeverity(x)] += 1;
      return [g, c];
    }));
    return [...groups].sort((a, b) => {
      const ca = sevCounts.get(a);
      const cb = sevCounts.get(b);
      return (cb.high - ca.high) || (cb.medium - ca.medium) || (cb.low - ca.low)
        || (b.comments.length - a.comments.length);
    });
  }
  if (sort === 'issue') {
    const leadIssue = (g) => {
      const c = g.comments.find((x) => Number.isInteger(x.issueNumber));
      return c ? c.issueNumber : Infinity; // series-wide-only groups sort last
    };
    return [...groups].sort((a, b) => leadIssue(a) - leadIssue(b) || a.label.localeCompare(b.label));
  }
  if (sort === 'status') {
    const leadStatus = (g) => Math.min(...g.comments.map((c) => statusRank(normStatus(c))));
    return [...groups].sort((a, b) => leadStatus(a) - leadStatus(b) || a.label.localeCompare(b.label));
  }
  return groups; // scope: already scope→label ordered
}

/**
 * Apply the toolbar's filters + sort to the grouped findings. Drops groups whose
 * scope/check is filtered out or that have no comment matching the comment-level
 * filters, recomputes each surviving group's counts, sorts findings within each
 * group, then orders the groups. `filters` carries Sets for severities, statuses,
 * scopes, checkIds, issues, categories plus a `query` string; any empty/absent
 * facet is "all".
 */
export function applyFindingsView(groups = [], filters = {}, sort = 'scope') {
  const view = normalizeFindingSort(sort);
  const out = [];
  for (const g of groups) {
    if (filters.scopes?.size && !filters.scopes.has(g.scope)) continue;
    if (filters.checkIds?.size && !filters.checkIds.has(g.checkId)) continue;
    const matched = g.comments.filter((c) => commentPassesFilters(c, filters));
    if (!matched.length) continue;
    out.push(recountGroup(g, sortComments(matched, view)));
  }
  return sortGroups(out, view);
}
