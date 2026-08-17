import { describe, it, expect } from 'vitest';
import {
  DOMAIN_BUDGET_FIELDS,
  normalizeBudgetLimit,
  getDomainBudget,
  getDomainMode,
  DEFAULT_DOMAIN_MODE,
  AGENT_STATES,
  MUSE_STATE_MOTIONS,
  MUSE_IN_PLACE_SUFFIX,
  MUSE_ANIMATION_FALLBACK,
  MUSE_SPEAKING_GESTURE,
  MUSE_ROOT_MOTION_CLIPS,
  resolveMuseMotion,
  MODEL_CAPABLE_CLI_REVIEWERS,
  reviewerLabel
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

// The Cyber Muse avatar drives RobotExpressive's clips off CoS state through a
// single map: state → an ordered step list. Invariants that must hold or the
// fixed-frame avatar breaks: every agent state needs at least one step, and the
// FIRST step (the structural fallback, played as named) may not carry root
// translation — those walk the model out of view (MUSE_ROOT_MOTION_CLIPS).

// The bundled default GLB's clip roster, as MuseCoSAvatar sees it: the 14
// RobotExpressive clips plus the in-place variants it synthesizes at load time.
const ROBOT_EXPRESSIVE_CLIPS = [
  'Idle', 'Walking', 'Running', 'Dance', 'Death', 'Sitting', 'Standing',
  'Jump', 'Yes', 'No', 'Wave', 'Punch', 'ThumbsUp', 'WalkJump'
];
const LOADED_CLIPS = [
  ...ROBOT_EXPRESSIVE_CLIPS,
  ...MUSE_ROOT_MOTION_CLIPS.map((n) => `${n}${MUSE_IN_PLACE_SUFFIX}`)
];

const LOOP_KINDS = ['infinite', 'once'];

describe('muse avatar motion map', () => {
  it('gives every agent state at least one well-formed step', () => {
    for (const state of Object.keys(AGENT_STATES)) {
      const steps = MUSE_STATE_MOTIONS[state];
      expect(Array.isArray(steps), `state "${state}" must map to a step list`).toBe(true);
      expect(steps.length, `state "${state}" needs at least one step`).toBeGreaterThan(0);
      for (const step of steps) {
        expect(typeof step.clip, `state "${state}" step needs a clip name`).toBe('string');
        expect(step.clip.length).toBeGreaterThan(0);
        expect(typeof step.timeScale, `state "${state}" step needs a timeScale`).toBe('number');
        expect(step.timeScale).toBeGreaterThan(0);
        if (typeof step.loop === 'string') {
          expect(LOOP_KINDS, `state "${state}" has an unknown loop kind`).toContain(step.loop);
        } else {
          expect(Number.isInteger(step.loop?.reps) && step.loop.reps > 0, `state "${state}" reps must be a positive integer`).toBe(true);
        }
      }
    }
  });

  it('never uses a root-motion clip as a state fallback (or as the fallback / speaking gesture)', () => {
    // The first step doubles as the state's fallback loop and is played as
    // named, so it must be in-place. Later montage steps may name a root-motion
    // clip — resolveMuseMotion routes those to their in-place variant.
    for (const [state, steps] of Object.entries(MUSE_STATE_MOTIONS)) {
      expect(MUSE_ROOT_MOTION_CLIPS, `state "${state}" falls back to a root-motion clip`).not.toContain(steps[0].clip);
    }
    expect(MUSE_ROOT_MOTION_CLIPS).not.toContain(MUSE_ANIMATION_FALLBACK);
    expect(MUSE_ROOT_MOTION_CLIPS).not.toContain(MUSE_SPEAKING_GESTURE);
  });

  it('gives the coding state a montage of at least 2 steps', () => {
    expect(MUSE_STATE_MOTIONS.coding.length).toBeGreaterThanOrEqual(2);
  });
});

// Pin the clip sequence each state actually plays on the bundled model. These
// are the exact clips/timeScales/loops the split base-map + montage-map design
// produced, so the unified map stays behaviour-preserving.

describe('resolveMuseMotion (bundled RobotExpressive roster)', () => {
  const expected = {
    sleeping:      [{ clip: 'Sitting',  timeScale: 0.8,  loop: 'once' }],
    thinking:      [{ clip: 'Idle',     timeScale: 0.85, loop: 'infinite' }],
    coding: [
      { clip: 'Punch',                             timeScale: 1.2,  loop: { reps: 2 } },
      { clip: `Running${MUSE_IN_PLACE_SUFFIX}`,    timeScale: 1.1,  loop: { reps: 4 } },
      { clip: 'Jump',                              timeScale: 1.0,  loop: { reps: 1 } },
      { clip: 'ThumbsUp',                          timeScale: 0.95, loop: { reps: 1 } },
      { clip: `Walking${MUSE_IN_PLACE_SUFFIX}`,    timeScale: 1.2,  loop: { reps: 4 } },
      { clip: 'Dance',                             timeScale: 1.0,  loop: { reps: 1 } },
    ],
    investigating: [{ clip: 'No',       timeScale: 0.7,  loop: 'infinite' }],
    reviewing:     [{ clip: 'Yes',      timeScale: 0.8,  loop: 'infinite' }],
    planning:      [{ clip: 'ThumbsUp', timeScale: 0.85, loop: 'infinite' }],
    ideating:      [{ clip: 'Dance',    timeScale: 1.0,  loop: 'infinite' }],
  };

  it('covers every agent state', () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(AGENT_STATES).sort());
  });

  for (const [state, steps] of Object.entries(expected)) {
    it(`resolves "${state}" to its pre-unification clip sequence`, () => {
      expect(resolveMuseMotion(state, LOADED_CLIPS)).toEqual(steps);
    });
  }
});

