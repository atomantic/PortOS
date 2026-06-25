import { describe, it, expect } from 'vitest';
import {
  groupChecksByScope,
  groupFindingsByCheck,
  openFindingsTotal,
  findingManuscriptLink,
  scopeLabel,
  deriveFindingFacets,
  applyFindingsView,
  normalizeFindingSort,
  findingIssueKey,
} from './editorialChecks.js';

const checks = [
  { id: 'a.series', label: 'Series check', scope: 'series', kind: 'deterministic' },
  { id: 'b.issue', label: 'Issue check', scope: 'issue', kind: 'llm' },
  { id: 'c.noun', label: 'Noun check', scope: 'noun', kind: 'deterministic' },
  { id: 'd.weird', label: 'Weird scope', scope: 'galaxy', kind: 'deterministic' },
];

describe('groupChecksByScope', () => {
  it('orders known scopes noun→scene→issue→series and appends unknown last', () => {
    const groups = groupChecksByScope(checks);
    expect(groups.map((g) => g.scope)).toEqual(['noun', 'issue', 'series', 'galaxy']);
    expect(groups.map((g) => g.label)).toEqual(['Noun', 'Issue', 'Series', 'Galaxy']);
  });

  it('omits scopes with no checks and tolerates an empty list', () => {
    expect(groupChecksByScope([{ id: 'x', scope: 'noun' }]).map((g) => g.scope)).toEqual(['noun']);
    expect(groupChecksByScope()).toEqual([]);
  });
});

describe('groupFindingsByCheck', () => {
  const rows = {
    'a.series': { label: 'Series check', scope: 'series', kind: 'deterministic' },
    'b.issue': { label: 'Issue check', scope: 'issue', kind: 'llm' },
  };
  const comments = [
    { id: '1', checkId: 'a.series', status: 'open', severity: 'high' },
    { id: '2', checkId: 'a.series', status: 'open', severity: 'low' },
    { id: '3', checkId: 'a.series', status: 'dismissed', severity: 'high' },
    { id: '4', checkId: 'b.issue', status: 'open', severity: 'medium' },
    { id: '5', status: 'open', severity: 'high' }, // completeness finding — no checkId, excluded
  ];

  it('groups only check-sourced comments and tallies open by severity', () => {
    const groups = groupFindingsByCheck(comments, rows);
    // issue scope sorts before series scope.
    expect(groups.map((g) => g.checkId)).toEqual(['b.issue', 'a.series']);
    const series = groups.find((g) => g.checkId === 'a.series');
    expect(series.total).toBe(3);
    expect(series.open).toBe(2);
    expect(series.counts).toEqual({ high: 1, medium: 0, low: 1 });
  });

  it('falls back to the checkId as label when the check is unknown', () => {
    const groups = groupFindingsByCheck([{ id: '9', checkId: 'gone.check', status: 'open', severity: 'low' }], {});
    expect(groups[0].label).toBe('gone.check');
  });

  it('accepts a Map of rows as well as a plain object', () => {
    const groups = groupFindingsByCheck(comments, new Map(Object.entries(rows)));
    expect(groups.find((g) => g.checkId === 'b.issue').label).toBe('Issue check');
  });

  it('openFindingsTotal sums open findings across groups', () => {
    expect(openFindingsTotal(groupFindingsByCheck(comments, rows))).toBe(3);
  });

  it('tallies the per-group stale count from OPEN findings only (#1345)', () => {
    const staleComments = [
      { id: '1', checkId: 'a.series', status: 'open', severity: 'high', stale: true },
      { id: '2', checkId: 'a.series', status: 'open', severity: 'low' }, // fresh
      { id: '3', checkId: 'a.series', status: 'dismissed', severity: 'high', stale: true }, // dismissed → not counted
      { id: '4', checkId: 'b.issue', status: 'open', severity: 'medium' }, // no stale field
    ];
    const groups = groupFindingsByCheck(staleComments, rows);
    expect(groups.find((g) => g.checkId === 'a.series').stale).toBe(1);
    expect(groups.find((g) => g.checkId === 'b.issue').stale).toBe(0);
  });
});

