/**
 * POST aggregate statistics.
 *
 * The persistence service keeps the public API stable by re-exporting this
 * module. Shared session and legacy-task helpers intentionally stay there.
 */
import { getPostSessions, deriveTaskAccuracy, deriveTaskCompletion } from './meatspacePost.js';
import { getAllTrainingEntries } from './postTrainingLogStore.js';
import { computePostStreaks, computeUnifiedStreak, recordDayKey, ymdShift } from '../lib/postStreak.js';
import { todayInTimezone } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';

function trainingEntryTask(entry) {
  const rawQuestionCount = Number(entry?.questionCount);
  const rawCorrectCount = Number(entry?.correctCount);
  const questionCount = Number.isFinite(rawQuestionCount) && rawQuestionCount > 0 ? rawQuestionCount : 0;
  const correctCount = Number.isFinite(rawCorrectCount)
    ? Math.max(0, Math.min(questionCount, rawCorrectCount))
    : 0;
  const accuracy = typeof entry?.accuracy === 'number'
    ? entry.accuracy
    : questionCount > 0 ? correctCount / questionCount : null;
  return {
    id: entry?.id,
    module: entry?.module,
    type: entry?.drillType,
    config: entry?.difficulty || {},
    questions: Array.isArray(entry?.questions) ? entry.questions : [],
    score: Number.isFinite(entry?.score) ? entry.score : (accuracy == null ? null : accuracy * 100),
    accuracy,
    completion: typeof entry?.completion === 'number' ? entry.completion : (questionCount > 0 ? 1 : null),
    avgResponseMs: typeof entry?.avgResponseMs === 'number'
      ? entry.avgResponseMs
      : questionCount > 0 ? (entry?.totalMs || 0) / questionCount : null,
    totalMs: entry?.totalMs || 0,
    totalCount: questionCount,
  };
}

function summarizeSkillEvidence(sessions, training) {
  const accuracyLists = {};
  const completionLists = {};
  const counts = {};
  const add = (task) => {
    if (!task?.module || !task?.type) return;
    const key = `${task.module}:${task.type}`;
    counts[key] = (counts[key] || 0) + 1;
    const accuracy = deriveTaskAccuracy(task);
    if (accuracy != null) (accuracyLists[key] ||= []).push(accuracy);
    const completion = deriveTaskCompletion(task);
    if (completion != null) (completionLists[key] ||= []).push(completion);
  };
  for (const session of sessions) for (const task of session.tasks || []) add(task);
  for (const entry of training) add(trainingEntryTask(entry));
  const meanMap = (lists) => Object.fromEntries(
    Object.entries(lists).map(([key, values]) => [key, values.reduce((sum, value) => sum + value, 0) / values.length]),
  );
  return {
    evidenceByDrillCount: counts,
    evidenceByDrillAccuracy: meanMap(accuracyLists),
    evidenceByDrillCompletion: meanMap(completionLists),
  };
}

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
