import { describe, it, expect } from 'vitest';
import {
  groupChecksByScope,
  groupFindingsByCheck,
  checkFalsePositiveRate,
  openFindingsTotal,
  findingManuscriptLink,
  scopeLabel,
  categoryLabel,
  normCategory,
  deriveFindingFacets,
  applyFindingsView,
  normalizeFindingSort,
  findingIssueKey,
  canonEntitiesFromUniverse,
  linkifyCanonEntities,
  canonReferencesInText,
  canonEntityLink,
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

  it('fans a dual-scope check into each of its scopes (#1628)', () => {
    const dual = { id: 'r.reciprocity', label: 'Reciprocity', scopes: ['series', 'issue'], kind: 'llm' };
    const groups = groupChecksByScope([dual]);
    expect(groups.map((g) => g.scope)).toEqual(['issue', 'series']);
    // The same check appears under BOTH sections.
    expect(groups.find((g) => g.scope === 'issue').checks).toContain(dual);
    expect(groups.find((g) => g.scope === 'series').checks).toContain(dual);
  });

  it('falls back to the string scope when no scopes array is present (#1628)', () => {
    // Older API rows / peers carry only a string `scope`.
    expect(groupChecksByScope([{ id: 'x', scope: 'issue' }]).map((g) => g.scope)).toEqual(['issue']);
  });
});

