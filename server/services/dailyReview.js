import { join } from 'path';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import * as calendarSync from './calendarSync.js';
import * as calendarAccounts from './calendarAccounts.js';
import { getGoals, reconcileCalendarProgress } from './identity.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';

const REVIEW_DIR = join(PATHS.calendar, 'daily-reviews');
const reviewQueue = createKeyCachedQueue();

async function loadReview(date) {
  await ensureDir(REVIEW_DIR);
  const review = await readJSONFile(join(REVIEW_DIR, `${date}.json`), null, { strict: true });
  if (!review) return null;
  // Provider event IDs are arbitrary strings, including object prototype names.
  review.confirmations = Object.assign(Object.create(null), review.confirmations);
  if (review.pendingOperations) {
    review.pendingOperations = Object.assign(Object.create(null), review.pendingOperations);
  }
  return review;
}

async function saveReview(date, data) {
  await atomicWrite(join(REVIEW_DIR, `${date}.json`), data);
}

export async function getDailyReview(date) {
  // Recover a durable intent before projecting confirmations or goal progress.
  const existing = await reviewQueue(date, async () => {
    const review = await loadReview(date) || { confirmations: Object.create(null), updatedAt: null };
    for (const eventId of Object.keys(review.pendingOperations || {})) {
      await finishPendingReview(date, review, eventId).catch(error => {
        // A deleted goal needs an operator correction, not a day-wide outage.
        // Keep its intent durable and visible; every other failure still rejects.
        if (error.code !== 'GOAL_NOT_FOUND') throw error;
      });
    }
    return review;
  });
  // Get all events for this date across all accounts
  const startDate = `${date}T00:00:00`;
  const endDate = `${date}T23:59:59`;
  const [{ events }, accounts, goalsData] = await Promise.all([
    calendarSync.getEvents({ startDate, endDate, limit: 200 }),
    calendarAccounts.listAccounts(),
    getGoals()
  ]);
  const subcalendarMap = {};
  for (const account of accounts) {
    for (const sc of (account.subcalendars || [])) {
      subcalendarMap[sc.calendarId] = { ...sc, accountName: account.name };
    }
  }

  // Build goal and subcalendar maps for linking info
  const goalMap = {};
  for (const goal of goalsData.goals) {
    goalMap[goal.id] = goal;
    // Build reverse map: subcalendarId -> goalIds
    for (const lc of (goal.linkedCalendars || [])) {
      if (!subcalendarMap[lc.subcalendarId]) continue;
      if (!subcalendarMap[lc.subcalendarId].linkedGoals) subcalendarMap[lc.subcalendarId].linkedGoals = [];
      subcalendarMap[lc.subcalendarId].linkedGoals.push({ goalId: goal.id, goalTitle: goal.title, matchPattern: lc.matchPattern });
    }
  }

  // Enrich events with confirmation status and goal matches
  const enrichedEvents = events.map(event => {
    const confirmation = existing.confirmations[event.id || event.externalId];
    const subcalInfo = subcalendarMap[event.subcalendarId];
    const matchingGoals = (subcalInfo?.linkedGoals || []).filter(lg => {
      if (!lg.matchPattern) return true;
      return event.title?.toLowerCase().includes(lg.matchPattern.toLowerCase());
    });

    return {
      ...event,
      subcalendarColor: subcalInfo?.color,
      subcalendarName: event.subcalendarName || subcalInfo?.name,
      confirmation: confirmation || null,
      matchingGoals
    };
  });

  // Get progress entries for this date
  const progressEntries = [];
  for (const goal of goalsData.goals) {
    for (const entry of (goal.progressLog || [])) {
      if (entry.date === date) {
        progressEntries.push({ ...entry, goalId: goal.id, goalTitle: goal.title });
      }
    }
  }

  // Find last sync time
  let lastSyncAt = null;
  for (const account of accounts) {
    if (account.lastSyncAt && (!lastSyncAt || account.lastSyncAt > lastSyncAt)) {
      lastSyncAt = account.lastSyncAt;
    }
  }

  return {
    date,
    events: enrichedEvents,
    confirmations: existing.confirmations,
    pendingConfirmations: Object.fromEntries(Object.keys(existing.pendingOperations || {})
      .map(eventId => [eventId, { code: 'GOAL_NOT_FOUND' }])),
    progressEntries,
    lastSyncAt,
    summary: {
      totalEvents: enrichedEvents.length,
      confirmed: Object.values(existing.confirmations).filter(c => c.happened).length,
      skipped: Object.values(existing.confirmations).filter(c => c.happened === false).length,
      unreviewed: enrichedEvents.filter(e => !existing.confirmations[e.id || e.externalId]).length
    },
    updatedAt: existing.updatedAt
  };
}

