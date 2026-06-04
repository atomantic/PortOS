import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MS_PER_DAY,
  cellClasses,
  computeYearGrid,
  computeMonthGrid,
  computeMonthCalendars,
  computeEventWeeks,
} from './lifeGridMath';

// Pin "now" so status (spent/current/remaining) classification is deterministic.
const NOW = new Date('2020-07-01T00:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const BIRTH = '2000-01-01T00:00:00Z';
const DEATH = '2080-01-01T00:00:00Z';

describe('computeYearGrid', () => {
  it('produces one cell per year of life, all marked as birthdays', () => {
    const cells = computeYearGrid(BIRTH, DEATH);
    expect(cells.length).toBeGreaterThan(75);
    expect(cells.every(c => c.isBirthday)).toBe(true);
    expect(cells[0]).toMatchObject({ index: 0, label: 'Age 0' });
  });

  it('classifies years as spent / current / remaining around now', () => {
    const cells = computeYearGrid(BIRTH, DEATH);
    // Birth 2000, now mid-2020 → age 20 is current, age 0..19 spent, age 21+ remaining.
    expect(cells[0].status).toBe('s');
    expect(cells[20].status).toBe('c');
    expect(cells[21].status).toBe('r');
  });
});

describe('computeMonthGrid', () => {
  it('marks the birth month of each year as a birthday', () => {
    const cells = computeMonthGrid(BIRTH, DEATH);
    // First cell is age 0, month 0 (January) = birth month.
    expect(cells[0]).toMatchObject({ age: 0, month: 0, isBirthday: true });
    // Month 1 (February) is not a birthday.
    expect(cells[1].isBirthday).toBe(false);
  });

  it('numbers months sequentially with age = floor(index/12)', () => {
    const cells = computeMonthGrid(BIRTH, DEATH);
    expect(cells[12]).toMatchObject({ age: 1, month: 0 });
    expect(cells[13]).toMatchObject({ age: 1, month: 1 });
  });
});

describe('computeMonthCalendars', () => {
  it('returns ~12 month blocks spanning one age-year', () => {
    const months = computeMonthCalendars(BIRTH, DEATH, 25);
    expect(months.length).toBeLessThanOrEqual(13);
    expect(months.length).toBeGreaterThanOrEqual(12);
    expect(months[0]).toHaveProperty('firstDow');
    expect(months[0].days.length).toBeGreaterThan(0);
  });
});

describe('computeEventWeeks', () => {
  const grid = [
    { age: 20, weeks: new Array(52).fill('s') },
    { age: 21, weeks: new Array(52).fill('r') },
  ];

  it('returns an empty map when there is no birth date', () => {
    expect(computeEventWeeks(null, grid, {}, []).size).toBe(0);
  });

  it('always marks week 0 of each age as a birthday', () => {
    const events = computeEventWeeks(BIRTH, grid, {}, []);
    expect(events.get('20-0')).toMatchObject({ type: 'birthday' });
    expect(events.get('21-0')).toMatchObject({ type: 'birthday' });
  });

  it('places a yearly event in the correct week and skips disabled events', () => {
    const lifeEvents = [
      { name: 'Anniversary', type: 'milestone', recurrence: 'yearly', month: 6, day: 1, enabled: true },
      { name: 'Off', type: 'custom', recurrence: 'yearly', month: 3, day: 1, enabled: false },
    ];
    const events = computeEventWeeks(BIRTH, grid, {}, lifeEvents);
    // July 1 is ~26 weeks after a Jan 1 birthday.
    const anniversary = [...events.values()].find(e => e.name === 'Anniversary');
    expect(anniversary).toMatchObject({ type: 'milestone' });
    // Disabled event never appears.
    expect([...events.values()].some(e => e.name === 'Off')).toBe(false);
  });
});

describe('cellClasses', () => {
  it('highlights the current cell regardless of birthday', () => {
    expect(cellClasses('c', false, false, false)).toContain('bg-port-accent');
  });

  it('uses the pink birthday ring on remaining birthday cells when events are shown', () => {
    expect(cellClasses('r', false, true, true)).toContain('bg-pink-500');
  });

  it('renders spent cells gray, brighter for the current age', () => {
    expect(cellClasses('s', false, false, false)).toBe('bg-gray-700');
    expect(cellClasses('s', true, false, false)).toBe('bg-gray-500');
  });

  it('renders remaining non-event cells in success green', () => {
    expect(cellClasses('r', false, false, false)).toBe('bg-port-success/20');
  });
});

describe('MS_PER_DAY', () => {
  it('is the number of milliseconds in a day', () => {
    expect(MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
  });
});
