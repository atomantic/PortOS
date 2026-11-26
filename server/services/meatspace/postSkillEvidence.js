/** Derives a common skill evidence shape from scored POST sessions and training attempts. */

import { nBackBalancedAccuracy } from '../../lib/postScoring.js';
import { expandMemoryQuestionResults } from './meatspacePostMemory.js';

/**
 * Answered-only accuracy for a scored task, tolerant of legacy sessions that
 * predate the persisted `accuracy` field (issue #2094). Order: the stored value
 * first, else derive from `questions[]` (correct over ANSWERED, not total), else
 * `null` — never NaN. Used by stats aggregation and the adaptive signal so old
 * and new session shapes both read cleanly.
 */
export function deriveTaskAccuracy(task) {
  if (typeof task?.accuracy === 'number' && !Number.isNaN(task.accuracy)) return task.accuracy;
  const qs = Array.isArray(task?.questions) ? task.questions : [];
  if (!qs.length) return null;
  // n-back is go/no-go: a withheld press is a deliberate "no-match" decision,
  // and its legacy `correct` flags encode the OLD raw-position model — so the
  // fallback recomputes balanced SDT accuracy rather than averaging them
  // (otherwise a legacy never-press run still reads ~70%). Mirrors the client
  // fallbacks in PostHistory/PostSessionResults.
  if (task?.type === 'n-back') return nBackBalancedAccuracy(qs);
  if (task?.type === 'memory-fill-blank') {
    const attempts = expandMemoryQuestionResults(qs);
    return attempts.length ? attempts.filter(q => q?.correct).length / attempts.length : null;
  }
  const answered = qs.filter(q => q?.answered != null);
  if (!answered.length) return null;
  return answered.filter(q => q?.correct).length / answered.length;
}

/**
 * Completion (answered / total) for a scored task, with the same legacy fallback
 * as deriveTaskAccuracy. `null` when there are no questions to derive from.
 * n-back legacy tasks are always fully reached — every trial gets a decision.
 */
export function deriveTaskCompletion(task) {
  if (typeof task?.completion === 'number' && !Number.isNaN(task.completion)) return task.completion;
  const qs = Array.isArray(task?.questions) ? task.questions : [];
  if (!qs.length) return null;
  if (task?.type === 'n-back') return 1;
  if (task?.type === 'memory-fill-blank') {
    const attempts = expandMemoryQuestionResults(qs);
    if (!attempts.length) return null;
    return attempts.filter(q => q?.answered != null).length / attempts.length;
  }
  return qs.filter(q => q?.answered != null).length / qs.length;
}

/**
 * Mean response time (ms) for a scored task, tolerant of legacy sessions that
 * predate the persisted `avgResponseMs` field (issue #2094): the stored value
 * first, else the mean of the answered questions' `responseMs` (>0 only), else
 * `null` — never NaN. Used by progress aggregation so the "getting faster"
 * trend reads cleanly across old and new session shapes.
 */
export function deriveTaskAvgResponseMs(task) {
  if (typeof task?.avgResponseMs === 'number' && !Number.isNaN(task.avgResponseMs)) return task.avgResponseMs;
  const qs = Array.isArray(task?.questions) ? task.questions : [];
  const timed = qs.filter(q => (q?.responseMs || 0) > 0);
  if (!timed.length) return null;
  return Math.round(timed.reduce((sum, q) => sum + q.responseMs, 0) / timed.length);
}

// Normalizes a legacy training-log entry into the scored-task shape the
// session pipeline uses. Stays private: its only cross-module consumer reaches
// it through summarizeSkillEvidence below.
export function trainingEntryTask(entry) {
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

export function skillEvidenceSessions(sessions, training) {
  return [
    ...sessions,
    ...training.map((entry) => ({
      id: entry.runId || entry.id,
      date: entry.date,
      startedAt: entry.timestamp,
      completedAt: entry.timestamp,
      evidenceMode: 'training',
      tasks: [trainingEntryTask(entry)],
    })),
  ];
}

// Rolls sessions + training entries into per-drill count/accuracy/completion
// means. Consumed by meatspacePostStats.js (getPostStats); declared here beside
// deriveTaskAccuracy/deriveTaskCompletion, which it is built on.
export function summarizeSkillEvidence(sessions, training) {
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
