import { describe, expect, it } from 'vitest';
import { mergeUpdatedTaskInterval } from './ScheduleTab';

describe('mergeUpdatedTaskInterval', () => {
  it('applies the persisted interval while retaining derived schedule status', () => {
    const schedule = {
      lastUpdated: 'earlier',
      tasks: {
        'plan-feature': {
          dataInputs: ['project-goals'],
          enabledAppCount: 2,
          status: { shouldRun: false },
        },
      },
    };

    expect(mergeUpdatedTaskInterval(schedule, 'plan-feature', {
      dataInputs: ['project-goals', 'open-issues'],
    })).toEqual({
      ...schedule,
      tasks: {
        'plan-feature': {
          dataInputs: ['project-goals', 'open-issues'],
          enabledAppCount: 2,
          status: { shouldRun: false },
        },
      },
    });
    expect(schedule.tasks['plan-feature'].dataInputs).toEqual(['project-goals']);
  });
});
