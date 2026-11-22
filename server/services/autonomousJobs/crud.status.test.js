import { describe, it, expect, vi, beforeEach } from 'vitest';

let data;
vi.mock('./store.js', () => ({
  loadJobs: vi.fn(async () => data),
  saveJobs: vi.fn(async () => {}),
}));
vi.mock('../cos/cosEvents.js', () => ({ cosEvents: { emit: vi.fn() } }));
vi.mock('../userTimezone.js', () => ({ getUserTimezone: vi.fn(async () => 'UTC') }));

const { recordJobBlockedConfig, clearJobBlockedConfig, setJobUnreachableRetryStep, recordJobExecution } = await import('./crud.js');

beforeEach(() => {
  data = { jobs: [{ id: 'j1', name: 'One', lastRun: '2026-01-01T00:00:00.000Z', runCount: 4 }] };
});

describe('job status bookkeeping', () => {
  it('blocked_config advances lastRun like a skip without counting a run', async () => {
    await recordJobBlockedConfig('j1', 'repo path missing');
    expect(data.jobs[0]).toMatchObject({ lastStatus: 'blocked_config', lastStatusReason: 'repo path missing', runCount: 4 });
    expect(Date.parse(data.jobs[0].lastRun)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('clearJobBlockedConfig only clears blocked_config', async () => {
    data.jobs[0].lastStatus = 'something-else';
    await clearJobBlockedConfig('j1');
    expect(data.jobs[0].lastStatus).toBe('something-else');

    data.jobs[0].lastStatus = 'blocked_config';
    data.jobs[0].lastStatusReason = 'x';
    await clearJobBlockedConfig('j1');
    expect(data.jobs[0]).not.toHaveProperty('lastStatus');
    expect(data.jobs[0]).not.toHaveProperty('lastStatusReason');
  });

  it('a recorded execution resets the retry ladder and heals blocked_config', async () => {
    await setJobUnreachableRetryStep('j1', 2);
    expect(data.jobs[0].unreachableRetryStep).toBe(2);
    await recordJobBlockedConfig('j1', 'x');

    await recordJobExecution('j1');
    expect(data.jobs[0]).not.toHaveProperty('unreachableRetryStep');
    expect(data.jobs[0]).not.toHaveProperty('lastStatus');
    expect(data.jobs[0].runCount).toBe(5);
  });

  it('setJobUnreachableRetryStep(0) removes the step', async () => {
    await setJobUnreachableRetryStep('j1', 1);
    await setJobUnreachableRetryStep('j1', 0);
    expect(data.jobs[0]).not.toHaveProperty('unreachableRetryStep');
  });
});
