import { describe, it, expect } from 'vitest';
import { FALLBACK_COLUMNS, ticketInColumn, bucketTickets, columnConfig } from './kanbanColumns.js';

const ticket = (key, status, statusCategory, extra = {}) => ({ key, status, statusCategory, ...extra });

describe('ticketInColumn', () => {
  it('matches by status name when the column lists statuses', () => {
    const col = { name: 'Blocked', category: 'In Progress', statuses: ['Blocked', 'Impeded'] };
    expect(ticketInColumn(ticket('A', 'Blocked', 'In Progress'), col)).toBe(true);
    expect(ticketInColumn(ticket('B', 'In Review', 'In Progress'), col)).toBe(false);
  });

  it('matches by statusCategory when the column has no statuses (fallback board)', () => {
    const col = { name: 'In Progress', category: 'In Progress', statuses: [] };
    // A ticket whose real status is "Blocked" but category "In Progress" lands here.
    expect(ticketInColumn(ticket('A', 'Blocked', 'In Progress'), col)).toBe(true);
    expect(ticketInColumn(ticket('B', 'Done', 'Done'), col)).toBe(false);
  });
});

describe('bucketTickets', () => {
  const columns = [
    { name: 'To Do', category: 'To Do', statuses: ['To Do'] },
    { name: 'In Progress', category: 'In Progress', statuses: ['In Progress'] },
    { name: 'In Review', category: 'In Progress', statuses: ['In Review'] },
    { name: 'Done', category: 'Done', statuses: ['Done'] }
  ];

  it('buckets each ticket into its status-named column', () => {
    const result = bucketTickets(columns, [
      ticket('A', 'To Do', 'To Do'),
      ticket('B', 'In Review', 'In Progress'),
      ticket('C', 'Done', 'Done')
    ]);
    expect(result.find(c => c.name === 'To Do').tickets.map(t => t.key)).toEqual(['A']);
    expect(result.find(c => c.name === 'In Review').tickets.map(t => t.key)).toEqual(['B']);
    expect(result.find(c => c.name === 'Done').tickets.map(t => t.key)).toEqual(['C']);
    expect(result.find(c => c.name === 'In Progress').tickets).toEqual([]);
  });

  it('assigns every column a stable unique id even when display names collide', () => {
    // Jira boards may have two columns with the same display name mapped to
    // different statuses — name must NOT be the routing key.
    const dupNamed = [
      { name: 'Done', category: 'Done', statuses: ['Released'] },
      { name: 'Done', category: 'Done', statuses: ['Closed'] }
    ];
    const result = bucketTickets(dupNamed, [
      ticket('A', 'Released', 'Done'),
      ticket('B', 'Closed', 'Done')
    ]);
    const ids = result.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length); // all ids unique
    // Each ticket lands in the correct same-named column, by status.
    expect(result[0].tickets.map(t => t.key)).toEqual(['A']);
    expect(result[1].tickets.map(t => t.key)).toEqual(['B']);
  });

  it('appends an orphan column for a status that maps to no column', () => {
    const result = bucketTickets(columns, [ticket('A', 'Waiting on Customer', 'In Progress')]);
    const orphan = result.find(c => c.name === 'Waiting on Customer');
    expect(orphan).toBeTruthy();
    expect(orphan.tickets.map(t => t.key)).toEqual(['A']);
    expect(orphan.statuses).toEqual(['Waiting on Customer']);
    // Orphan id is unique and distinct from the resolved columns.
    const ids = result.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('collapses multiple tickets of the same orphan status into one column', () => {
    const result = bucketTickets(columns, [
      ticket('A', 'Waiting', 'In Progress'),
      ticket('B', 'Waiting', 'In Progress')
    ]);
    const orphans = result.filter(c => c.name === 'Waiting');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].tickets.map(t => t.key)).toEqual(['A', 'B']);
  });

  it('uses the statusCategory fallback for the built-in three-category board', () => {
    const result = bucketTickets(FALLBACK_COLUMNS, [
      ticket('A', 'Blocked', 'In Progress'),
      ticket('B', 'Backlog', 'To Do'),
      ticket('C', 'Released', 'Done')
    ]);
    expect(result.find(c => c.name === 'In Progress').tickets.map(t => t.key)).toEqual(['A']);
    expect(result.find(c => c.name === 'To Do').tickets.map(t => t.key)).toEqual(['B']);
    expect(result.find(c => c.name === 'Done').tickets.map(t => t.key)).toEqual(['C']);
  });

  it('precomputes a color config on every column', () => {
    const result = bucketTickets(columns, []);
    for (const col of result) expect(col.config).toBeTruthy();
  });
});

describe('columnConfig', () => {
  it('colors Blocked-like columns with the error palette regardless of category', () => {
    expect(columnConfig({ name: 'Blocked', category: 'In Progress' }).dot).toBe('bg-port-error');
    expect(columnConfig({ name: 'Impeded', category: 'In Progress' }).dot).toBe('bg-port-error');
  });

  it('colors Review/QA columns with the purple palette', () => {
    expect(columnConfig({ name: 'In Review', category: 'In Progress' }).dot).toBe('bg-purple-500');
    expect(columnConfig({ name: 'QA', category: 'In Progress' }).dot).toBe('bg-purple-500');
  });

  it('falls back to the category palette for ordinary columns', () => {
    expect(columnConfig({ name: 'To Do', category: 'To Do' }).dot).toBe('bg-gray-500');
    expect(columnConfig({ name: 'In Progress', category: 'In Progress' }).dot).toBe('bg-port-accent');
    expect(columnConfig({ name: 'Done', category: 'Done' }).dot).toBe('bg-port-success');
  });

  it('defaults an unknown category to the In Progress palette', () => {
    expect(columnConfig({ name: 'Mystery', category: 'Weird' }).dot).toBe('bg-port-accent');
  });
});
