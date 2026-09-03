/**
 * POST aggregate statistics.
 *
 * Reads raw sessions and the legacy-task helpers from the persistence service;
 * callers name THIS module for the derived aggregates rather than reaching for
 * a re-export off the persistence service (issue #5690).
 */
import {
  getPostSessions,
  deriveTaskAccuracy,
  deriveTaskCompletion,
  summarizeSkillEvidence,
} from './meatspacePost.js';
import { getAllTrainingEntries } from './postTrainingLogStore.js';
import { computePostStreaks, computeUnifiedStreak, recordDayKey, ymdShift } from '../lib/postStreak.js';
import { todayInTimezone } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';

export async function getPostStats(days = 30) {
  const atDate = new Date();
  const sessions = await getPostSessions();
  const timezone = await getUserTimezone();
  const todayStr = todayInTimezone(timezone, atDate);
  const sessionStreaks = computePostStreaks(sessions, todayStr, timezone);
  const training = await getAllTrainingEntries();
  const unified = computeUnifiedStreak(sessions, training, todayStr, timezone);
  const streaks = {
    ...sessionStreaks,
    currentStreak: unified.current,
    longestStreak: unified.longest,
    lastDate: unified.lastActiveDate,
  };
  let recent = sessions;
  let recentTraining = training;
  if (days > 0) {
    const cutoffStr = ymdShift(todayStr, -days);
    recent = sessions.filter((session) => {
      const date = recordDayKey(session, timezone);
      return date && date >= cutoffStr;
    });
    recentTraining = training.filter((entry) => {
      const date = recordDayKey(entry, timezone);
      return date && date >= cutoffStr;
    });
  }

  const evidence = summarizeSkillEvidence(recent, recentTraining);
  if (recent.length === 0) {
    return { days, sessionCount: 0, overall: null, byModule: {}, byDrill: {}, byDrillCount: {}, byDrillAccuracy: {}, byDrillCompletion: {}, ...evidence, ...streaks };
  }

  const scores = recent.map((session) => session.score);
  const overall = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const byModule = {};
  const byDrill = {};
  const byDrillAccuracyList = {};
  const byDrillCompletionList = {};
  for (const session of recent) {
    for (const task of session.tasks) {
      if (!byModule[task.module]) byModule[task.module] = [];
      byModule[task.module].push(task.score);
      const key = `${task.module}:${task.type}`;
      if (!byDrill[key]) byDrill[key] = [];
      byDrill[key].push(task.score);
      const accuracy = deriveTaskAccuracy(task);
      if (accuracy != null) (byDrillAccuracyList[key] ||= []).push(accuracy);
      const completion = deriveTaskCompletion(task);
      if (completion != null) (byDrillCompletionList[key] ||= []).push(completion);
    }
  }

  const avg = (values) => Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const avgFrac = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  for (const key of Object.keys(byModule)) byModule[key] = avg(byModule[key]);
  const byDrillCount = {};
  for (const key of Object.keys(byDrill)) byDrillCount[key] = byDrill[key].length;
  for (const key of Object.keys(byDrill)) byDrill[key] = avg(byDrill[key]);
  const byDrillAccuracy = {};
  for (const key of Object.keys(byDrillAccuracyList)) byDrillAccuracy[key] = avgFrac(byDrillAccuracyList[key]);
  const byDrillCompletion = {};
  for (const key of Object.keys(byDrillCompletionList)) byDrillCompletion[key] = avgFrac(byDrillCompletionList[key]);

  return { days, sessionCount: recent.length, overall, byModule, byDrill, byDrillCount, byDrillAccuracy, byDrillCompletion, ...evidence, ...streaks };
}
