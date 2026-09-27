/**
 * #8755: scheduleTimeBlocks/removeScheduledEvents used to read goals.json once,
 * await Google Calendar round-trips, then write back the whole snapshot
 * captured before those calls started — silently dropping any concurrent edit
 * to the goal (or any other goal) made while the calendar calls were in
 * flight. They now apply `scheduledEvents` to a freshly re-read goal via the
 * shared `mutateGoals` serializer.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
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
let duringInsert;
const deleteEvent = vi.fn(async () => ({}));
vi.mock('@googleapis/calendar', () => ({
  calendar: () => ({
    events: {
      insert: vi.fn(async ({ requestBody }) => {
        const id = `evt-${insertedEvents.length + 1}`;
        insertedEvents.push({ id, requestBody });
        await duringInsert?.();
        return { data: { id } };
      }),
      delete: deleteEvent,
    },
  }),
}));

vi.mock('./googleAuth.js', () => ({
  getAuthenticatedClient: vi.fn(async () => ({})),
  needsScopeUpgrade: vi.fn(() => false),
  getTokens: vi.fn(async () => ({ access_token: 'fake' })),
}));

import { scheduleTimeBlocks, removeScheduledEvents } from './goalCalendarScheduler.js';
import { addProgressEntry, deleteGoal } from './identity/goals.js';

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
    duringInsert = undefined;
    deleteEvent.mockReset().mockResolvedValue({});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-20T12:00:00Z'));
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('applies scheduledEvents onto a goal edited while Calendar calls were in flight, without dropping the edit', async () => {
    writeFileSync(goalsFile(), JSON.stringify({ goals: [baseGoal()] }));

    let progressWrite;
    duringInsert = () => (progressWrite ??= addProgressEntry('g1', {
      date: '2026-06-01', note: 'logged during scheduling', durationMinutes: 15
    }));
    const result = await scheduleTimeBlocks('g1');
    expect(result.count).toBeGreaterThan(0);

    const written = JSON.parse(readFileSync(goalsFile(), 'utf8'));
    const goal = written.goals[0];
    expect(goal.scheduledEvents.length).toBe(result.count);
    expect(goal.progressLog).toHaveLength(1);
    expect(goal.progressLog[0].note).toBe('logged during scheduling');
  });

  it('removes newly created calendar events and fails if the goal is deleted during insertion', async () => {
    const goal = baseGoal();
    goal.timeBlockConfig.subcalendarId = 'example-calendar';
    writeFileSync(goalsFile(), JSON.stringify({ goals: [goal] }));
    const deletion = { promise: null };
    duringInsert = () => (deletion.promise ??= deleteGoal('g1'));

    await expect(scheduleTimeBlocks('g1')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(insertedEvents.length).toBeGreaterThan(0);
    expect(deleteEvent).toHaveBeenCalledTimes(insertedEvents.length);
    for (const event of insertedEvents) {
      expect(deleteEvent).toHaveBeenCalledWith({ calendarId: 'example-calendar', eventId: event.id });
    }
    expect(JSON.parse(readFileSync(goalsFile(), 'utf8')).goals).toEqual([]);
  });

  it('reports incomplete compensation while attempting every created event', async () => {
    writeFileSync(goalsFile(), JSON.stringify({ goals: [baseGoal()] }));
    const deletion = { promise: null };
    duringInsert = () => (deletion.promise ??= deleteGoal('g1'));
    deleteEvent.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { code: 503 }));

    await expect(scheduleTimeBlocks('g1')).rejects.toMatchObject({ code: 'CALENDAR_CLEANUP_FAILED' });
    expect(deleteEvent).toHaveBeenCalledTimes(insertedEvents.length);
    expect(JSON.parse(readFileSync(goalsFile(), 'utf8')).goals).toEqual([]);
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
