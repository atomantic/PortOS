import { calendar } from '@googleapis/calendar';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ServerError } from '../lib/errorHandler.js';
import { getAuthenticatedClient, needsScopeUpgrade, getTokens, GOOGLE_API_TIMEOUT_MS } from './googleAuth.js';
import { loadJSON, mutateGoals, GOALS_FILE, DEFAULT_GOALS } from './identity/store.js';
import { getUserTimezone } from './userTimezone.js';
import { todayInTimezone } from '../lib/timezone.js';

const TIME_SLOT_HOURS = {
  morning: 9,
  afternoon: 13,
  evening: 18
};

const DAY_MAP = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 100) dt.setUTCFullYear(y);
  dt.setUTCDate(dt.getUTCDate() + days);
  const year = String(dt.getUTCFullYear()).padStart(4, '0');
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 100) dt.setUTCFullYear(y);
  return dt.getUTCDay();
}

function toWallClockString(dateStr, hour, minute, addMinutes = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hour, minute));
  if (y < 100) dt.setUTCFullYear(y);
  if (addMinutes) dt.setUTCMinutes(dt.getUTCMinutes() + addMinutes);
  const year = String(dt.getUTCFullYear()).padStart(4, '0');
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  const h = String(dt.getUTCHours()).padStart(2, '0');
  const min = String(dt.getUTCMinutes()).padStart(2, '0');
  const sec = String(dt.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${h}:${min}:${sec}`;
}

function resolveTimeSlotHour(timeSlot) {
  if (TIME_SLOT_HOURS[timeSlot] !== undefined) return TIME_SLOT_HOURS[timeSlot];
  return parseInt(timeSlot.split(':')[0], 10);
}

function resolveTimeSlotMinute(timeSlot) {
  if (TIME_SLOT_HOURS[timeSlot] !== undefined) return 0;
  return parseInt(timeSlot.split(':')[1], 10) || 0;
}

const eventKey = evt => `${evt.calendarId || 'primary'}:${evt.googleEventId}`;

async function deleteCalendarEvents(cal, events) {
  const results = await Promise.allSettled(events.map(async evt =>
    cal.events.delete({ calendarId: evt.calendarId || 'primary', eventId: evt.googleEventId })
  ));
  return events.filter((evt, index) => results[index].status === 'rejected'
    && results[index].reason?.code !== 404 && results[index].reason?.code !== 410);
}

async function retainScheduledEvents(goalId, events) {
  let found = false;
  await mutateGoals(freshGoals => {
    const freshGoal = freshGoals.goals.find(g => g.id === goalId);
    if (!freshGoal) return freshGoals;
    found = true;
    const existing = freshGoal.scheduledEvents || [];
    const existingIds = new Set(existing.map(eventKey));
    freshGoal.scheduledEvents = [...existing, ...events.filter(evt => !existingIds.has(eventKey(evt)))];
    freshGoal.updatedAt = new Date().toISOString();
    freshGoals.updatedAt = new Date().toISOString();
    return freshGoals;
  });
  return found;
}

export async function scheduleTimeBlocks(goalId) {
  const tokens = await getTokens();
  if (needsScopeUpgrade(tokens)) {
    throw new ServerError('Calendar write access required. Please re-authorize Google Calendar.', { status: 403, code: 'SCOPE_UPGRADE_NEEDED' });
  }

  const auth = await getAuthenticatedClient();
  if (!auth) throw new ServerError('Google OAuth not configured', { status: 401, code: 'NO_AUTH' });

  // This read is only to find the goal and its milestones/config for building the
  // calendar event batch below — it is not the snapshot that gets saved. The
  // Google Calendar round-trips can take a while; `mutateGoals` re-reads
  // goals.json right before persisting so a concurrent edit survives (#8755).
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS, { strict: true });
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  if (!goal.timeBlockConfig) throw new ServerError('Time block config not set', { status: 400, code: 'NO_CONFIG' });
  if (!goal.targetDate) throw new ServerError('Target date not set', { status: 400, code: 'NO_TARGET_DATE' });

  const milestones = [...(goal.milestones || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!milestones.length) throw new ServerError('No milestones/phases to schedule', { status: 400, code: 'NO_MILESTONES' });

  const cal = calendar({ version: 'v3', auth, timeout: GOOGLE_API_TIMEOUT_MS });
  const { preferredDays, timeSlot, sessionDurationMinutes, subcalendarId } = goal.timeBlockConfig;
  const calendarId = subcalendarId || 'primary';
  const preferredDayNums = new Set(preferredDays.map(d => DAY_MAP[d]));
  const hour = resolveTimeSlotHour(timeSlot);
  const minute = resolveTimeSlotMinute(timeSlot);
  const tz = await getUserTimezone();
  const today = todayInTimezone(tz);

  // Collect all events to create
  const eventDefs = [];
  let prevRangeStart = today;
  for (let i = 0; i < milestones.length; i++) {
    const ms = milestones[i];
    const rangeStart = i === 0
      ? today
      : (milestones[i - 1]?.targetDate ? addDays(milestones[i - 1].targetDate, 1) : prevRangeStart);
    prevRangeStart = rangeStart;

    if (ms.completedAt) continue;

    const rangeEnd = ms.targetDate || goal.targetDate;

    let cursor = rangeStart < today ? today : rangeStart;
    while (cursor <= rangeEnd) {
      if (preferredDayNums.has(getDayOfWeek(cursor))) {
        eventDefs.push({
          milestoneId: ms.id,
          date: cursor,
          requestBody: {
            summary: `${goal.title} - ${ms.title}`,
            description: `${ms.description || ''}\n\nGoal: ${goal.title}`.trim(),
            start: { dateTime: toWallClockString(cursor, hour, minute), timeZone: tz },
            end: { dateTime: toWallClockString(cursor, hour, minute, sessionDurationMinutes), timeZone: tz }
          }
        });
      }
      cursor = addDays(cursor, 1);
    }
  }

  // Settle the whole batch so a rejection cannot hide successful sibling inserts.
  const BATCH_SIZE = 10;
  const scheduledEvents = [];
  let failure;
  for (let i = 0; i < eventDefs.length; i += BATCH_SIZE) {
    const batch = eventDefs.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async def =>
      cal.events.insert({ calendarId, requestBody: def.requestBody })
    ));
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'rejected') continue;
      scheduledEvents.push({
        id: `sched-${uuidv4()}`,
        googleEventId: results[j].value.data.id,
        calendarId,
        milestoneId: batch[j].milestoneId,
        date: batch[j].date,
        createdAt: new Date().toISOString()
      });
    }
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) {
      failure = new ServerError(`Calendar event insertion failed: ${rejected.reason?.message || 'request rejected'}`, { code: 'CALENDAR_INSERT_FAILED' });
      break;
    }
  }

  if (!failure) {
    // Re-read under the store lock, preserving concurrent edits and older events.
    await retainScheduledEvents(goalId, scheduledEvents).then(found => {
      if (!found) failure = new ServerError('Goal was deleted during scheduling', { status: 404, code: 'NOT_FOUND' });
    }, error => {
      failure = new ServerError(`Could not save scheduled calendar events: ${error.message}`, { code: 'CALENDAR_SAVE_FAILED' });
    });
  }

  if (failure) {
    const survivors = await deleteCalendarEvents(cal, scheduledEvents);
    if (!survivors.length) {
      throw new ServerError(`${failure.message}. All ${scheduledEvents.length} created calendar events were removed.`, { status: failure.status, code: failure.code });
    }
    let retained = false;
    let persistenceError;
    await retainScheduledEvents(goalId, survivors).then(found => { retained = found; }, error => { persistenceError = error.message; });
    const recovery = retained
      ? 'Remaining time blocks were saved to the goal for later removal.'
      : 'Remaining time blocks could not be saved. Remove them in Google Calendar using the event IDs in the error details.';
    throw new ServerError(`${failure.message}; ${survivors.length} calendar events could not be removed. ${recovery}`, {
      code: 'CALENDAR_CLEANUP_FAILED',
      context: { remainingEvents: survivors, ...(persistenceError && { persistenceError }) }
    });
  }

  console.log(`📅 Scheduled ${scheduledEvents.length} time blocks for goal "${goal.title}"`);
  return { count: scheduledEvents.length, events: scheduledEvents };
}

export async function removeScheduledEvents(goalId) {
  const auth = await getAuthenticatedClient();
  if (!auth) throw new ServerError('Google OAuth not configured', { status: 401, code: 'NO_AUTH' });

  // Same pattern as scheduleTimeBlocks: this read only locates the events to
  // delete from Google Calendar; the write below re-reads fresh (#8755).
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS, { strict: true });
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });

  const cal = calendar({ version: 'v3', auth, timeout: GOOGLE_API_TIMEOUT_MS });
  const events = goal.scheduledEvents || [];

  const survivors = await deleteCalendarEvents(cal, events);
  const removedIds = new Set(events.filter(evt => !survivors.includes(evt)).map(eventKey));
  let goalFound = false;
  let persistenceError;
  await mutateGoals(freshGoals => {
    const freshGoal = freshGoals.goals.find(g => g.id === goalId);
    if (freshGoal) {
      goalFound = true;
      freshGoal.scheduledEvents = (freshGoal.scheduledEvents || []).filter(evt => !removedIds.has(eventKey(evt)));
      freshGoal.updatedAt = new Date().toISOString();
    }
    freshGoals.updatedAt = new Date().toISOString();
    return freshGoals;
  }).catch(error => { persistenceError = error; });
  if (survivors.length || persistenceError) {
    const recovery = persistenceError
      ? `Could not save the cleanup result: ${persistenceError.message}.`
      : goalFound
        ? 'Remaining time blocks were retained for later removal.'
        : 'The goal was deleted during cleanup; remaining time blocks could not be retained.';
    const manualCleanup = survivors.length && (!goalFound || persistenceError)
      ? ' Remove the remaining time blocks in Google Calendar using the event IDs in the error details.'
      : '';
    const outcome = survivors.length
      ? `${survivors.length} calendar events could not be removed.`
      : `All ${events.length} calendar events were removed.`;
    const error = new ServerError(`${outcome} ${recovery}${manualCleanup}`, {
      code: survivors.length ? 'CALENDAR_CLEANUP_FAILED' : 'CALENDAR_SAVE_FAILED',
      context: { remainingEvents: survivors, ...(persistenceError && { persistenceError: persistenceError.message }) }
    });
    if (persistenceError) error.cause = persistenceError;
    throw error;
  }

  console.log(`📅 Removed ${events.length} scheduled events for goal "${goal.title}"`);
  return { deleted: events.length };
}

export async function rescheduleTimeBlocks(goalId) {
  await removeScheduledEvents(goalId);
  return scheduleTimeBlocks(goalId);
}
