/**
 * MeatSpace Logging Stats
 *
 * Aggregates the daily-dated health logs (alcohol, nicotine, workouts, body,
 * blood pressure) into a single glanceable summary for the dashboard streak
 * widget: a cross-domain logging streak, per-domain this-week counts, and a
 * 7-day sparkline. Pure read — composes the existing per-domain getters rather
 * than reaching into their storage files, so MortalLoom-backed installs are
 * covered for free.
 */

import { getDateString } from '../lib/fileUtils.js';
import { getDailyAlcohol } from './meatspaceAlcohol.js';
import { getDailyNicotine } from './meatspaceNicotine.js';
import { getWorkouts, getBodyHistory, getBloodPressureHistory } from './meatspaceHealth.js';

// Each domain contributes an array of `{ date: 'YYYY-MM-DD', ... }` records.
// `label` is the human-facing name shown per-domain in the widget.
const DOMAINS = [
  { key: 'alcohol', label: 'Alcohol', load: () => getDailyAlcohol() },
  { key: 'nicotine', label: 'Nicotine', load: () => getDailyNicotine() },
  { key: 'workouts', label: 'Workouts', load: () => getWorkouts() },
  { key: 'body', label: 'Body', load: () => getBodyHistory() },
  { key: 'bloodPressure', label: 'Blood Pressure', load: () => getBloodPressureHistory() },
];

// Consecutive days (ending today, or yesterday if today is empty) that have at
// least one log in any domain. Mirrors usage.js's calculateStreak so the two
// dashboard streaks read the same way.
function calculateStreak(loggedDates) {
  let streak = 0;
  const checkDate = new Date();
  // Normalize to midnight so day arithmetic is stable across DST.
  checkDate.setHours(0, 0, 0, 0);
  while (true) {
    const dateStr = getDateString(checkDate);
    if (loggedDates.has(dateStr)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else if (streak === 0) {
      // Grace: a gap today doesn't break a streak that ran through yesterday.
      checkDate.setDate(checkDate.getDate() - 1);
      if (!loggedDates.has(getDateString(checkDate))) break;
    } else {
      break;
    }
  }
  return streak;
}

// Longest run of consecutive logged days anywhere in history.
function calculateLongestStreak(loggedDates) {
  const dates = [...loggedDates].sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const dateStr of dates) {
    if (prev) {
      const diffDays = Math.round(
        (new Date(dateStr) - new Date(prev)) / (1000 * 60 * 60 * 24)
      );
      run = diffDays === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    longest = Math.max(longest, run);
    prev = dateStr;
  }
  return longest;
}

export async function getLoggingStats() {
  const perDomain = await Promise.all(
    DOMAINS.map(async (d) => ({ ...d, entries: (await d.load().catch(() => [])) || [] }))
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 6); // inclusive 7-day window (today + 6 prior)
  const weekAgoStr = getDateString(weekAgo);
  const todayStr = getDateString(today);

  // Union of every logged date across domains → drives the streak + sparkline.
  const loggedDates = new Set();
  const domains = [];
  let totalLogged = 0;

  for (const d of perDomain) {
    let thisWeek = 0;
    for (const entry of d.entries) {
      if (!entry?.date) continue;
      loggedDates.add(entry.date);
      totalLogged++;
      if (entry.date >= weekAgoStr && entry.date <= todayStr) thisWeek++;
    }
    domains.push({ key: d.key, label: d.label, total: d.entries.length, thisWeek });
  }

  // 7-day sparkline: count of distinct domains logged each day (0..DOMAINS.length).
  const perDayDomainCount = new Map();
  for (const d of perDomain) {
    const daysSeen = new Set();
    for (const entry of d.entries) {
      if (entry?.date && entry.date >= weekAgoStr && entry.date <= todayStr) daysSeen.add(entry.date);
    }
    for (const date of daysSeen) perDayDomainCount.set(date, (perDayDomainCount.get(date) || 0) + 1);
  }

  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = getDateString(date);
    last7Days.push({
      date: dateStr,
      label: date.toLocaleDateString('en-US', { weekday: 'short' }),
      domains: perDayDomainCount.get(dateStr) || 0,
      logged: loggedDates.has(dateStr),
    });
  }

  return {
    currentStreak: calculateStreak(loggedDates),
    longestStreak: calculateLongestStreak(loggedDates),
    weekTotal: domains.reduce((sum, d) => sum + d.thisWeek, 0),
    totalLogged,
    domains,
    last7Days,
  };
}
