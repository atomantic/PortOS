/**
 * POST Training Log Service
 *
 * Tracks practice sessions separate from scored POST history.
 * Training mode: progressive difficulty, hints, immediate feedback.
 */

import { randomUUID } from 'crypto';
import { getUserTimezone, todayInTimezone, userLocalToday } from '../lib/timezone.js';
import { normalizeYmd, ymdShift } from '../lib/postStreak.js';
import { getUnifiedActivityStreak } from './postActivityStreak.js';
import { loadTrainingLog, saveTrainingLog, getAllTrainingEntries } from './postTrainingLogStore.js';

export { getAllTrainingEntries };

/**
 * Submit a training practice entry after a training-mode drill completes.
 */
export async function submitTrainingEntry(entry) {
  const data = await loadTrainingLog();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  // Stamp the entry's day in the user's local timezone (issue #2681). Training
  // entries feed the SHARED unified streak (getUnifiedActivityStreak in
  // postActivityStreak.js), which now compares against the user's local
  // `today` — a bare UTC-day stamp here would
  // date a local-evening practice on tomorrow's UTC day and drop it from today's
  // streak. Derive the day from the SAME `nowDate` used for `timestamp` so a
  // midnight boundary can't split them onto different days.
  const todayLocal = await userLocalToday(nowDate);

  const record = {
    id: randomUUID(),
    date: todayLocal,
    timestamp: now,
    module: entry.module,
    drillType: entry.drillType,
    questionCount: entry.questionCount ?? 0,
    correctCount: entry.correctCount ?? 0,
    totalMs: entry.totalMs ?? 0,
  };
  // Per-question breakdown (issue #2114) is optional — only wordplay training
  // currently supplies it. Gate on Array.isArray (not truthiness/length) so an
  // absent field stays absent rather than being coerced to `[]`, keeping
  // legacy/no-breakdown entries indistinguishable from before this change.
  if (Array.isArray(entry.questions)) {
    record.questions = entry.questions;
  }

  data.entries.push(record);
  await saveTrainingLog(data);
  console.log(`🏋️ Training logged: ${record.module}/${record.drillType} ${record.correctCount}/${record.questionCount}`);
  return record;
}

/**
 * Get training stats: per-drill practice counts, streaks, recent activity.
 *
 * The streak comes from the SHARED unified streak (`getUnifiedActivityStreak` in
 * postActivityStreak.js) — the exact same number the launcher, dashboard widgets,
 * and Progress page show — so the Morse trainer can no longer disagree with them
 * (issue #2091). It counts BOTH scored sessions and training-log entries over
 * ALL history; only the per-drill breakdown below is windowed.
 */
export async function getTrainingStats(days = 30) {
  const atDate = new Date();
  const data = await loadTrainingLog();
  const allEntries = data.entries;
  const timezone = await getUserTimezone();
  const todayStr = todayInTimezone(timezone, atDate);

  let entries = allEntries;
  if (days > 0) {
    // Window off the user's local today (DST-safe day math) so the cutoff matches
    // the local-day strings the training/practice writers now stamp (issue #2681);
    // a UTC-day cutoff would clip the oldest local day or admit an extra one.
    const cutoffStr = ymdShift(todayStr, -days);
    entries = allEntries.filter(e => {
      const date = normalizeYmd(e?.date, timezone);
      return date && date >= cutoffStr;
    });
  }

  // Group by drill type (windowed)
  const byDrill = {};
  for (const e of entries) {
    const key = `${e.module}:${e.drillType}`;
    if (!byDrill[key]) byDrill[key] = { practiceCount: 0, totalCorrect: 0, totalQuestions: 0, totalMs: 0, dates: new Set() };
    byDrill[key].practiceCount++;
    byDrill[key].totalCorrect += e.correctCount || 0;
    byDrill[key].totalQuestions += e.questionCount || 0;
    byDrill[key].totalMs += e.totalMs || 0;
    const date = normalizeYmd(e?.date, timezone);
    if (date) byDrill[key].dates.add(date);
  }

  // ONE unified streak across sessions + training (shared helper, ALL history).
  // Pass allEntries (already loaded above) rather than re-fetching via
  // getAllTrainingEntries() — postActivityStreak.js takes training as a
  // parameter specifically so it doesn't need to import this module.
  const { current: currentStreak, longest: longestStreak } = await getUnifiedActivityStreak(allEntries, todayStr, timezone);
  const activeDays = new Set(entries.map(e => normalizeYmd(e?.date, timezone)).filter(Boolean)).size;

  // Summarize
  const summary = {};
  for (const [key, stats] of Object.entries(byDrill)) {
    summary[key] = {
      practiceCount: stats.practiceCount,
      accuracy: stats.totalQuestions > 0 ? Math.round((stats.totalCorrect / stats.totalQuestions) * 100) : 0,
      totalMs: stats.totalMs,
      daysActive: stats.dates.size,
    };
  }

  return {
    days,
    activeDays,
    totalEntries: entries.length,
    currentStreak,
    longestStreak,
    byDrill: summary,
  };
}

/**
 * Get recent training entries for display.
 */
export async function getTrainingEntries(limit = 20) {
  const data = await loadTrainingLog();
  if (!limit) return data.entries.slice().reverse();
  return data.entries.slice(-limit).reverse();
}
