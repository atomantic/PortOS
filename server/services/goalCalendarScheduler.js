import { google } from 'googleapis';
import { writeFile } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { join } from 'path';
import { PATHS, readJSONFile, ensureDir } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { getAuthenticatedClient, needsScopeUpgrade, getTokens } from './googleAuth.js';

const GOALS_FILE = join(PATHS.digitalTwin, 'goals.json');

const TIME_SLOT_HOURS = {
  morning: 9,
  afternoon: 13,
  evening: 18
};

const DAY_MAP = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

function resolveTimeSlotHour(timeSlot) {
  if (TIME_SLOT_HOURS[timeSlot] !== undefined) return TIME_SLOT_HOURS[timeSlot];
  return parseInt(timeSlot.split(':')[0], 10);
}

function resolveTimeSlotMinute(timeSlot) {
  if (TIME_SLOT_HOURS[timeSlot] !== undefined) return 0;
  return parseInt(timeSlot.split(':')[1], 10) || 0;
}

async function loadGoals() {
  return readJSONFile(GOALS_FILE, { goals: [] });
}

async function saveGoals(data) {
  await ensureDir(PATHS.digitalTwin);
  await writeFile(GOALS_FILE, JSON.stringify(data, null, 2));
}

export async function scheduleTimeBlocks(goalId) {
  const tokens = await getTokens();
  if (needsScopeUpgrade(tokens)) {
    throw new ServerError('Calendar write access required. Please re-authorize Google Calendar.', { status: 403, code: 'SCOPE_UPGRADE_NEEDED' });
  }

  const auth = await getAuthenticatedClient();
  if (!auth) throw new ServerError('Google OAuth not configured', { status: 401, code: 'NO_AUTH' });

  const goals = await loadGoals();
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  if (!goal.timeBlockConfig) throw new ServerError('Time block config not set', { status: 400, code: 'NO_CONFIG' });
  if (!goal.targetDate) throw new ServerError('Target date not set', { status: 400, code: 'NO_TARGET_DATE' });

  const milestones = [...(goal.milestones || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!milestones.length) throw new ServerError('No milestones/phases to schedule', { status: 400, code: 'NO_MILESTONES' });

  const calendar = google.calendar({ version: 'v3', auth });
  const { preferredDays, timeSlot, sessionDurationMinutes, subcalendarId } = goal.timeBlockConfig;
  const calendarId = subcalendarId || 'primary';
  const preferredDayNums = new Set(preferredDays.map(d => DAY_MAP[d]));
  const hour = resolveTimeSlotHour(timeSlot);
  const minute = resolveTimeSlotMinute(timeSlot);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Collect all events to create
  const eventDefs = [];
  for (let i = 0; i < milestones.length; i++) {
    const ms = milestones[i];
    if (ms.completedAt) continue;

    const rangeStart = i === 0 ? today : new Date(milestones[i - 1].targetDate + 'T00:00:00');
    const rangeEnd = ms.targetDate ? new Date(ms.targetDate + 'T00:00:00') : new Date(goal.targetDate + 'T00:00:00');

    const cursor = new Date(Math.max(rangeStart.getTime(), today.getTime()));
    while (cursor <= rangeEnd) {
      if (preferredDayNums.has(cursor.getDay())) {
        const startTime = new Date(cursor);
        startTime.setHours(hour, minute, 0, 0);
        const endTime = new Date(startTime);
        endTime.setMinutes(endTime.getMinutes() + sessionDurationMinutes);

        eventDefs.push({
          milestoneId: ms.id,
          date: cursor.toISOString().slice(0, 10),
          requestBody: {
            summary: `${goal.title} - ${ms.title}`,
            description: `${ms.description || ''}\n\nGoal: ${goal.title}`.trim(),
            start: { dateTime: startTime.toISOString(), timeZone: tz },
            end: { dateTime: endTime.toISOString(), timeZone: tz }
          }
        });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // Create events in parallel batches of 10 to avoid rate limiting
  const BATCH_SIZE = 10;
  const scheduledEvents = [];
  for (let i = 0; i < eventDefs.length; i += BATCH_SIZE) {
    const batch = eventDefs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(def =>
      calendar.events.insert({ calendarId, requestBody: def.requestBody })
    ));
    for (let j = 0; j < results.length; j++) {
      scheduledEvents.push({
        id: `sched-${uuidv4()}`,
        googleEventId: results[j].data.id,
        calendarId,
        milestoneId: batch[j].milestoneId,
        date: batch[j].date,
        createdAt: new Date().toISOString()
      });
    }
  }

  goal.scheduledEvents = scheduledEvents;
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveGoals(goals);

  console.log(`📅 Scheduled ${scheduledEvents.length} time blocks for goal "${goal.title}"`);
  return { count: scheduledEvents.length, events: scheduledEvents };
}

export async function removeScheduledEvents(goalId) {
  const auth = await getAuthenticatedClient();
  if (!auth) throw new ServerError('Google OAuth not configured', { status: 401, code: 'NO_AUTH' });

  const goals = await loadGoals();
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });

  const calendar = google.calendar({ version: 'v3', auth });
  const events = goal.scheduledEvents || [];

  // Delete events in parallel
  await Promise.all(events.map(evt =>
    calendar.events.delete({
      calendarId: evt.calendarId || 'primary',
      eventId: evt.googleEventId
    }).catch(err => {
      if (err.code !== 410 && err.code !== 404) console.log(`📅 Failed to delete event ${evt.googleEventId}: ${err.message}`);
    })
  ));

  goal.scheduledEvents = [];
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveGoals(goals);

  console.log(`📅 Removed ${events.length} scheduled events for goal "${goal.title}"`);
  return { deleted: events.length };
}

export async function rescheduleTimeBlocks(goalId) {
  await removeScheduledEvents(goalId);
  return scheduleTimeBlocks(goalId);
}
