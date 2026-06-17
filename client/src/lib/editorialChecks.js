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

const SEVERITY_ORDER = Object.freeze(['high', 'medium', 'low']);

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
 *   `[{ checkId, label, scope, kind, comments, open, total, counts }]`
 * ordered by the catalog's scope order then label, with `counts` tallying the
 * OPEN comments by severity. `rowsById` is a Map/object of catalog rows so each
 * group can show its human label even when the check is currently disabled.
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
        scope: row?.scope || 'other',
        kind: row?.kind || null,
        comments: [],
        open: 0,
        total: 0,
        counts: emptyCounts(),
      });
    }
    const g = groups.get(c.checkId);
    g.comments.push(c);
    g.total += 1;
    if (c.status === 'open') {
      g.open += 1;
      const sev = SEVERITY_ORDER.includes(c.severity) ? c.severity : 'low';
      g.counts[sev] += 1;
    }
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