describe('findingManuscriptLink', () => {
  it('targets the finding\'s issue and opens its comment when it has an issueNumber', () => {
    expect(findingManuscriptLink('ser-1', { id: 'c9', issueNumber: 5 }))
      .toBe('/pipeline/series/ser-1/manuscript/5?comment=c9');
  });

  it('lands on the bare manuscript route for series-scoped findings (no issueNumber)', () => {
    expect(findingManuscriptLink('ser-1', { id: 'c9', issueNumber: null }))
      .toBe('/pipeline/series/ser-1/manuscript?comment=c9');
  });

  it('omits the comment param when the finding has no id', () => {
    expect(findingManuscriptLink('ser-1', { issueNumber: 2 }))
      .toBe('/pipeline/series/ser-1/manuscript/2');
  });
});

describe('scopeLabel', () => {
  it('maps known scopes and title-cases unknown ones', () => {
    expect(scopeLabel('series')).toBe('Series');
    expect(scopeLabel('galaxy')).toBe('Galaxy');
    expect(scopeLabel('')).toBe('Other');
  });
});

const findingsFixture = () => [
  { id: 'a1', checkId: 'pacing', status: 'open', severity: 'high', issueNumber: 2, problem: 'Slow open', location: 'p1' },
  { id: 'a2', checkId: 'pacing', status: 'dismissed', severity: 'low', issueNumber: 2, problem: 'Old note' },
  { id: 'b1', checkId: 'naming', status: 'open', severity: 'medium', issueNumber: 1, problem: 'Confusable names' },
  { id: 'b2', checkId: 'naming', status: 'open', severity: 'low', issueNumber: null, problem: 'Series-wide naming' },
];
const fixtureRows = {
  pacing: { label: 'Pacing', scope: 'scene' },
  naming: { label: 'Naming', scope: 'series' },
};
const groupsFixture = () => groupFindingsByCheck(findingsFixture(), fixtureRows);

describe('findingIssueKey', () => {
  it('keys by issue number, bucketing series-wide findings under "none"', () => {
    expect(findingIssueKey({ issueNumber: 5 })).toBe('5');
    expect(findingIssueKey({ issueNumber: null })).toBe('none');
    expect(findingIssueKey({})).toBe('none');
  });
});

describe('normalizeFindingSort', () => {
  it('passes through known sort ids and defaults unknown to scope', () => {
    expect(normalizeFindingSort('severity')).toBe('severity');
    expect(normalizeFindingSort('issue')).toBe('issue');
    expect(normalizeFindingSort('bogus')).toBe('scope');
    expect(normalizeFindingSort(undefined)).toBe('scope');
  });
});

describe('deriveFindingFacets', () => {
  it('enumerates only the facets present, ordering checks scope→label and issues numeric-then-none', () => {
    const f = deriveFindingFacets(groupsFixture());
    expect([...f.severities].sort()).toEqual(['high', 'low', 'medium']);
    expect([...f.statuses].sort()).toEqual(['dismissed', 'open']);
    // scene (Pacing) sorts before series (Naming) per CHECK_SCOPE_ORDER.
    expect(f.checks.map((c) => c.id)).toEqual(['pacing', 'naming']);
    expect(f.scopes.map((s) => s.scope)).toEqual(['scene', 'series']);
    expect(f.issues.map((i) => i.key)).toEqual(['1', '2', 'none']);
    expect(f.issues.find((i) => i.key === 'none').label).toBe('Series-wide');
  });
});

