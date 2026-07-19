import { describe, it, expect } from 'vitest';
import {
  DOMAIN_BUDGET_FIELDS,
  normalizeBudgetLimit,
  getDomainBudget,
  getDomainMode,
  DEFAULT_DOMAIN_MODE,
  AGENT_STATES,
  MUSE_STATE_ANIMATIONS,
  MUSE_STATE_SEQUENCES,
  MUSE_ANIMATION_FALLBACK,
  MUSE_SPEAKING_GESTURE,
  MUSE_ROOT_MOTION_CLIPS
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

// The Cyber Muse avatar drives RobotExpressive's clips off CoS state. Two
// invariants must hold or the fixed-frame avatar breaks: every agent state
// needs a base clip, and no mapped clip may carry root translation (those
// walk the model out of view — enumerated in MUSE_ROOT_MOTION_CLIPS).

describe('muse avatar animation triggers', () => {
  it('maps every agent state to a base clip', () => {
    for (const state of Object.keys(AGENT_STATES)) {
      expect(MUSE_STATE_ANIMATIONS[state], `state "${state}" must map to a clip`).toBeTruthy();
      expect(typeof MUSE_STATE_ANIMATIONS[state].clip).toBe('string');
      expect(MUSE_STATE_ANIMATIONS[state].clip.length).toBeGreaterThan(0);
    }
  });

  it('never maps a state (or the fallback / speaking gesture) to a root-motion clip', () => {
    for (const [state, cfg] of Object.entries(MUSE_STATE_ANIMATIONS)) {
      expect(MUSE_ROOT_MOTION_CLIPS, `state "${state}" uses a root-motion clip`).not.toContain(cfg.clip);
    }
    expect(MUSE_ROOT_MOTION_CLIPS).not.toContain(MUSE_ANIMATION_FALLBACK);
    expect(MUSE_ROOT_MOTION_CLIPS).not.toContain(MUSE_SPEAKING_GESTURE);
  });
});

// The `coding` montage cycles several clips so the working avatar reads as
// varied/dynamic (jab, sprint, leap, approve, stride, celebrate). Steps name
// real GLB clips; root-motion clips are auto-routed to their neutralized
// in-place variant by the avatar (see animationClips.test.js for that routing),
// so the data can freely name a walk/run cycle without risking drift. These
// invariants just keep the montage steps well-formed.

describe('muse avatar state sequences (montages)', () => {
  it('gives the coding state a montage of at least 2 steps', () => {
    expect(Array.isArray(MUSE_STATE_SEQUENCES.coding)).toBe(true);
    expect(MUSE_STATE_SEQUENCES.coding.length).toBeGreaterThanOrEqual(2);
  });

  it('has well-formed steps (string clip + positive integer reps when present)', () => {
    for (const [state, steps] of Object.entries(MUSE_STATE_SEQUENCES)) {
      expect(Array.isArray(steps), `sequence "${state}" must be an array`).toBe(true);
      for (const step of steps) {
        expect(typeof step.clip, `sequence "${state}" step needs a clip name`).toBe('string');
        expect(step.clip.length).toBeGreaterThan(0);
        if (step.reps !== undefined) {
          expect(Number.isInteger(step.reps) && step.reps > 0, `sequence "${state}" reps must be a positive integer`).toBe(true);
        }
      }
    }
  });
});

describe('getDomainMode (existing helper, sanity)', () => {
  it('defaults to execute for absent/invalid config', () => {
    expect(getDomainMode(undefined, 'cos')).toBe(DEFAULT_DOMAIN_MODE);
    expect(getDomainMode({ domainAutonomy: { cos: 'bogus' } }, 'cos')).toBe(DEFAULT_DOMAIN_MODE);
    expect(getDomainMode({ domainAutonomy: { cos: 'off' } }, 'cos')).toBe('off');
  });
});
