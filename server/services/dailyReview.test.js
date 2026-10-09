import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const fault = vi.hoisted(() => ({ kind: null, countdown: 0 }));
// Mirrors calendarSync.getEvents: a bounded page plus the filtered window's total.
const source = vi.hoisted(() => ({ events: [], calls: [] }));
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return makePathsProxy(actual, {
    dataRoot: () => lazyTempDataRoot('portos-review-recovery-'),
    overrides: {
      atomicWrite: async (path, ...args) => {
        const kind = path.endsWith('goals.json') ? 'goals' : 'review';
        if (kind === fault.kind && --fault.countdown === 0) throw new Error('injected write failure');
        return actual.atomicWrite(path, ...args);
      }
    }
  });
});
vi.mock('./mortalLoomStore.js', () => ({
  isMortalLoomEnabled: async () => false,
  mlArrayIfEnabled: async () => null,
  mlReplace: vi.fn()
}));
vi.mock('./calendarSync.js', () => ({
  getEvents: async ({ limit = 50, offset = 0 }) => {
    source.calls.push({ limit, offset });
    return { events: source.events.slice(offset, offset + limit), total: source.events.length };
  }
}));
vi.mock('./calendarAccounts.js', () => ({ listAccounts: async () => [] }));
vi.mock('./aiProvider.js', () => ({ callProviderAISimple: vi.fn(), parseLLMJSON: vi.fn() }));
vi.mock('./meatspaceCalendar.js', () => ({ getActivities: async () => [] }));
vi.mock('./identity.js', () => ({
  // Dynamic forwarding matters after resetModules: the real store queue and the
  // manual progress writer must come from the same fresh module instance.
  reconcileCalendarProgress: async (...args) => (await import('./identity/goals.js')).reconcileCalendarProgress(...args),
  getGoals: async () => {
    const store = await import('./identity/store.js');
    return store.loadJSON(store.GOALS_FILE, store.DEFAULT_GOALS, { strict: true });
  }
}));

import { PATHS } from '../lib/fileUtils.js';
const date = '2026-01-02';
const reviewPath = join(PATHS.calendar, 'daily-reviews', `${date}.json`);
const goalsPath = join(PATHS.digitalTwin, 'goals.json');
const input = { eventId: 'event-a', happened: true, goalId: 'goal-a', durationMinutes: 30, note: 'Practice' };
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const write = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); };
let review;
let goals;
beforeEach(async () => {
  fault.kind = null;
  source.events = [{ id: 'event-a' }];
  source.calls = [];
  vi.resetModules();
  await rm(PATHS.calendar, { force: true, recursive: true });
  await write(goalsPath, { goals: [
    { id: 'goal-a', progressLog: [{ id: 'manual', date, note: 'Manual', durationMinutes: 15 }] },
    { id: 'goal-b', progressLog: [] }
  ] });
  review = await import('./dailyReview.js');
  goals = await import('./identity/goals.js');
});
afterAll(cleanupTempDataRoots);

const allProgress = async () => (await read(goalsPath)).goals.flatMap(goal => goal.progressLog || []);

describe('daily review pagination', () => {
  const dayOf = count => Array.from({ length: count }, (_, i) => ({ id: `event-${i}`, title: `Event ${i}` }));

  it('exposes the 201st event on a continuation page and keeps full-day counts on every page', async () => {
    source.events = dayOf(201);
    await review.confirmEvent(date, { eventId: 'event-200', happened: true });

    const first = await review.getDailyReview(date);
    expect(first.events).toHaveLength(200);
    expect(first).toMatchObject({ total: 201, limit: 200, offset: 0, nextOffset: 200, hasMore: true });
    expect(first.summary).toMatchObject({ totalEvents: 201, confirmed: 1, unreviewed: 200 });
    expect(first.events.some(event => event.id === 'event-200')).toBe(false);
    expect(first.confirmations['event-200'].happened).toBe(true);

    const second = await review.getDailyReview(date, { limit: 200, offset: first.nextOffset });
    expect(second.events.map(event => event.id)).toEqual(['event-200']);
    expect(second.events[0].confirmation).toMatchObject({ happened: true });
    expect(second).toMatchObject({ total: 201, offset: 200, nextOffset: null, hasMore: false });
    expect(second.summary).toEqual(first.summary);
  });

  it('honors a smaller caller page without shrinking the summary', async () => {
    source.events = dayOf(5);
    const page = await review.getDailyReview(date, { limit: 2, offset: 2 });
    expect(page.events.map(event => event.id)).toEqual(['event-2', 'event-3']);
    expect(page).toMatchObject({ total: 5, nextOffset: 4, hasMore: true });
    expect(page.summary.unreviewed).toBe(5);
  });
});

