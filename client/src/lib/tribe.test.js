import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RINGS,
  TRIBE_RINGS,
  ENERGY,
  STATUS_HEX,
  contactStatus,
  daysBetween,
  ringFor,
  energyFor,
  tagsToArray,
  tagsToInput,
  initialsFor,
} from './tribe.js';

describe('tribe ring/energy lookups', () => {
  it('exposes the four Dunbar rings + the uncapped external classification', () => {
    expect(RINGS.map((r) => r.id)).toEqual(['support', 'core', 'tribe', 'village', 'external']);
    expect(RINGS.map((r) => r.cap)).toEqual([5, 15, 50, 150, null]);
    // Every ring carries an SVG hex for the map nodes/labels.
    expect(RINGS.every((r) => /^#[0-9a-f]{6}$/i.test(r.hex))).toBe(true);
  });

  it('TRIBE_RINGS is the four inner rings (excludes external)', () => {
    expect(TRIBE_RINGS.map((r) => r.id)).toEqual(['support', 'core', 'tribe', 'village']);
    expect(TRIBE_RINGS.some((r) => r.id === 'external')).toBe(false);
  });

  it('ringFor falls back to tribe for unknown ids', () => {
    expect(ringFor('core').id).toBe('core');
    expect(ringFor('nope').id).toBe('tribe');
  });

  it('energyFor falls back to steady and every tier has a hex', () => {
    expect(energyFor('draining').id).toBe('draining');
    expect(energyFor('???').id).toBe('steady');
    expect(ENERGY.every((e) => /^#[0-9a-f]{6}$/i.test(e.hex))).toBe(true);
  });

  it('STATUS_HEX covers every cadence state (incl. external)', () => {
    expect(Object.keys(STATUS_HEX).sort()).toEqual(['external', 'missing', 'overdue', 'soon', 'steady']);
  });
});

describe('tagsToArray / tagsToInput', () => {
  it('splits comma strings and trims, dropping empties', () => {
    expect(tagsToArray(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
  });
  it('passes through arrays', () => {
    expect(tagsToArray(['x', ' y '])).toEqual(['x', 'y']);
  });
  it('round-trips to a comma-joined input', () => {
    expect(tagsToInput([' a ', 'b'])).toBe('a, b');
  });
});

describe('initialsFor', () => {
  it('uses first+last initials for multi-word names', () => {
    expect(initialsFor('Ada Lovelace')).toBe('AL');
    expect(initialsFor('  jean  luc  picard ')).toBe('JP');
  });
  it('uses first two letters for a single word', () => {
    expect(initialsFor('madonna')).toBe('MA');
  });
  it('falls back to ? for blank names', () => {
    expect(initialsFor('')).toBe('?');
    expect(initialsFor('   ')).toBe('?');
    expect(initialsFor(null)).toBe('?');
  });
});

describe('contactStatus / daysBetween', () => {
  // Pin "today" so cadence math is deterministic.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T12:00:00'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns null days for missing/unparseable dates', () => {
    expect(daysBetween(null)).toBeNull();
    expect(daysBetween('not-a-date')).toBeNull();
    expect(daysBetween('2026-06-09')).toBe(10);
  });

  it('flags missing when no last contact', () => {
    const s = contactStatus({ cadenceDays: 7 });
    expect(s.state).toBe('missing');
    expect(s.daysRemaining).toBeNull();
  });

  it('flags overdue past the cadence window', () => {
    const s = contactStatus({ lastContact: '2026-06-01', cadenceDays: 7 });
    expect(s.state).toBe('overdue');
    expect(s.daysRemaining).toBe(7 - 18);
  });

  it('flags soon within 7 days', () => {
    const s = contactStatus({ lastContact: '2026-06-15', cadenceDays: 10 });
    expect(s.state).toBe('soon');
    expect(s.daysRemaining).toBe(6);
  });

  it('flags steady when comfortably ahead', () => {
    const s = contactStatus({ lastContact: '2026-06-18', cadenceDays: 45 });
    expect(s.state).toBe('steady');
    expect(s.daysRemaining).toBe(44);
  });

  it('external people carry no cadence — never overdue, even with a stale contact', () => {
    const s = contactStatus({ ring: 'external', lastContact: '2020-01-01', cadenceDays: 7 });
    expect(s.state).toBe('external');
    expect(s.daysRemaining).toBeNull();
    expect(STATUS_HEX.external).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
