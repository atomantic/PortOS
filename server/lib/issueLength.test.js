import { describe, it, expect } from 'vitest';
import {
  LENGTH_PROFILES,
  LENGTH_PROFILE_NAMES,
  DEFAULT_LENGTH_PROFILE,
  CUSTOM_PAGE_MIN, CUSTOM_PAGE_MAX,
  CUSTOM_MINUTE_MIN, CUSTOM_MINUTE_MAX,
  computeIssueTargets,
} from './issueLength.js';

describe('computeIssueTargets — preset profiles', () => {
  for (const id of Object.keys(LENGTH_PROFILES)) {
    it(`materializes "${id}" with the table values`, () => {
      const targets = computeIssueTargets({ lengthProfile: id });
      expect(targets.profile).toBe(id);
      expect(targets).toMatchObject(LENGTH_PROFILES[id]);
    });
  }

  it('falls back to the default profile when lengthProfile is missing', () => {
    const targets = computeIssueTargets({});
    expect(targets.profile).toBe(DEFAULT_LENGTH_PROFILE);
    expect(targets).toMatchObject(LENGTH_PROFILES[DEFAULT_LENGTH_PROFILE]);
  });

  it('falls back to the default profile when lengthProfile is unrecognized', () => {
    const targets = computeIssueTargets({ lengthProfile: 'gargantuan' });
    expect(targets.profile).toBe(DEFAULT_LENGTH_PROFILE);
  });
});

describe('computeIssueTargets — custom profile', () => {
  it('uses the supplied page/minute counts', () => {
    const targets = computeIssueTargets({
      lengthProfile: 'custom', pageTarget: 50, minutesTarget: 60,
    });
    expect(targets.profile).toBe('custom');
    expect(targets.pageTarget).toBe(50);
    expect(targets.minutesTarget).toBe(60);
    expect(targets.label).toBe('Custom');
  });

  it('clamps pageTarget below the floor up to the minimum', () => {
    const targets = computeIssueTargets({
      lengthProfile: 'custom', pageTarget: 1, minutesTarget: 30,
    });
    expect(targets.pageTarget).toBe(CUSTOM_PAGE_MIN);
  });

  it('clamps pageTarget above the ceiling down to the maximum', () => {
    const targets = computeIssueTargets({
      lengthProfile: 'custom', pageTarget: 10_000, minutesTarget: 30,
    });
    expect(targets.pageTarget).toBe(CUSTOM_PAGE_MAX);
  });

  it('clamps minutesTarget below the floor up to the minimum', () => {
    const targets = computeIssueTargets({
      lengthProfile: 'custom', pageTarget: 22, minutesTarget: 1,
    });
    expect(targets.minutesTarget).toBe(CUSTOM_MINUTE_MIN);
  });

  it('clamps minutesTarget above the ceiling down to the maximum', () => {
    const targets = computeIssueTargets({
      lengthProfile: 'custom', pageTarget: 22, minutesTarget: 9999,
    });
    expect(targets.minutesTarget).toBe(CUSTOM_MINUTE_MAX);
  });

  it('falls back custom page/minute targets to the standard preset when non-numeric', () => {
    const targets = computeIssueTargets({
      lengthProfile: 'custom', pageTarget: 'abc', minutesTarget: undefined,
    });
    expect(targets.pageTarget).toBe(LENGTH_PROFILES.standard.pageTarget);
    expect(targets.minutesTarget).toBe(LENGTH_PROFILES.standard.minutesTarget);
  });

  it('scales prose word range proportionally to page count', () => {
    // A request for twice as many pages as the standard preset should
    // proportionally scale the prose word range upward.
    const doublePages = LENGTH_PROFILES.standard.pageTarget * 2;
    const targets = computeIssueTargets({
      lengthProfile: 'custom', pageTarget: doublePages, minutesTarget: 24,
    });
    expect(targets.proseWordsMin).toBeGreaterThanOrEqual(LENGTH_PROFILES.standard.proseWordsMin * 1.8);
    expect(targets.proseWordsMax).toBeGreaterThanOrEqual(LENGTH_PROFILES.standard.proseWordsMax * 1.8);
  });

  it('floors prose word range at 600/1000 so the smallest custom still has a workable target', () => {
    const targets = computeIssueTargets({
      lengthProfile: 'custom', pageTarget: CUSTOM_PAGE_MIN, minutesTarget: 24,
    });
    expect(targets.proseWordsMin).toBeGreaterThanOrEqual(600);
    expect(targets.proseWordsMax).toBeGreaterThanOrEqual(1000);
  });

  it('floors beat range at 3/5 so the smallest custom still has a workable target', () => {
    const targets = computeIssueTargets({
      lengthProfile: 'custom', pageTarget: CUSTOM_PAGE_MIN, minutesTarget: 24,
    });
    expect(targets.beatsMin).toBeGreaterThanOrEqual(3);
    expect(targets.beatsMax).toBeGreaterThanOrEqual(5);
  });

  it('rounds non-integer pageTarget input', () => {
    const targets = computeIssueTargets({
      lengthProfile: 'custom', pageTarget: 22.7, minutesTarget: 24,
    });
    expect(Number.isInteger(targets.pageTarget)).toBe(true);
    expect(targets.pageTarget).toBe(23);
  });
});

describe('LENGTH_PROFILE_NAMES contract', () => {
  it('always includes the default profile and the custom sentinel', () => {
    expect(LENGTH_PROFILE_NAMES).toContain(DEFAULT_LENGTH_PROFILE);
    expect(LENGTH_PROFILE_NAMES).toContain('custom');
  });
});