describe('groupFindingsByCheck', () => {
  const rows = {
    'a.series': { label: 'Series check', scope: 'series', kind: 'deterministic', description: 'Checks the whole series.' },
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

  it('carries the catalog kind + description onto each group (#1604)', () => {
    const groups = groupFindingsByCheck(comments, rows);
    const series = groups.find((g) => g.checkId === 'a.series');
    const issue = groups.find((g) => g.checkId === 'b.issue');
    expect(series.kind).toBe('deterministic');
    expect(series.description).toBe('Checks the whole series.');
    // A row without a description falls back to null, not undefined/''.
    expect(issue.description).toBeNull();
  });

  it('falls back to the checkId as label and null description when the check is unknown', () => {
    const groups = groupFindingsByCheck([{ id: '9', checkId: 'gone.check', status: 'open', severity: 'low' }], {});
    expect(groups[0].label).toBe('gone.check');
    expect(groups[0].description).toBeNull();
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

  it('tallies dismissed + false-positive counts and stamps a stable rate (#1605)', () => {
    const fpComments = [
      { id: '1', checkId: 'a.series', status: 'open', severity: 'high' },
      { id: '2', checkId: 'a.series', status: 'dismissed', severity: 'low' }, // plain dismiss
      { id: '3', checkId: 'a.series', status: 'dismissed', severity: 'high', dismissReason: 'false-positive' },
      { id: '4', checkId: 'a.series', status: 'dismissed', severity: 'high', dismissReason: 'false-positive' },
      { id: '5', checkId: 'b.issue', status: 'open', severity: 'medium' },
    ];
    const groups = groupFindingsByCheck(fpComments, rows);
    const series = groups.find((g) => g.checkId === 'a.series');
    expect(series.dismissed).toBe(3);
    expect(series.falsePositive).toBe(2);
    expect(series.falsePositiveRate).toBeCloseTo(2 / 4); // 2 of 4 findings
    const issue = groups.find((g) => g.checkId === 'b.issue');
    expect(issue.falsePositive).toBe(0);
    expect(issue.falsePositiveRate).toBe(0);
  });
});

describe('checkFalsePositiveRate', () => {
  it('prefers the stamped rate over a recompute (survives status-filter recounts)', () => {
    // A group whose `total` was recounted to the open-only subset, but whose
    // stamped rate reflects the full finding set.
    expect(checkFalsePositiveRate({ total: 1, falsePositive: 0, falsePositiveRate: 0.5 })).toBe(0.5);
  });

  it('falls back to falsePositive/total for a hand-built group', () => {
    expect(checkFalsePositiveRate({ total: 4, falsePositive: 1 })).toBe(0.25);
  });

  it('returns null when the check has no findings yet', () => {
    expect(checkFalsePositiveRate({ total: 0, falsePositive: 0 })).toBeNull();
    expect(checkFalsePositiveRate(null)).toBeNull();
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
  { id: 'a1', checkId: 'pacing', category: 'pacing', status: 'open', severity: 'high', issueNumber: 2, problem: 'Slow open', location: 'p1' },
  { id: 'a2', checkId: 'pacing', category: 'pacing', status: 'dismissed', severity: 'low', issueNumber: 2, problem: 'Old note' },
  { id: 'b1', checkId: 'naming', category: 'naming', status: 'open', severity: 'medium', issueNumber: 1, problem: 'Confusable names' },
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
    // Categories come from the finding's `category` field; a finding without one
    // buckets under 'other'. Sorted by display label.
    expect(f.categories.map((c) => c.category)).toEqual(['naming', 'other', 'pacing']);
    expect(f.categories.map((c) => c.label)).toEqual(['Naming', 'Other', 'Pacing']);
  });
});

describe('normCategory / categoryLabel', () => {
  it('normalizes a finding category, bucketing missing/blank under "other"', () => {
    expect(normCategory({ category: 'continuity' })).toBe('continuity');
    expect(normCategory({ category: '' })).toBe('other');
    expect(normCategory({})).toBe('other');
    expect(normCategory(null)).toBe('other');
  });

  it('title-cases a category token for display', () => {
    expect(categoryLabel('continuity')).toBe('Continuity');
    expect(categoryLabel('')).toBe('Other');
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

  it('filters by scope and by check id', () => {
    const byScope = applyFindingsView(groupsFixture(), { scopes: new Set(['series']) }, 'scope');
    expect(byScope.map((g) => g.checkId)).toEqual(['naming']);
    const byCheck = applyFindingsView(groupsFixture(), { checkIds: new Set(['pacing']) }, 'scope');
    expect(byCheck.map((g) => g.checkId)).toEqual(['pacing']);
  });

  it('filters by finding category (comment-level), bucketing un-categorized under "other"', () => {
    const byPacing = applyFindingsView(groupsFixture(), { categories: new Set(['pacing']) }, 'scope');
    expect(byPacing.flatMap((g) => g.comments.map((c) => c.id))).toEqual(['a1', 'a2']);
    // 'naming' category only matches b1 (b2 has no category → 'other'), so the
    // naming group keeps just b1.
    const byNaming = applyFindingsView(groupsFixture(), { categories: new Set(['naming']) }, 'scope');
    expect(byNaming.flatMap((g) => g.comments.map((c) => c.id))).toEqual(['b1']);
    const byOther = applyFindingsView(groupsFixture(), { categories: new Set(['other']) }, 'scope');
    expect(byOther.flatMap((g) => g.comments.map((c) => c.id))).toEqual(['b2']);
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

  it('sorts groups by severity even in a resolved-only filtered view (counts are open-only)', () => {
    const comments = [
      { id: 'z1', checkId: 'zebra', status: 'dismissed', severity: 'high', problem: 'High resolved' },
      { id: 'a1', checkId: 'alpha', status: 'dismissed', severity: 'low', problem: 'Low resolved' },
    ];
    const rows = { zebra: { label: 'Zebra', scope: 'series' }, alpha: { label: 'Alpha', scope: 'series' } };
    const groups = groupFindingsByCheck(comments, rows);
    // Default scope→label order is Alpha, Zebra; severity sort must flip to Zebra (high) first.
    const view = applyFindingsView(groups, { statuses: new Set(['dismissed']) }, 'severity');
    expect(view.map((g) => g.checkId)).toEqual(['zebra', 'alpha']);
  });

  it('ranks a single high-severity group above a noisy many-low group when sort=severity', () => {
    const comments = [
      { id: 'h1', checkId: 'one-high', status: 'open', severity: 'high', problem: 'Critical' },
      ...Array.from({ length: 50 }, (_, i) => (
        { id: `l${i}`, checkId: 'many-low', status: 'open', severity: 'low', problem: `Nit ${i}` })),
    ];
    const rows = { 'one-high': { label: 'One high', scope: 'series' }, 'many-low': { label: 'Many low', scope: 'series' } };
    const view = applyFindingsView(groupFindingsByCheck(comments, rows), {}, 'severity');
    expect(view.map((g) => g.checkId)).toEqual(['one-high', 'many-low']);
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

describe('canon entity references in findings (#1631)', () => {
  const universe = {
    characters: [
      { id: 'ch1', name: 'Aria', physicalDescription: 'silver-haired pilot' },
      { id: 'ch2', name: 'Jon', physicalDescription: '' },
      { id: 'ch3', name: 'Jon Snow', physicalDescription: 'brooding ranger' },
      { name: 'X' }, // too short — dropped
    ],
    places: [{ ingredientId: 'pl1', id: 'local-1', name: 'The Atrium', description: 'glass dome' }],
    objects: [{ id: 'ob1', name: 'Aria' }], // duplicate name — first (character) wins
  };

  it('flattens canon arrays, drops 1-char names, dedupes by name, prefers ingredientId', () => {
    const entities = canonEntitiesFromUniverse(universe);
    expect(entities.map((e) => e.name)).toEqual(['Aria', 'Jon', 'Jon Snow', 'The Atrium']);
    const aria = entities.find((e) => e.name === 'Aria');
    expect(aria.kind).toBe('characters');
    expect(aria.descriptor).toContain('silver-haired pilot');
    expect(entities.find((e) => e.name === 'The Atrium').id).toBe('pl1');
  });

  it('returns [] for a missing/invalid universe', () => {
    expect(canonEntitiesFromUniverse(null)).toEqual([]);
    expect(canonEntitiesFromUniverse('nope')).toEqual([]);
    expect(canonEntitiesFromUniverse({})).toEqual([]);
  });

  it('linkifies whole-word, case-insensitive matches and reproduces the text exactly', () => {
    const entities = canonEntitiesFromUniverse(universe);
    const segs = linkifyCanonEntities("aria visits The Atrium with Mariana", entities);
    expect(segs.map((s) => s.text).join('')).toBe("aria visits The Atrium with Mariana");
    const linked = segs.filter((s) => s.entity).map((s) => [s.text, s.entity.name]);
    // "aria" matches (case-insensitive); "Mariana" does NOT (word-boundary, not substring "Aria").
    expect(linked).toEqual([['aria', 'Aria'], ['The Atrium', 'The Atrium']]);
  });

  it('prefers the longest name so a multi-word entity wins over its substring', () => {
    const entities = canonEntitiesFromUniverse(universe);
    const segs = linkifyCanonEntities('Jon Snow returns', entities);
    const linked = segs.filter((s) => s.entity);
    expect(linked).toHaveLength(1);
    expect(linked[0].entity.name).toBe('Jon Snow');
  });

  it('collapses repeated mentions to unique references in first-appearance order', () => {
    const entities = canonEntitiesFromUniverse(universe);
    const refs = canonReferencesInText('Aria and Aria meet Jon at The Atrium', entities);
    expect(refs.map((e) => e.name)).toEqual(['Aria', 'Jon', 'The Atrium']);
  });

  it('matches accented / non-ASCII names (Unicode-aware boundaries, not ASCII \\b)', () => {
    const entities = canonEntitiesFromUniverse({ characters: [{ id: 'e1', name: 'Élodie' }, { id: 'e2', name: 'Søren' }] });
    const refs = canonReferencesInText('Élodie argues with Søren at dawn', entities);
    expect(refs.map((e) => e.name)).toEqual(['Élodie', 'Søren']);
    // Still whole-word: a name embedded in a longer accented word does not match.
    expect(canonReferencesInText('Élodies', entities)).toEqual([]);
  });

  it('handles empty/no-entity inputs without throwing', () => {
    expect(linkifyCanonEntities('', [])).toEqual([]);
    expect(linkifyCanonEntities('plain text', [])).toEqual([{ text: 'plain text' }]);
    expect(canonReferencesInText('', canonEntitiesFromUniverse(universe))).toEqual([]);
  });

  it('builds a canon-section deep link (or null without a universe)', () => {
    expect(canonEntityLink('u-1')).toBe('/universes/u-1#canon');
    expect(canonEntityLink('')).toBeNull();
    expect(canonEntityLink(null)).toBeNull();
  });
});
