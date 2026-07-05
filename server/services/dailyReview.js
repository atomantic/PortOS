import { join } from 'path';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import * as calendarSync from './calendarSync.js';
import * as calendarAccounts from './calendarAccounts.js';
import { addProgressEntry, getGoals } from './identity.js';

const REVIEW_DIR = join(PATHS.calendar, 'daily-reviews');

async function loadReview(date) {
  await ensureDir(REVIEW_DIR);
  return readJSONFile(join(REVIEW_DIR, `${date}.json`), null);
}

async function saveReview(date, data) {
  await atomicWrite(join(REVIEW_DIR, `${date}.json`), data);
}

export async function getDailyReview(date) {
  // Get all events for this date across all accounts
  const startDate = `${date}T00:00:00`;
  const endDate = `${date}T23:59:59`;
  const [{ events }, existing, accounts, goalsData] = await Promise.all([
    calendarSync.getEvents({ startDate, endDate, limit: 200 }),
    loadReview(date).then(r => r || { confirmations: {}, updatedAt: null }),
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

export async function confirmEvent(date, { eventId, happened, goalId, durationMinutes, note }) {
  const existing = await loadReview(date) || { confirmations: {}, updatedAt: null };

  existing.confirmations[eventId] = {
    happened,
    goalId: goalId || null,
    durationMinutes: durationMinutes || null,
    note: note || '',
    confirmedAt: new Date().toISOString()
  };
  existing.updatedAt = new Date().toISOString();

  await saveReview(date, existing);

  // If event happened and linked to a goal, auto-create progress entry
  let progressEntry = null;
  if (happened && goalId) {
    const entryNote = note || 'Calendar event confirmed';
    progressEntry = await addProgressEntry(goalId, {
      date,
      note: entryNote,
      ...(durationMinutes ? { durationMinutes } : {})
    });
    console.log(`📅 Auto-logged progress for goal ${goalId} from daily review`);
  }

  console.log(`📅 Event ${eventId} ${happened ? 'confirmed' : 'skipped'} for ${date}`);
  return { confirmation: existing.confirmations[eventId], progressEntry };
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
