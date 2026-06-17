import { describe, it, expect } from 'vitest';
import {
  groupChecksByScope,
  groupFindingsByCheck,
  openFindingsTotal,
  findingManuscriptLink,
  scopeLabel,
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