// The intent is saved before goal effects; only completed effects publish a
// confirmation. Replaying after either write failed uses the same source key.
async function finishPendingReview(date, review, eventId) {
  const pending = review.pendingOperations?.[eventId];
  if (!pending) return null;
  const { confirmation, sourceKey } = pending;
  const progressEntry = await reconcileCalendarProgress(sourceKey, {
    goalId: confirmation.happened ? confirmation.goalId : null,
    date,
    note: confirmation.note || 'Calendar event confirmed',
    durationMinutes: confirmation.durationMinutes
  });
  review.confirmations[eventId] = confirmation;
  review.updatedAt = confirmation.confirmedAt;
  delete review.pendingOperations[eventId];
  if (!Object.keys(review.pendingOperations).length) delete review.pendingOperations;
  await saveReview(date, review);
  return progressEntry;
}

export function confirmEvent(date, { eventId, happened, goalId, durationMinutes, note }) {
  return reviewQueue(date, async () => {
    const review = await loadReview(date) || { confirmations: Object.create(null), updatedAt: null };
    // A new desired state supersedes this event's interrupted intent, including
    // a deleted goal. Independent events retain their own recoverable intents.
    review.pendingOperations ||= Object.create(null);
    const sourceKey = `calendar-review:${date}:${eventId}`;
    review.pendingOperations[eventId] = {
      eventId,
      sourceKey,
      priorGoalId: review.pendingOperations[eventId]?.priorGoalId ?? review.confirmations[eventId]?.goalId ?? null,
      confirmation: {
        happened,
        goalId: goalId || null,
        durationMinutes: durationMinutes || null,
        note: note || '',
        sourceKey,
        confirmedAt: new Date().toISOString()
      }
    };
    await saveReview(date, review);
    const progressEntry = await finishPendingReview(date, review, eventId);
    console.log(`📅 Event ${eventId} ${happened ? 'confirmed' : 'skipped'} for ${date}`);
    return { confirmation: review.confirmations[eventId], progressEntry };
  });
}

export async function getDailyReviewHistory(startDate, endDate) {
  await ensureDir(REVIEW_DIR);
  const { readdir } = await import('fs/promises');
  const files = await readdir(REVIEW_DIR).catch(() => []);

  // Filter to the requested date window first (cheap, no I/O), then read the
  // surviving review files in parallel instead of serializing one disk read
  // per day across the whole history.
  const inRange = files
    .filter(file => file.endsWith('.json'))
    .map(file => file.replace('.json', ''))
    .filter(reviewDate => {
      if (startDate && reviewDate < startDate) return false;
      if (endDate && reviewDate > endDate) return false;
      return true;
    });

  const loaded = await Promise.all(
    inRange.map(async reviewDate => {
      // Read-only history projection; confirmations use the strict loadReview path.
      const data = await readJSONFile(join(REVIEW_DIR, `${reviewDate}.json`), null);
      if (!data) return null;
      const confirmations = Object.values(data.confirmations || {});
      return {
        date: reviewDate,
        confirmed: confirmations.filter(c => c.happened).length,
        skipped: confirmations.filter(c => c.happened === false).length,
        total: confirmations.length,
        updatedAt: data.updatedAt
      };
    })
  );

  return loaded.filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));
}
