/**
 * POST Training Log Service
 *
 * Tracks practice sessions separate from scored POST history.
 * Training mode: progressive difficulty, hints, immediate feedback.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWrite, PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { getUnifiedActivityStreak } from './meatspacePost.js';

const MEATSPACE_DIR = PATHS.meatspace;
const TRAINING_LOG_FILE = join(MEATSPACE_DIR, 'post-training-log.json');

async function loadTrainingLog() {
  const data = await readJSONFile(TRAINING_LOG_FILE, { entries: [] }, { allowArray: false });
  if (!Array.isArray(data.entries)) data.entries = [];
  return data;
}

async function saveTrainingLog(data) {
  await ensureDir(MEATSPACE_DIR);
  await atomicWrite(TRAINING_LOG_FILE, data);
}

/**
 * Submit a training practice entry after a training-mode drill completes.
 */
export async function submitTrainingEntry(entry) {
  const data = await loadTrainingLog();
  const now = new Date().toISOString();

  const record = {
    id: randomUUID(),
    date: now.split('T')[0],
    timestamp: now,
    module: entry.module,
    drillType: entry.drillType,
    questionCount: entry.questionCount ?? 0,
    correctCount: entry.correctCount ?? 0,
    totalMs: entry.totalMs ?? 0,
  };

  data.entries.push(record);
  await saveTrainingLog(data);
  console.log(`🏋️ Training logged: ${record.module}/${record.drillType} ${record.correctCount}/${record.questionCount}`);
  return record;
}

/**
 * Get training stats: per-drill practice counts, streaks, recent activity.
 *
 * The streak comes from the SHARED unified streak (`getUnifiedActivityStreak` in
 * meatspacePost.js) — the exact same number the launcher, dashboard widgets, and
 * Progress page show — so the Morse trainer can no longer disagree with them
 * (issue #2091). It counts BOTH scored sessions and training-log entries over
 * ALL history; only the per-drill breakdown below is windowed.
 */
export async function getTrainingStats(days = 30) {
  const data = await loadTrainingLog();
  const allEntries = data.entries;

  let entries = allEntries;
  if (days > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    entries = allEntries.filter(e => String(e.date || '').split('T')[0] >= cutoffStr);
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
    byDrill[key].dates.add(String(e.date || '').split('T')[0]);
  }

  // ONE unified streak across sessions + training (shared helper, ALL history).
  const { current: currentStreak, longest: longestStreak } = await getUnifiedActivityStreak();
  const activeDays = new Set(entries.map(e => String(e.date || '').split('T')[0])).size;

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

/**
 * All training-log entries in chronological (append) order — the raw feed the
 * unified progress aggregation reads (both meatspacePostTraining and
 * meatspacePostMemory practice write to the same `post-training-log.json`).
 */
export async function getAllTrainingEntries() {
  const data = await loadTrainingLog();
  return data.entries;
}
