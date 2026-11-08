/**
 * MeatSpace Life Calendar Service
 *
 * "4000 Weeks" mortality-aware time mapping.
 * Computes life grids, remaining time budgets, and activity estimates
 * based on birth date and life expectancy.
 */

import { invalidateMeatspace } from './meatspaceEvents.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWrite, PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ServerError } from '../lib/errorHandler.js';
import { getDeathClock } from './meatspace.js';

const MEATSPACE_DIR = PATHS.meatspace;
const ACTIVITIES_FILE = join(MEATSPACE_DIR, 'activities.json');
const EVENTS_FILE = join(MEATSPACE_DIR, 'life-events.json');

// One tail per file: every load -> mutate -> save below runs through these, so a
// second click or a concurrent add cannot read the pre-image the first write
// is about to replace.
const queueActivitiesWrite = createFileWriteQueue();
const queueEventsWrite = createFileWriteQueue();

const MS_PER_DAY = 86400000;
const MS_PER_WEEK = MS_PER_DAY * 7;

// === Built-in time remaining stats ===

/**
 * Compute remaining counts of various time units and life events
 */
export function computeTimeStats(birthDate, deathDate, sleepHoursPerNight = 7.5) {
  const now = new Date();
  const death = new Date(deathDate);
  const birth = new Date(birthDate);

  if (death <= now) {
    return { expired: true };
  }

  const msRemaining = death.getTime() - now.getTime();
  const daysRemaining = msRemaining / MS_PER_DAY;
  const weeksRemaining = msRemaining / MS_PER_WEEK;
  const yearsRemaining = daysRemaining / 365.25;

  // Count specific day-of-week remaining
  const countDayOfWeek = (targetDay) => {
    let count = 0;
    const cursor = new Date(now);
    // Advance to next target day
    while (cursor.getDay() !== targetDay) {
      cursor.setDate(cursor.getDate() + 1);
    }
    while (cursor <= death) {
      count++;
      cursor.setDate(cursor.getDate() + 7);
    }
    return count;
  };

  // Count seasons remaining (approximate by quarter)
  const seasonsRemaining = Math.floor(yearsRemaining * 4);

  // Count holidays remaining (approximate)
  const holidaysPerYear = 11; // Major US holidays

  // Sleep: remaining hours
  const sleepHoursRemaining = Math.round(daysRemaining * sleepHoursPerNight);
  const awakeDaysRemaining = Math.round(daysRemaining * (1 - sleepHoursPerNight / 24));

  // Count how many of each month remain
  const monthsRemaining = Math.round(yearsRemaining * 12);

  // Years lived and total
  const ageMs = now.getTime() - birth.getTime();
  const ageDays = ageMs / MS_PER_DAY;
  const ageWeeks = Math.floor(ageDays / 7);
  const totalWeeks = Math.floor((death.getTime() - birth.getTime()) / MS_PER_WEEK);

  return {
    expired: false,
    age: {
      years: Math.round((ageDays / 365.25) * 100) / 100,
      weeks: ageWeeks,
      days: Math.floor(ageDays),
    },
    remaining: {
      years: Math.round(yearsRemaining * 100) / 100,
      months: monthsRemaining,
      weeks: Math.floor(weeksRemaining),
      days: Math.floor(daysRemaining),
      saturdays: countDayOfWeek(6),
      sundays: countDayOfWeek(0),
      fridays: countDayOfWeek(5),
      weekends: countDayOfWeek(6), // Same as saturdays (each weekend = 1 saturday)
      seasons: seasonsRemaining,
      holidays: Math.round(yearsRemaining * holidaysPerYear),
      sleepHours: sleepHoursRemaining,
      awakeDays: awakeDaysRemaining,
    },
    total: {
      weeks: totalWeeks,
    },
  };
}

// === Life Grid (weeks from birth to death) ===

/**
 * Compute a compact life grid representation.
 * Returns year rows, each with 52 week cells.
 * Each cell: 'spent' | 'current' | 'remaining'
 */
export function computeLifeGrid(birthDate, deathDate) {
  const birth = new Date(birthDate);
  const death = new Date(deathDate);
  const now = new Date();

  const totalYears = Math.ceil((death.getTime() - birth.getTime()) / (365.25 * MS_PER_DAY));
  const rows = [];

  for (let y = 0; y < totalYears; y++) {
    const yearStart = new Date(birth);
    yearStart.setFullYear(birth.getFullYear() + y);
    const yearAge = y;

    const weeks = [];
    for (let w = 0; w < 52; w++) {
      const weekStart = new Date(yearStart.getTime() + w * MS_PER_WEEK);
      const weekEnd = new Date(weekStart.getTime() + MS_PER_WEEK);

      let status;
      if (weekEnd <= now) {
        status = 's'; // spent
      } else if (weekStart <= now && now < weekEnd) {
        status = 'c'; // current
      } else if (weekStart > death) {
        status = null; // beyond death date
      } else {
        status = 'r'; // remaining
      }

      if (status) weeks.push(status);
    }

    rows.push({ age: yearAge, weeks });
  }

  return rows;
}

