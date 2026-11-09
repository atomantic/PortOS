import { describe, expect, it } from 'vitest';
import { jobScheduleState, SCHEDULED_WAIT_PATTERN, scheduledWaitMessage } from './jobSchedule.js';

const at = (iso) => Date.parse(iso);
const job = (schedule) => ({ params: { schedule } });

describe('queued job run window', () => {
  it('holds a job until its start time, then releases it', () => {
    const scheduled = job({ startAt: '2026-11-09T23:00:00.000Z' });
    expect(jobScheduleState(scheduled, at('2026-11-09T22:59:00Z'))).toEqual({ startAt: at('2026-11-09T23:00:00Z') });
    expect(jobScheduleState(scheduled, at('2026-11-09T23:00:00Z'))).toBeNull();
  });

  it('drops a job still waiting at its stop-by time, even before its start', () => {
    const scheduled = job({ startAt: '2026-11-09T23:00:00.000Z', stopBy: '2026-11-10T07:00:00.000Z' });
    expect(jobScheduleState(scheduled, at('2026-11-10T03:00:00Z'))).toBeNull();
    expect(jobScheduleState(scheduled, at('2026-11-10T07:00:00Z'))).toEqual({ expired: true });
  });

  it('leaves an unscheduled job alone', () => {
    expect(jobScheduleState({ params: {} })).toBeNull();
  });

  it('names its wait so the queue can clear it when the job starts', () => {
    expect(SCHEDULED_WAIT_PATTERN.test(scheduledWaitMessage(at('2026-11-09T23:00:00Z')))).toBe(true);
  });
});
