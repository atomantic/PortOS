import { describe, it, expect } from 'vitest';
import {
  JIRA_DISTRICT,
  SPRINT_STATES,
  ticketState,
  structureHeight,
  dedupeAndSort,
  structurePosition,
  tallyStates,
  computeJiraDistrict,
} from './cityJiraDistrict';

describe('ticketState', () => {
  it('maps JIRA category names', () => {
    expect(ticketState({ statusCategory: 'Done' })).toBe('done');
    expect(ticketState({ statusCategory: 'In Progress' })).toBe('inProgress');
    expect(ticketState({ statusCategory: 'To Do' })).toBe('todo');
  });
  it('maps JIRA category key forms', () => {
    expect(ticketState({ statusCategory: 'indeterminate' })).toBe('inProgress');
    expect(ticketState({ statusCategory: 'new' })).toBe('todo');
  });
  it('defaults unknown/blank to todo', () => {
    expect(ticketState({ statusCategory: '' })).toBe('todo');
    expect(ticketState({})).toBe('todo');
    expect(ticketState(null)).toBe('todo');
  });
});

describe('structureHeight', () => {
  it('floors a point-less ticket to a visible crate', () => {
    expect(structureHeight(undefined)).toBeGreaterThan(0.5);
    expect(structureHeight(0)).toBe(structureHeight(undefined));
  });
  it('grows with story points and clamps', () => {
    expect(structureHeight(8)).toBeGreaterThan(structureHeight(2));
    expect(structureHeight(1000)).toBeLessThanOrEqual(JIRA_DISTRICT.maxHeight);
  });
});

describe('dedupeAndSort', () => {
  it('dedupes by key (first wins)', () => {
    const out = dedupeAndSort([
      { key: 'A-1', statusCategory: 'To Do' },
      { key: 'A-1', statusCategory: 'Done' },
    ]);
    expect(out).toHaveLength(1);
    expect(ticketState(out[0])).toBe('todo'); // first occurrence kept
  });
  it('orders done → in-progress → to-do, then by key', () => {
    const out = dedupeAndSort([
      { key: 'A-3', statusCategory: 'To Do' },
      { key: 'A-2', statusCategory: 'Done' },
      { key: 'A-1', statusCategory: 'In Progress' },
    ]);
    expect(out.map(t => t.key)).toEqual(['A-2', 'A-1', 'A-3']);
  });
  it('handles non-array input', () => {
    expect(dedupeAndSort(undefined)).toEqual([]);
  });
});

describe('structurePosition', () => {
  it('wraps rows toward -Z at the column count', () => {
    const p0 = structurePosition(0);
    const pWrap = structurePosition(JIRA_DISTRICT.columns);
    expect(pWrap[2]).toBeLessThan(p0[2]); // next row is further -Z
    expect(pWrap[0]).toBeCloseTo(p0[0], 5); // back to the first column's X
  });
  it('centers the row on base X', () => {
    const cols = JIRA_DISTRICT.columns;
    const xs = Array.from({ length: cols }, (_, i) => structurePosition(i)[0]);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeCloseTo(JIRA_DISTRICT.base[0], 5);
  });
});

describe('tallyStates', () => {
  it('counts each bucket', () => {
    const counts = tallyStates([
      { statusCategory: 'Done' },
      { statusCategory: 'Done' },
      { statusCategory: 'In Progress' },
      { statusCategory: 'To Do' },
    ]);
    expect(counts).toEqual({ todo: 1, inProgress: 1, done: 2 });
  });
});

describe('SPRINT_STATES', () => {
  it('has a color + label for each bucket', () => {
    for (const k of ['todo', 'inProgress', 'done']) {
      expect(SPRINT_STATES[k].color).toMatch(/^#/);
      expect(typeof SPRINT_STATES[k].label).toBe('string');
    }
  });
});

describe('computeJiraDistrict', () => {
  it('is empty with no tickets', () => {
    const d = computeJiraDistrict([]);
    expect(d.empty).toBe(true);
    expect(d.structures).toEqual([]);
    expect(d.total).toBe(0);
  });
  it('handles undefined input', () => {
    expect(computeJiraDistrict(undefined).empty).toBe(true);
  });
  it('builds positioned, colored structures with counts', () => {
    const d = computeJiraDistrict([
      { key: 'P-1', summary: 'Build login', statusCategory: 'In Progress', storyPoints: 3, url: 'http://x/P-1' },
      { key: 'P-2', summary: 'Ship it', statusCategory: 'Done' },
    ]);
    expect(d.total).toBe(2);
    expect(d.counts.done).toBe(1);
    expect(d.structures[0].state).toBe('done'); // done sorts first
    expect(d.structures[0].position).toHaveLength(3);
    expect(d.structures.find(s => s.key === 'P-1').color).toBe(SPRINT_STATES.inProgress.color);
  });
  it('folds the tail into an overflow count', () => {
    const tickets = [];
    for (let i = 0; i < 30; i++) tickets.push({ key: `P-${i}`, statusCategory: 'To Do' });
    const d = computeJiraDistrict(tickets, { maxStructures: 10 });
    expect(d.structures).toHaveLength(10);
    expect(d.overflow).toBe(20);
    expect(d.overflowPosition).toHaveLength(3);
  });
  it('falls back summary to key', () => {
    const d = computeJiraDistrict([{ key: 'P-9', statusCategory: 'To Do' }]);
    expect(d.structures[0].summary).toBe('P-9');
  });
});
