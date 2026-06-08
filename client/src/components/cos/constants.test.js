import { describe, it, expect } from 'vitest';
import {
  DOMAIN_BUDGET_FIELDS,
  normalizeBudgetLimit,
  getDomainBudget,
  getDomainMode,
  DEFAULT_DOMAIN_MODE
} from './constants';

// These mirror the server's domainBudgets/domainAutonomy helpers so the UI's
// "is a cap set?" / "what mode?" view never disagrees with enforcement.

describe('cos budget constants', () => {
  it('exposes the two cap dimensions with usage keys', () => {
    expect(DOMAIN_BUDGET_FIELDS.map((f) => f.id)).toEqual(['maxActionsPerDay', 'maxMinutesPerDay']);
    expect(DOMAIN_BUDGET_FIELDS.map((f) => f.usageKey)).toEqual(['actions', 'minutes']);
  });
});

describe('normalizeBudgetLimit (client mirror)', () => {
  it('keeps positive integers, floors fractions', () => {
    expect(normalizeBudgetLimit(5)).toBe(5);
    expect(normalizeBudgetLimit('7.9')).toBe(7);
  });

  it('treats 0 / negatives / garbage as unlimited (null)', () => {
    for (const v of [0, -3, NaN, Infinity, '', 'x', null, undefined]) {
      expect(normalizeBudgetLimit(v)).toBeNull();
    }
  });
});

describe('getDomainBudget (client mirror)', () => {
  it('returns unlimited caps when config is absent/partial', () => {
    expect(getDomainBudget(undefined, 'cos')).toEqual({ maxActionsPerDay: null, maxMinutesPerDay: null });
    expect(getDomainBudget({}, 'brain')).toEqual({ maxActionsPerDay: null, maxMinutesPerDay: null });
  });

  it('reads and coerces stored caps', () => {
    const config = { domainBudgets: { cos: { maxActionsPerDay: 10, maxMinutesPerDay: -1 } } };
    expect(getDomainBudget(config, 'cos')).toEqual({ maxActionsPerDay: 10, maxMinutesPerDay: null });
  });
});

describe('getDomainMode (existing helper, sanity)', () => {
  it('defaults to execute for absent/invalid config', () => {
    expect(getDomainMode(undefined, 'cos')).toBe(DEFAULT_DOMAIN_MODE);
    expect(getDomainMode({ domainAutonomy: { cos: 'bogus' } }, 'cos')).toBe(DEFAULT_DOMAIN_MODE);
    expect(getDomainMode({ domainAutonomy: { cos: 'off' } }, 'cos')).toBe('off');
  });
});
