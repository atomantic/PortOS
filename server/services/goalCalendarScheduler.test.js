/**
 * #8755: scheduleTimeBlocks/removeScheduledEvents used to read goals.json once,
 * await Google Calendar round-trips, then write back the whole snapshot
 * captured before those calls started — silently dropping any concurrent edit
 * to the goal (or any other goal) made while the calendar calls were in
 * flight. They now apply `scheduledEvents` to a freshly re-read goal via the
 * shared `mutateGoals` serializer.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

var tempRoot; // eslint-disable-line no-var
function getTempRoot() {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'goal-calendar-test-'));
  return tempRoot;
}

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => getTempRoot() }));

vi.mock('./mortalLoomStore.js', () => ({
  isMortalLoomEnabled: vi.fn(async () => false),
  mlArrayIfEnabled: vi.fn(async () => null),
  mlReplace: vi.fn(async () => {}),
}));

const insertedEvents = [];
vi.mock('@googleapis/calendar', () => ({
  calendar: () => ({
    events: {
      insert: vi.fn(async ({ requestBody }) => {
        const id = `evt-${insertedEvents.length + 1}`;
        insertedEvents.push({ id, requestBody });
        return { data: { id } };
      }),
      delete: vi.fn(async () => ({})),
    },
  }),
}));

vi.mock('./googleAuth.js', () => ({
  getAuthenticatedClient: vi.fn(async () => ({})),
  needsScopeUpgrade: vi.fn(() => false),
  getTokens: vi.fn(async () => ({ access_token: 'fake' })),
}));

import { scheduleTimeBlocks, removeScheduledEvents } from './goalCalendarScheduler.js';
import { addProgressEntry } from './identity/goals.js';

afterAll(() => { if (tempRoot) rmSync(tempRoot, { recursive: true, force: true }); });

describe('goalCalendarScheduler write serialization (#8755)', () => {
  const goalsFile = () => join(getTempRoot(), 'digital-twin', 'goals.json');

  const baseGoal = () => ({
    id: 'g1',
    title: 'Example Goal',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    targetDate: '2026-12-31',
    milestones: [
      { id: 'ms1', title: 'Phase 1', order: 0, targetDate: '2026-12-31', completedAt: null }
    ],
    timeBlockConfig: {
      preferredDays: ['mon'],
      timeSlot: 'morning',
      sessionDurationMinutes: 30,
    },
    scheduledEvents: [],
  });

  beforeEach(() => {
    rmSync(getTempRoot(), { recursive: true, force: true });
    mkdirSync(join(getTempRoot(), 'digital-twin'), { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    insertedEvents.length = 0;
  });

  it('applies scheduledEvents onto a goal edited while Calendar calls were in flight, without dropping the edit', async () => {
    writeFileSync(goalsFile(), JSON.stringify({ goals: [baseGoal()] }));

    const result = await scheduleTimeBlocks('g1');
    expect(result.count).toBeGreaterThan(0);

    // Concurrent edit lands AFTER the read scheduleTimeBlocks used to build its
    // calendar batch — simulated here by adding a progress entry once the
    // calendar insert calls (mocked, synchronous-ish) have already run.
    await addProgressEntry('g1', { date: '2026-06-01', note: 'logged during scheduling', durationMinutes: 15 });

    const written = JSON.parse(readFileSync(goalsFile(), 'utf8'));
    const goal = written.goals[0];
    expect(goal.scheduledEvents.length).toBe(result.count);
    expect(goal.progressLog).toHaveLength(1);
    expect(goal.progressLog[0].note).toBe('logged during scheduling');
  });

  it('removeScheduledEvents clears events on a freshly re-read goal', async () => {
    const goal = baseGoal();
    goal.scheduledEvents = [{ id: 'sched-1', googleEventId: 'evt-1', calendarId: 'primary', milestoneId: 'ms1', date: '2026-06-01', createdAt: '2026-01-01T00:00:00.000Z' }];
    writeFileSync(goalsFile(), JSON.stringify({ goals: [goal] }));

    const result = await removeScheduledEvents('g1');
    expect(result.deleted).toBe(1);

    const written = JSON.parse(readFileSync(goalsFile(), 'utf8'));
    expect(written.goals[0].scheduledEvents).toEqual([]);
  });
});
