import { describe, it, expect } from 'vitest';
import {
  WORK_TRACKERS,
  CONCRETE_WORK_TRACKERS,
  DEFAULT_WORK_TRACKER,
  workTrackerLabel,
  hostToWorkTracker,
  forgeCliForTracker,
  trackerToClaimTaskType,
  resolveWorkTracker,
} from './workTracker.js';

describe('workTracker constants', () => {
  it('auto is the default and the only non-concrete value', () => {
    expect(DEFAULT_WORK_TRACKER).toBe('auto');
    expect(WORK_TRACKERS).toContain('auto');
    expect(CONCRETE_WORK_TRACKERS).not.toContain('auto');
    expect(WORK_TRACKERS).toEqual(['auto', ...CONCRETE_WORK_TRACKERS]);
  });
});

describe('hostToWorkTracker', () => {
  it('maps github hosts (incl. enterprise) to github', () => {
    expect(hostToWorkTracker('github.com')).toBe('github');
    expect(hostToWorkTracker('GitHub.com')).toBe('github');
    expect(hostToWorkTracker('github.mycorp.com')).toBe('github');
  });
  it('maps gitlab hosts (incl. self-hosted) to gitlab', () => {
    expect(hostToWorkTracker('gitlab.com')).toBe('gitlab');
    expect(hostToWorkTracker('gitlab.example.com')).toBe('gitlab');
  });
  it('returns null for unknown / empty hosts', () => {
    expect(hostToWorkTracker('bitbucket.org')).toBeNull();
    expect(hostToWorkTracker('')).toBeNull();
    expect(hostToWorkTracker(null)).toBeNull();
    expect(hostToWorkTracker(undefined)).toBeNull();
  });
});

describe('forgeCliForTracker', () => {
  it('maps forge trackers to their CLI, others to null', () => {
    expect(forgeCliForTracker('github')).toBe('gh');
    expect(forgeCliForTracker('gitlab')).toBe('glab');
    expect(forgeCliForTracker('plan')).toBeNull();
    expect(forgeCliForTracker('jira')).toBeNull();
    expect(forgeCliForTracker('auto')).toBeNull();
  });
});

describe('trackerToClaimTaskType', () => {
  it('routes each concrete tracker to its claim prompt task type', () => {
    expect(trackerToClaimTaskType('plan')).toBe('plan-task');
    expect(trackerToClaimTaskType('github')).toBe('claim-issue');
    expect(trackerToClaimTaskType('gitlab')).toBe('claim-issue-gitlab');
    expect(trackerToClaimTaskType('jira')).toBe('jira-sprint-manager');
    expect(trackerToClaimTaskType('auto')).toBeNull();
    expect(trackerToClaimTaskType('nonsense')).toBeNull();
  });
});

describe('resolveWorkTracker (pure)', () => {
  it('honors an explicit concrete choice regardless of host', () => {
    expect(resolveWorkTracker({ configured: 'jira', host: 'github.com' }))
      .toEqual({ configured: 'jira', resolved: 'jira', source: 'configured' });
    expect(resolveWorkTracker({ configured: 'plan', host: 'gitlab.com' }))
      .toEqual({ configured: 'plan', resolved: 'plan', source: 'configured' });
  });

  it('auto resolves from the origin host', () => {
    expect(resolveWorkTracker({ configured: 'auto', host: 'github.com' }))
      .toEqual({ configured: 'auto', resolved: 'github', source: 'origin' });
    expect(resolveWorkTracker({ configured: 'auto', host: 'gitlab.example.com' }))
      .toEqual({ configured: 'auto', resolved: 'gitlab', source: 'origin' });
  });

  it('auto with an unrecognized / missing host falls back to PLAN.md', () => {
    expect(resolveWorkTracker({ configured: 'auto', host: 'bitbucket.org' }))
      .toEqual({ configured: 'auto', resolved: 'plan', source: 'fallback' });
    expect(resolveWorkTracker({ configured: 'auto', host: null }))
      .toEqual({ configured: 'auto', resolved: 'plan', source: 'fallback' });
  });

  it('treats absent / invalid configured values as auto', () => {
    expect(resolveWorkTracker({ host: 'github.com' }).resolved).toBe('github');
    expect(resolveWorkTracker({ configured: 'garbage', host: 'gitlab.com' }))
      .toEqual({ configured: 'auto', resolved: 'gitlab', source: 'origin' });
    expect(resolveWorkTracker({}).resolved).toBe('plan');
  });
});

describe('workTrackerLabel', () => {
  it('returns a human label for every value, falling back to the raw value', () => {
    for (const t of WORK_TRACKERS) {
      expect(typeof workTrackerLabel(t)).toBe('string');
      expect(workTrackerLabel(t).length).toBeGreaterThan(0);
    }
    expect(workTrackerLabel('github')).toBe('GitHub Issues');
    expect(workTrackerLabel('unmapped-value')).toBe('unmapped-value');
  });
});