// === Activity Budgets ===

/**
 * Compute remaining count for each activity based on cadence and time remaining
 */
export function computeActivityBudgets(deathDate, activities) {
  const now = new Date();
  const death = new Date(deathDate);

  if (death <= now) return [];

  const daysRemaining = (death.getTime() - now.getTime()) / MS_PER_DAY;

  return activities.map(activity => {
    const { id, name, cadence, frequency, icon } = activity;

    let remaining;
    switch (cadence) {
      case 'day':
        remaining = Math.floor(daysRemaining * frequency);
        break;
      case 'week':
        remaining = Math.floor((daysRemaining / 7) * frequency);
        break;
      case 'month':
        remaining = Math.floor((daysRemaining / 30.44) * frequency);
        break;
      case 'year':
        remaining = Math.floor((daysRemaining / 365.25) * frequency);
        break;
      default:
        remaining = 0;
    }

    return { id, name, cadence, frequency, icon, remaining };
  });
}

// === File I/O ===

async function loadActivities() {
  return readJSONFile(ACTIVITIES_FILE, { activities: null }, { strict: true });
}

async function saveActivities(data) {
  await ensureDir(MEATSPACE_DIR);
  await atomicWrite(ACTIVITIES_FILE, data);
  invalidateMeatspace(['calendar']);
}

// === Default Activities ===

// Fixed ids: the defaults are served unpersisted until the first write seeds them,
// so the id a client read must survive that seeding. Added rows get a UUID.
const DEFAULT_ACTIVITIES = [
  { id: 'default-coffees', name: 'Coffees', cadence: 'day', frequency: 2, icon: 'coffee' },
  { id: 'default-showers', name: 'Showers', cadence: 'day', frequency: 1, icon: 'droplets' },
  { id: 'default-meals', name: 'Meals', cadence: 'day', frequency: 3, icon: 'utensils' },
  { id: 'default-workouts', name: 'Workouts', cadence: 'week', frequency: 4, icon: 'dumbbell' },
  { id: 'default-books', name: 'Books', cadence: 'month', frequency: 1, icon: 'book-open' },
  { id: 'default-haircuts', name: 'Haircuts', cadence: 'month', frequency: 1, icon: 'scissors' },
  { id: 'default-birthdays', name: 'Birthdays', cadence: 'year', frequency: 1, icon: 'cake' },
  { id: 'default-vacations', name: 'Vacations', cadence: 'year', frequency: 2, icon: 'plane' },
];

// === Life Events ===

const DEFAULT_EVENTS = [
  { id: 'new-year', name: "New Year's Day", type: 'holiday', recurrence: 'yearly', month: 0, day: 1, enabled: true },
  { id: 'valentines', name: "Valentine's Day", type: 'holiday', recurrence: 'yearly', month: 1, day: 14, enabled: true },
  { id: 'independence', name: 'Independence Day', type: 'holiday', recurrence: 'yearly', month: 6, day: 4, enabled: true },
  { id: 'halloween', name: 'Halloween', type: 'holiday', recurrence: 'yearly', month: 9, day: 31, enabled: true },
  { id: 'thanksgiving', name: 'Thanksgiving', type: 'holiday', recurrence: 'yearly', month: 10, day: 28, enabled: true },
  { id: 'christmas', name: 'Christmas', type: 'holiday', recurrence: 'yearly', month: 11, day: 25, enabled: true },
];

async function loadEvents() {
  return readJSONFile(EVENTS_FILE, { events: null }, { strict: true });
}

async function saveEvents(data) {
  await ensureDir(MEATSPACE_DIR);
  await atomicWrite(EVENTS_FILE, data);
  invalidateMeatspace(['calendar']);
}

export async function getLifeEvents() {
  const data = await loadEvents();
  return Array.isArray(data.events) ? data.events : DEFAULT_EVENTS;
}

export function addLifeEvent(event) {
  return queueEventsWrite(async () => {
    const data = await loadEvents();
    if (!Array.isArray(data.events)) {
      data.events = [...DEFAULT_EVENTS];
    }
    const newEvent = { id: randomUUID(), ...event };
    data.events.push(newEvent);
    await saveEvents(data);
    console.log(`📅 Life event added: "${newEvent.name}"`);
    return data.events;
  });
}