describe('resolveMuseMotion (degraded GLBs)', () => {
  it('returns nothing when the GLB has no clips (procedural-only)', () => {
    expect(resolveMuseMotion('coding', [])).toEqual([]);
    expect(resolveMuseMotion('coding', undefined)).toEqual([]);
  });

  it('drops montage steps the GLB lacks, keeping the rest in order', () => {
    const names = ['Punch', 'Jump', 'Dance'];
    expect(resolveMuseMotion('coding', names)).toEqual([
      { clip: 'Punch', timeScale: 1.2, loop: { reps: 2 } },
      { clip: 'Jump',  timeScale: 1.0, loop: { reps: 1 } },
      { clip: 'Dance', timeScale: 1.0, loop: { reps: 1 } },
    ]);
  });

  it('collapses a lone resolvable step to an infinite loop (no next step to advance to)', () => {
    expect(resolveMuseMotion('coding', ['Punch', 'Idle'])).toEqual([
      { clip: 'Punch', timeScale: 1.2, loop: 'infinite' },
    ]);
  });

  it('keeps a clamped one-shot pose clamped', () => {
    expect(resolveMuseMotion('sleeping', ['Sitting', 'Idle'])).toEqual([
      { clip: 'Sitting', timeScale: 0.8, loop: 'once' },
    ]);
  });

  it('falls back to the canonical fallback clip when none of the state clips exist', () => {
    expect(resolveMuseMotion('ideating', ['Idle', 'Walking'])).toEqual([
      { clip: MUSE_ANIMATION_FALLBACK, timeScale: 1.0, loop: 'infinite' },
    ]);
  });

  it('prefers an in-place clip over a root-motion one for an unmapped GLB', () => {
    expect(resolveMuseMotion('coding', ['Walking', 'Standing'])).toEqual([
      { clip: 'Standing', timeScale: 1.2, loop: 'infinite' },
    ]);
    // Every clip carries root motion — nothing safer to pick than the first.
    expect(resolveMuseMotion('coding', ['Walking', 'Running'])).toEqual([
      { clip: 'Walking', timeScale: 1.2, loop: 'infinite' },
    ]);
  });

  it('still animates an unknown state', () => {
    expect(resolveMuseMotion('bogus', LOADED_CLIPS)).toEqual([
      { clip: MUSE_ANIMATION_FALLBACK, loop: 'infinite' },
    ]);
  });
});

describe('getDomainMode (existing helper, sanity)', () => {
  it('defaults to execute for absent/invalid config', () => {
    expect(getDomainMode(undefined, 'cos')).toBe(DEFAULT_DOMAIN_MODE);
    expect(getDomainMode({ domainAutonomy: { cos: 'bogus' } }, 'cos')).toBe(DEFAULT_DOMAIN_MODE);
    expect(getDomainMode({ domainAutonomy: { cos: 'off' } }, 'cos')).toBe('off');
  });
});

// The Code Review Defaults help text renders one label per MODEL_CAPABLE_CLI_REVIEWERS
// entry (#3839). A roster addition with no matching REVIEWER_OPTIONS row would fall
// back to the raw slug and print "the codex, Claude, … reviewers" in the panel.
describe('reviewerLabel', () => {
  it('gives every model-capable CLI reviewer a display label', () => {
    for (const slug of MODEL_CAPABLE_CLI_REVIEWERS) {
      const label = reviewerLabel(slug);
      expect(label).toBeTruthy();
      expect(label).not.toBe(slug);
    }
  });

  it('resolves the gemini alias to Antigravity', () => {
    expect(reviewerLabel('gemini')).toBe(reviewerLabel('antigravity'));
  });

  it('passes an @username token through unchanged', () => {
    expect(reviewerLabel('@octocat')).toBe('@octocat');
  });
});
// @vitest-environment node
