/**
 * POST Training Log Service
 *
 * Tracks practice sessions separate from scored POST history.
 * Training mode: progressive difficulty, hints, immediate feedback.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';

const MEATSPACE_DIR = PATHS.meatspace;
const TRAINING_LOG_FILE = join(MEATSPACE_DIR, 'post-training-log.json');

async function loadTrainingLog() {
  const data = await readJSONFile(TRAINING_LOG_FILE, { entries: [] }, { allowArray: false });
  if (!Array.isArray(data.entries)) data.entries = [];
  return data;
}

async function saveTrainingLog(data) {
  await ensureDir(MEATSPACE_DIR);
  await writeFile(TRAINING_LOG_FILE, JSON.stringify(data, null, 2));
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
    questionCount: entry.questionCount || 0,
    correctCount: entry.correctCount || 0,
    totalMs: entry.totalMs || 0,
  };

  data.entries.push(record);
  await saveTrainingLog(data);
  console.log(`🏋️ Training logged: ${record.module}/${record.drillType} ${record.correctCount}/${record.questionCount}`);
  return record;
}

/**
 * Get training stats: per-drill practice counts, streaks, recent activity.
 */
export async function getTrainingStats(days = 30) {
  const data = await loadTrainingLog();
  let entries = data.entries;

  if (days > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    entries = entries.filter(e => e.date >= cutoffStr);
  }

  // Group by drill type
  const byDrill = {};
  for (const e of entries) {
    const key = `${e.module}:${e.drillType}`;
    if (!byDrill[key]) byDrill[key] = { practiceCount: 0, totalCorrect: 0, totalQuestions: 0, totalMs: 0, dates: new Set() };
    byDrill[key].practiceCount++;
    byDrill[key].totalCorrect += e.correctCount;
    byDrill[key].totalQuestions += e.questionCount;
    byDrill[key].totalMs += e.totalMs;
    byDrill[key].dates.add(e.date);
  }

  // Compute streaks (consecutive days of practice)
  const dateSet = new Set(entries.map(e => e.date));
  let currentStreak = 0;
  if (dateSet.size > 0) {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    // Count backwards from today/yesterday
    let checkDate = dateSet.has(today) ? today : dateSet.has(yesterday) ? yesterday : null;
    if (checkDate) {
      currentStreak = 1;
      let ts = new Date(checkDate + 'T00:00:00Z').getTime();
      while (true) {
        ts -= 86400000;
        const prev = new Date(ts).toISOString().split('T')[0];
        if (dateSet.has(prev)) {
          currentStreak++;
        } else {
          break;
        }
      }
    }
  }
  const activeDays = dateSet.size;

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
