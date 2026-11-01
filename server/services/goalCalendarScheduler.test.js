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

var tempRoot;
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
let insertAttempts;
let rejectInsert;
const deleteEvent = vi.fn(async () => ({}));
vi.mock('@googleapis/calendar', () => ({
  calendar: () => ({
    events: {
      insert: vi.fn(async ({ requestBody }) => {
        const attempt = ++insertAttempts;
        if (attempt === rejectInsert) throw new Error('Calendar quota exceeded');
        const id = `evt-${attempt}`;
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
  GOOGLE_API_TIMEOUT_MS: 30_000,
  needsScopeUpgrade: vi.fn(() => false),
  getTokens: vi.fn(async () => ({ access_token: 'fake' })),
}));

vi.mock('./userTimezone.js', () => ({
  getUserTimezone: vi.fn(async () => 'UTC'),
}));

import * as goalStore from './identity/store.js';
import { scheduleTimeBlocks, removeScheduledEvents, rescheduleTimeBlocks } from './goalCalendarScheduler.js';
import { addProgressEntry, deleteGoal } from './identity/goals.js';
import { getUserTimezone } from './userTimezone.js';

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
    insertAttempts = 0;
    rejectInsert = undefined;
    deleteEvent.mockReset().mockResolvedValue({});
    getUserTimezone.mockResolvedValue('UTC');
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

  const dailyGoal = () => {
    const goal = baseGoal();
    goal.timeBlockConfig.preferredDays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    goal.timeBlockConfig.subcalendarId = 'example-calendar';
    return goal;
  };

  it('compensates all 11 successful inserts when the 12th fails, then retries without duplicate events', async () => {
    writeFileSync(goalsFile(), JSON.stringify({ goals: [dailyGoal()] }));
    rejectInsert = 12;
    await expect(scheduleTimeBlocks('g1')).rejects.toMatchObject({
      code: 'CALENDAR_INSERT_FAILED',
      message: expect.stringContaining('All 11 created calendar events were removed')
    });
    expect(insertedEvents).toHaveLength(11);
    expect(deleteEvent.mock.calls.map(([evt]) => evt.eventId)).toEqual(insertedEvents.map(evt => evt.id));
    expect(JSON.parse(readFileSync(goalsFile(), 'utf8')).goals[0].scheduledEvents).toEqual([]);

    rejectInsert = undefined;
    const result = await scheduleTimeBlocks('g1');
    expect(result.count).toBe(12);
    const retainedIds = JSON.parse(readFileSync(goalsFile(), 'utf8')).goals[0].scheduledEvents.map(evt => evt.googleEventId);
    expect(retainedIds).toEqual(result.events.map(evt => evt.googleEventId));
    expect(retainedIds.every(id => !deleteEvent.mock.calls.some(([evt]) => evt.eventId === id))).toBe(true);
  });

  it('stops after the failed batch and preserves survivors, existing events and concurrent edits for reschedule cleanup', async () => {
    const goal = dailyGoal();
    goal.targetDate = goal.milestones[0].targetDate = '2027-01-20';
    const existing = { id: 'existing', googleEventId: 'old-event', calendarId: 'primary' };
    goal.scheduledEvents = [existing];
    writeFileSync(goalsFile(), JSON.stringify({ goals: [goal] }));
    rejectInsert = 12;
    let progressWrite;
    duringInsert = () => (progressWrite ??= addProgressEntry('g1', { note: 'keep progress', date: '2026-12-20' }));
    deleteEvent.mockImplementation(async ({ eventId }) => {
      if (eventId === 'evt-11' || eventId === 'evt-20') throw new Error('Delete unavailable');
      if (eventId === 'evt-1') throw Object.assign(new Error('Already deleted'), { code: 410 });
    });
    await expect(scheduleTimeBlocks('g1')).rejects.toMatchObject({
      code: 'CALENDAR_CLEANUP_FAILED', message: expect.stringContaining('2 calendar events could not be removed')
    });
    expect(insertAttempts).toBe(20);
    expect(deleteEvent).toHaveBeenCalledTimes(19);
    let saved = JSON.parse(readFileSync(goalsFile(), 'utf8')).goals[0];
    expect(saved.scheduledEvents.map(evt => evt.googleEventId)).toEqual(['old-event', 'evt-11', 'evt-20']);
    expect(saved.progressLog[0].note).toBe('keep progress');
    expect(saved.title).toBe(goal.title);
    expect(deleteEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventId: 'old-event' }));

    await expect(rescheduleTimeBlocks('g1')).rejects.toMatchObject({ code: 'CALENDAR_CLEANUP_FAILED' });
    expect(insertAttempts).toBe(20);
    saved = JSON.parse(readFileSync(goalsFile(), 'utf8')).goals[0];
    expect(saved.scheduledEvents.map(evt => evt.googleEventId)).toEqual(['evt-11', 'evt-20']);
    deleteEvent.mockResolvedValue({});
    await removeScheduledEvents('g1');
    expect(JSON.parse(readFileSync(goalsFile(), 'utf8')).goals[0].scheduledEvents).toEqual([]);
  });

  it('preserves previously scheduled events when a new schedule succeeds', async () => {
    const goal = baseGoal();
    const existing = { id: 'existing', googleEventId: 'old-event', calendarId: 'primary' };
    goal.scheduledEvents = [existing];
    writeFileSync(goalsFile(), JSON.stringify({ goals: [goal] }));
    const result = await scheduleTimeBlocks('g1');
    expect(JSON.parse(readFileSync(goalsFile(), 'utf8')).goals[0].scheduledEvents).toEqual([existing, ...result.events]);
  });

  it('reports survivor IDs when the goal was deleted during a failed insert batch', async () => {
    writeFileSync(goalsFile(), JSON.stringify({ goals: [dailyGoal()] }));
    rejectInsert = 12;
    let deletion;
    duringInsert = () => (deletion ??= deleteGoal('g1'));
    deleteEvent.mockRejectedValueOnce(new Error('Delete unavailable'));
    await expect(scheduleTimeBlocks('g1')).rejects.toMatchObject({
      code: 'CALENDAR_CLEANUP_FAILED',
      message: expect.stringContaining('could not be saved'),
      context: { remainingEvents: [expect.objectContaining({ googleEventId: 'evt-1', calendarId: 'example-calendar' })] }
    });
    expect(JSON.parse(readFileSync(goalsFile(), 'utf8')).goals).toEqual([]);
  });

  it('compensates events when saving a completed schedule fails and retains failed deletions on the next write', async () => {
    writeFileSync(goalsFile(), JSON.stringify({ goals: [baseGoal()] }));
    vi.spyOn(goalStore, 'mutateGoals').mockRejectedValueOnce(new Error('Disk unavailable'));
    deleteEvent.mockRejectedValueOnce(new Error('Delete unavailable'));
    await expect(scheduleTimeBlocks('g1')).rejects.toMatchObject({
      code: 'CALENDAR_CLEANUP_FAILED', message: expect.stringContaining('Could not save scheduled calendar events')
    });
    expect(deleteEvent).toHaveBeenCalledTimes(insertedEvents.length);
    expect(JSON.parse(readFileSync(goalsFile(), 'utf8')).goals[0].scheduledEvents).toEqual([
      expect.objectContaining({ googleEventId: 'evt-1' })
    ]);
  });

  it('reports survivor IDs explicitly if the survivor write also fails', async () => {
    writeFileSync(goalsFile(), JSON.stringify({ goals: [dailyGoal()] }));
    rejectInsert = 12;
    vi.spyOn(goalStore, 'mutateGoals').mockRejectedValueOnce(new Error('Disk unavailable'));
    deleteEvent.mockRejectedValueOnce(new Error('Delete unavailable'));
    await expect(scheduleTimeBlocks('g1')).rejects.toMatchObject({
      code: 'CALENDAR_CLEANUP_FAILED', message: expect.stringContaining('could not be saved'),
      context: {
        remainingEvents: [expect.objectContaining({ googleEventId: 'evt-1', calendarId: 'example-calendar' })],
        persistenceError: 'Disk unavailable'
      }
    });
    expect(deleteEvent).toHaveBeenCalledTimes(11);
    expect(JSON.parse(readFileSync(goalsFile(), 'utf8')).goals[0].scheduledEvents).toEqual([]);
  });

  it('reports surviving event IDs when the goal is deleted during removal', async () => {
    const goal = baseGoal();
    goal.scheduledEvents = [{ id: 'sched-1', googleEventId: 'existing-event', calendarId: 'example-calendar' }];
    writeFileSync(goalsFile(), JSON.stringify({ goals: [goal] }));
    deleteEvent.mockImplementationOnce(async () => {
      await deleteGoal('g1');
      throw new Error('Delete unavailable');
    });

    await expect(removeScheduledEvents('g1')).rejects.toMatchObject({
      code: 'CALENDAR_CLEANUP_FAILED',
      message: expect.stringContaining('goal was deleted during cleanup'),
      context: { remainingEvents: goal.scheduledEvents }
    });
    expect(JSON.parse(readFileSync(goalsFile(), 'utf8')).goals).toEqual([]);
  });

  it('reports surviving event IDs and the write failure when removal cannot persist its result', async () => {
    const goal = baseGoal();
    goal.scheduledEvents = [{ id: 'sched-1', googleEventId: 'existing-event', calendarId: 'example-calendar' }];
    writeFileSync(goalsFile(), JSON.stringify({ goals: [goal] }));
    const writeError = new Error('Disk unavailable');
    vi.spyOn(goalStore, 'mutateGoals').mockRejectedValueOnce(writeError);
    deleteEvent.mockRejectedValueOnce(new Error('Delete unavailable'));

    await expect(removeScheduledEvents('g1')).rejects.toMatchObject({
      code: 'CALENDAR_CLEANUP_FAILED',
      message: expect.stringContaining('Could not save the cleanup result: Disk unavailable'),
      cause: writeError,
      context: { remainingEvents: goal.scheduledEvents, persistenceError: 'Disk unavailable' }
    });
    expect(JSON.parse(readFileSync(goalsFile(), 'utf8')).goals[0].scheduledEvents).toEqual(goal.scheduledEvents);
  });

  it('reports a cleanup write failure after all calendar events were removed', async () => {
    const goal = baseGoal();
    goal.scheduledEvents = [{ id: 'sched-1', googleEventId: 'existing-event', calendarId: 'primary' }];
    writeFileSync(goalsFile(), JSON.stringify({ goals: [goal] }));
    const writeError = new Error('Disk unavailable');
    vi.spyOn(goalStore, 'mutateGoals').mockRejectedValueOnce(writeError);

    await expect(removeScheduledEvents('g1')).rejects.toMatchObject({
      code: 'CALENDAR_SAVE_FAILED',
      message: expect.stringContaining('All 1 calendar events were removed'),
      cause: writeError,
      context: { remainingEvents: [], persistenceError: 'Disk unavailable' }
    });
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

  describe('user timezone and milestone boundary scheduling (#12611)', () => {
    it('schedules events in the user timezone with local wall-clock times and correct local weekdays under TZ=UTC', async () => {
      getUserTimezone.mockResolvedValue('America/Los_Angeles');
      // 2026-10-21T01:00:00Z is 2026-10-20T18:00:00 in America/Los_Angeles (Tuesday evening).
      // Under TZ=UTC, server Date is Wednesday Oct 21, but in LA it is Tuesday Oct 20.
      vi.setSystemTime(new Date('2026-10-21T01:00:00Z'));

      const goal = {
        id: 'g-la',
        title: 'Morning Routine',
        status: 'active',
        createdAt: '2026-10-20T00:00:00.000Z',
        targetDate: '2026-10-28',
        milestones: [
          { id: 'ms1', title: 'Phase 1', order: 0, targetDate: '2026-10-28', completedAt: null }
        ],
        timeBlockConfig: {
          preferredDays: ['mon', 'wed'],
          timeSlot: 'morning',
          sessionDurationMinutes: 30,
        },
        scheduledEvents: [],
      };
      writeFileSync(goalsFile(), JSON.stringify({ goals: [goal] }));

      const result = await scheduleTimeBlocks('g-la');
      expect(result.count).toBe(3);

      // Local LA days starting from Tuesday Oct 20: Wed Oct 21, Mon Oct 26, Wed Oct 28
      const firstEvent = insertedEvents[0].requestBody;
      expect(firstEvent.start).toEqual({
        dateTime: '2026-10-21T09:00:00',
        timeZone: 'America/Los_Angeles',
      });
      expect(firstEvent.end).toEqual({
        dateTime: '2026-10-21T09:30:00',
        timeZone: 'America/Los_Angeles',
      });

      const dates = insertedEvents.map(e => e.requestBody.start.dateTime.slice(0, 10));
      expect(dates).toEqual(['2026-10-21', '2026-10-26', '2026-10-28']);

      for (const event of insertedEvents) {
        expect(event.requestBody.start.timeZone).toBe('America/Los_Angeles');
        expect(event.requestBody.start.dateTime).toMatch(/T09:00:00$/);
        expect(event.requestBody.start.dateTime).not.toContain('Z');
        expect(event.requestBody.end.timeZone).toBe('America/Los_Angeles');
        expect(event.requestBody.end.dateTime).toMatch(/T09:30:00$/);
        expect(event.requestBody.end.dateTime).not.toContain('Z');
      }
    });

    it('allocates exactly one session on a preferred boundary day shared by consecutive milestones', async () => {
      getUserTimezone.mockResolvedValue('America/Los_Angeles');
      // 2026-10-19 is Monday
      vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));

      const goal = {
        id: 'g-boundary',
        title: 'Milestone Goal',
        status: 'active',
        createdAt: '2026-10-19T00:00:00.000Z',
        targetDate: '2026-10-28',
        milestones: [
          { id: 'ms1', title: 'Phase 1', order: 0, targetDate: '2026-10-21', completedAt: null }, // Wednesday
          { id: 'ms2', title: 'Phase 2', order: 1, targetDate: '2026-10-28', completedAt: null }, // Wednesday
        ],
        timeBlockConfig: {
          preferredDays: ['wed'],
          timeSlot: 'morning',
          sessionDurationMinutes: 60,
        },
        scheduledEvents: [],
      };
      writeFileSync(goalsFile(), JSON.stringify({ goals: [goal] }));

      const result = await scheduleTimeBlocks('g-boundary');
      expect(result.count).toBe(2);

      const boundaryEvents = insertedEvents.filter(e => e.requestBody.start.dateTime.startsWith('2026-10-21'));
      expect(boundaryEvents).toHaveLength(1);
      expect(boundaryEvents[0].requestBody.summary).toBe('Milestone Goal - Phase 1');

      const phase2Events = insertedEvents.filter(e => e.requestBody.summary.includes('Phase 2'));
      expect(phase2Events).toHaveLength(1);
      expect(phase2Events[0].requestBody.start.dateTime).toBe('2026-10-28T09:00:00');
    });

    it('continues scheduling sessions for a milestone following one with targetDate: null', async () => {
      getUserTimezone.mockResolvedValue('America/Los_Angeles');
      // 2026-10-19 is Monday
      vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));

      const goal = {
        id: 'g-undated',
        title: 'Undated Milestone Goal',
        status: 'active',
        createdAt: '2026-10-19T00:00:00.000Z',
        targetDate: '2026-10-30',
        milestones: [
          { id: 'ms1', title: 'Phase 1', order: 0, targetDate: '2026-10-21', completedAt: null }, // Wednesday
          { id: 'ms2', title: 'Phase 2 (undated)', order: 1, targetDate: null, completedAt: null },
          { id: 'ms3', title: 'Phase 3', order: 2, targetDate: '2026-10-30', completedAt: null }, // Friday
        ],
        timeBlockConfig: {
          preferredDays: ['mon', 'wed', 'fri'],
          timeSlot: 'morning',
          sessionDurationMinutes: 30,
        },
        scheduledEvents: [],
      };
      writeFileSync(goalsFile(), JSON.stringify({ goals: [goal] }));

      const result = await scheduleTimeBlocks('g-undated');
      expect(result.count).toBeGreaterThan(0);

      const phase2Events = insertedEvents.filter(e => e.requestBody.summary.includes('Phase 2 (undated)'));
      expect(phase2Events.length).toBeGreaterThan(0);

      const phase3Events = insertedEvents.filter(e => e.requestBody.summary.includes('Phase 3'));
      expect(phase3Events.length).toBeGreaterThan(0);
    });
  });
});