describe('applyFindingsView', () => {
  it('returns all groups unchanged when no filters are active', () => {
    const view = applyFindingsView(groupsFixture(), {}, 'scope');
    expect(view.map((g) => g.checkId)).toEqual(['pacing', 'naming']);
    expect(view.reduce((n, g) => n + g.comments.length, 0)).toBe(4);
  });

  it('filters by severity and recomputes the group counts to match', () => {
    const view = applyFindingsView(groupsFixture(), { severities: new Set(['high']) }, 'scope');
    expect(view).toHaveLength(1);
    expect(view[0].checkId).toBe('pacing');
    expect(view[0].comments.map((c) => c.id)).toEqual(['a1']);
    expect(view[0].open).toBe(1);
    expect(view[0].total).toBe(1);
    expect(view[0].counts).toEqual({ high: 1, medium: 0, low: 0 });
  });

  it('filters by status (open only) dropping resolved findings', () => {
    const view = applyFindingsView(groupsFixture(), { statuses: new Set(['open']) }, 'scope');
    const ids = view.flatMap((g) => g.comments.map((c) => c.id));
    expect(ids).toEqual(['a1', 'b1', 'b2']);
  });

  it('filters by scope (category) and by check id', () => {
    const byScope = applyFindingsView(groupsFixture(), { scopes: new Set(['series']) }, 'scope');
    expect(byScope.map((g) => g.checkId)).toEqual(['naming']);
    const byCheck = applyFindingsView(groupsFixture(), { checkIds: new Set(['pacing']) }, 'scope');
    expect(byCheck.map((g) => g.checkId)).toEqual(['pacing']);
  });

  it('filters by issue, including the series-wide "none" bucket', () => {
    const issue2 = applyFindingsView(groupsFixture(), { issues: new Set(['2']) }, 'scope');
    expect(issue2.flatMap((g) => g.comments.map((c) => c.id))).toEqual(['a1', 'a2']);
    const seriesWide = applyFindingsView(groupsFixture(), { issues: new Set(['none']) }, 'scope');
    expect(seriesWide.flatMap((g) => g.comments.map((c) => c.id))).toEqual(['b2']);
  });

  it('matches the free-text query against problem and location, case-insensitively', () => {
    const view = applyFindingsView(groupsFixture(), { query: 'confusable' }, 'scope');
    expect(view.flatMap((g) => g.comments.map((c) => c.id))).toEqual(['b1']);
    const byLocation = applyFindingsView(groupsFixture(), { query: 'P1' }, 'scope');
    expect(byLocation.flatMap((g) => g.comments.map((c) => c.id))).toEqual(['a1']);
  });

  it('sorts findings within a group by severity (high→low) when sort=severity', () => {
    const view = applyFindingsView(groupsFixture(), { checkIds: new Set(['naming']) }, 'severity');
    expect(view[0].comments.map((c) => c.id)).toEqual(['b1', 'b2']); // medium before low
  });

  it('sorts groups by most-severe open findings first when sort=severity', () => {
    // pacing has a high open finding; naming's most severe open is medium.
    const view = applyFindingsView(groupsFixture(), {}, 'severity');
    expect(view.map((g) => g.checkId)).toEqual(['pacing', 'naming']);
  });

  it('sorts findings by issue number with series-wide last when sort=issue', () => {
    const view = applyFindingsView(groupsFixture(), { checkIds: new Set(['naming']) }, 'issue');
    expect(view[0].comments.map((c) => c.id)).toEqual(['b1', 'b2']); // issue 1 before series-wide
  });

  it('orders GROUPS by their lowest issue number when sort=issue (not just rows)', () => {
    // naming's lowest issue is 1; pacing's is 2 — so naming leads even though the
    // default scope order puts scene-scoped pacing first.
    const view = applyFindingsView(groupsFixture(), {}, 'issue');
    expect(view.map((g) => g.checkId)).toEqual(['naming', 'pacing']);
  });

  it('orders GROUPS by best open status then label when sort=status', () => {
    // Both groups have an open finding (rank 0) → alphabetical tiebreak: Naming, Pacing.
    const view = applyFindingsView(groupsFixture(), {}, 'status');
    expect(view.map((g) => g.checkId)).toEqual(['naming', 'pacing']);
  });

  it('combines filters (AND semantics across facets)', () => {
    const view = applyFindingsView(
      groupsFixture(),
      { statuses: new Set(['open']), severities: new Set(['low']) },
      'scope',
    );
    expect(view.flatMap((g) => g.comments.map((c) => c.id))).toEqual(['b2']);
  });
});