describe('calendar confirmation persistence workflow', () => {
  it('replays a lost response, edits and moves one owned entry, then skips without removing manual progress', async () => {
    const first = await review.confirmEvent(date, input);
    const replay = await review.confirmEvent(date, input);
    expect(replay.progressEntry.id).toBe(first.progressEntry.id);
    expect(await allProgress()).toHaveLength(2);
    const edited = await review.confirmEvent(date, { ...input, durationMinutes: 45, note: 'Updated' });
    expect(edited.progressEntry).toMatchObject({ id: first.progressEntry.id, durationMinutes: 45, note: 'Updated' });
    await review.confirmEvent(date, { ...input, goalId: 'goal-b' });
    const saved = await read(goalsPath);
    expect(saved.goals[0].progressLog.map(entry => entry.id)).toEqual(['manual']);
    expect(saved.goals[1].progressLog).toEqual([expect.objectContaining({ id: first.progressEntry.id })]);
    await review.confirmEvent(date, { ...input, goalId: 'goal-b', happened: false });
    expect(await allProgress()).toEqual([expect.objectContaining({ id: 'manual' })]);
    expect((await read(reviewPath)).confirmations['event-a'].happened).toBe(false);
  });

  it('persists provider event IDs that coincide with object prototype properties', async () => {
    for (const eventId of ['__proto__', 'constructor', 'toString']) {
      const confirmation = await review.confirmEvent(date, { ...input, eventId });
      expect((await read(reviewPath)).confirmations[eventId]).toEqual(confirmation.confirmation);
      await review.confirmEvent(date, { ...input, eventId });
    }
    expect((await allProgress()).filter(entry => entry.sourceKey)).toHaveLength(3);
    for (const eventId of ['__proto__', 'constructor', 'toString']) {
      await review.confirmEvent(date, { ...input, eventId, happened: false });
    }
    expect(await allProgress()).toEqual([expect.objectContaining({ id: 'manual' })]);
  });

  it('serializes different events, different dates and manual writes against the shared goal store', async () => {
    await Promise.all([
      review.confirmEvent(date, input),
      review.confirmEvent(date, { ...input, eventId: 'event-b' }),
      review.confirmEvent('2026-01-03', input),
      goals.addProgressEntry('goal-a', { date, note: 'Concurrent manual', durationMinutes: 10 })
    ]);
    expect(Object.keys((await read(reviewPath)).confirmations).sort()).toEqual(['event-a', 'event-b']);
    expect(await allProgress()).toHaveLength(5);
    expect((await allProgress()).filter(entry => entry.sourceKey)).toHaveLength(3);
  });

  it.each([
    ['review', 1, false], // intent never persisted
    ['goals', 1, true], // intent persisted, goal write failed
    ['review', 2, true] // goal committed, confirmation commit failed
  ])('recovers a %s write failure at step %s on retry after a restart', async (kind, countdown, pending) => {
    fault.kind = kind;
    fault.countdown = countdown;
    await expect(review.confirmEvent(date, input)).rejects.toThrow('injected write failure');
    if (pending) {
      const interrupted = await read(reviewPath);
      expect(interrupted.confirmations).toEqual({});
      expect(interrupted.pendingOperations['event-a'].sourceKey).toBe(`calendar-review:${date}:event-a`);
    } else {
      await expect(readFile(reviewPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    fault.kind = null;
    vi.resetModules();
    review = await import('./dailyReview.js');
    await review.confirmEvent(date, input);
    expect((await allProgress()).filter(entry => entry.sourceKey)).toHaveLength(1);
    expect((await read(reviewPath)).pendingOperations).toBeUndefined();
  });

  it('an explicit read completes an interrupted intent without provider calls', async () => {
    fault.kind = 'review';
    fault.countdown = 2;
    await expect(review.confirmEvent(date, input)).rejects.toThrow('injected write failure');
    fault.kind = null;
    vi.resetModules();
    review = await import('./dailyReview.js');
    const recovered = await review.getDailyReview(date);
    expect(recovered.confirmations['event-a'].happened).toBe(true);
    expect(recovered.progressEntries.filter(entry => entry.sourceKey)).toHaveLength(1);
    const { callProviderAISimple } = await import('./aiProvider.js');
    expect(callProviderAISimple).not.toHaveBeenCalled();
  });

  it('rejects missing goals before completing, and allows the same event to supersede that pending intent', async () => {
    await expect(review.confirmEvent(date, { ...input, goalId: 'missing' }))
      .rejects.toMatchObject({ status: 404, code: 'GOAL_NOT_FOUND' });
    expect((await read(reviewPath)).confirmations).toEqual({});
    expect(await allProgress()).toEqual([expect.objectContaining({ id: 'manual' })]);
    const pendingReview = await review.getDailyReview(date);
    expect(pendingReview.pendingConfirmations['event-a']).toEqual({ code: 'GOAL_NOT_FOUND' });
    await review.confirmEvent(date, { ...input, eventId: 'event-b' });
    expect((await read(reviewPath)).pendingOperations['event-a']).toBeDefined();
    await review.confirmEvent(date, { ...input, happened: false });
    expect((await read(reviewPath)).pendingOperations).toBeUndefined();
  });

  it('preserves legacy confirmation fields and never infers ownership from date or free-form notes', async () => {
    const legacy = { happened: true, goalId: 'goal-a', note: 'Manual', confirmedAt: '2025-12-01T00:00:00Z' };
    await write(reviewPath, { confirmations: { legacy, 'event-a': legacy }, updatedAt: null });
    await review.confirmEvent(date, { ...input, happened: false });
    expect((await read(reviewPath)).confirmations.legacy).toEqual(legacy);
    expect(await allProgress()).toEqual([expect.objectContaining({ id: 'manual' })]);
  });
});