export function updateLifeEvent(id, updates) {
  return queueEventsWrite(async () => {
    const data = await loadEvents();
    if (!Array.isArray(data.events)) {
      data.events = [...DEFAULT_EVENTS];
    }
    const idx = data.events.findIndex(e => e.id === id);
    if (idx === -1) return null;
    data.events[idx] = { ...data.events[idx], ...updates };
    await saveEvents(data);
    console.log(`📅 Life event updated: "${data.events[idx].name}"`);
    return data.events;
  });
}

export function removeLifeEvent(id) {
  return queueEventsWrite(async () => {
    const data = await loadEvents();
    if (!Array.isArray(data.events)) {
      data.events = [...DEFAULT_EVENTS];
    }
    const idx = data.events.findIndex(e => e.id === id);
    if (idx === -1) return null;
    const removed = data.events.splice(idx, 1)[0];
    await saveEvents(data);
    console.log(`📅 Life event removed: "${removed.name}"`);
    return data.events;
  });
}

// === Exported Service Functions ===

export async function getCalendarData() {
  const deathClock = await getDeathClock();
  if (deathClock.error) {
    return { error: deathClock.error };
  }

  const { birthDate, deathDate, lifeExpectancy } = deathClock;
  const sleepHours = lifeExpectancy?.lifestyleAdjustment != null ? 7.5 : 7.5; // Could read from config

  const stats = computeTimeStats(birthDate, deathDate, sleepHours);
  const grid = computeLifeGrid(birthDate, deathDate);

  // Load activities
  const data = await loadActivities();
  const activities = Array.isArray(data.activities) ? data.activities : DEFAULT_ACTIVITIES;
  const budgets = computeActivityBudgets(deathDate, activities);

  // Load life events
  const events = await getLifeEvents();

  return {
    birthDate,
    deathDate,
    lifeExpectancy: lifeExpectancy?.total,
    stats,
    grid,
    budgets,
    events,
    activitiesConfigured: Array.isArray(data.activities),
  };
}

export async function getActivities() {
  const data = await loadActivities();
  return Array.isArray(data.activities) ? data.activities : DEFAULT_ACTIVITIES;
}

const hasActivityId = (activity) => typeof activity?.id === 'string' && activity.id !== '';

// The list a write mutates: defaults seeded on first write, and any row still
// without an id (restored from a pre-migration backup, or hand-edited) given one
// so it is addressable from the next read on.
async function loadActivitiesForWrite() {
  const data = await loadActivities();
  const activities = Array.isArray(data.activities) ? data.activities : DEFAULT_ACTIVITIES;
  data.activities = activities.map(a => (hasActivityId(a) ? a : { ...a, id: randomUUID() }));
  return data;
}

export function addActivity(activity) {
  return queueActivitiesWrite(async () => {
    const data = await loadActivitiesForWrite();
    data.activities.push({ ...activity, id: randomUUID() });
    await saveActivities(data);
    return data.activities;
  });
}

const activityMoved = () => new ServerError('Activity list changed; refresh and try again', { status: 409, code: 'ACTIVITY_MOVED' });

// Resolves the row a caller means. `id` names it exactly, wherever it now sits;
// an unknown id is a row already gone. Without an id, `name` (clients from before
// ids) only checks that the index still holds the row the caller saw. Neither
// keeps index-only addressing for older clients. Returns -1 for an index out of range.
function resolveActivityIndex(activities, index, { id, name } = {}) {
  if (id !== undefined) {
    const at = activities.findIndex(a => a.id === id);
    if (at === -1) throw activityMoved();
    return at;
  }
  if (name !== undefined && activities[index]?.name !== name) throw activityMoved();
  return index >= 0 && index < activities.length ? index : -1;
}

export function updateActivity(index, updates, expected) {
  return queueActivitiesWrite(async () => {
    const data = await loadActivitiesForWrite();
    const at = resolveActivityIndex(data.activities, index, expected);
    if (at === -1) return null;
    data.activities[at] = { ...data.activities[at], ...updates, id: data.activities[at].id };
    await saveActivities(data);
    return data.activities;
  });
}

export function removeActivity(index, expected) {
  return queueActivitiesWrite(async () => {
    const data = await loadActivitiesForWrite();
    const at = resolveActivityIndex(data.activities, index, expected);
    if (at === -1) return null;
    data.activities.splice(at, 1);
    await saveActivities(data);
    return data.activities;
  });
}
