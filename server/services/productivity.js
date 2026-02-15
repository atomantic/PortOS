/**
 * Productivity & Streaks Service
 *
 * Tracks work patterns, productivity streaks, and generates
 * insights about optimal working times.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { cosEvents, getAgents } from './cos.js';
import { ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';

const DATA_DIR = PATHS.cos;
const PRODUCTIVITY_FILE = join(DATA_DIR, 'productivity.json');

/**
 * Default productivity data structure
 */
const DEFAULT_PRODUCTIVITY = {
  streaks: {
    currentDaily: 0,        // Consecutive days with completed tasks
    longestDaily: 0,        // Best daily streak ever
    currentWeekly: 0,       // Consecutive weeks with activity
    longestWeekly: 0,       // Best weekly streak ever
    lastActiveDate: null,   // Last day with completed tasks
    lastActiveWeek: null    // Last week with activity
  },
  hourlyPatterns: {
    // Aggregated by hour: { tasks, successes, failures, avgDuration }
  },
  dailyPatterns: {
    // Aggregated by day of week (0-6): { tasks, successes, failures, avgDuration }
  },
  dailyHistory: {
    // Indexed by YYYY-MM-DD: { tasks, successes, failures, successRate }
  },
  milestones: [
    // { type, value, achievedAt, description }
  ],
  lastUpdated: null
};

/**
 * Ensure data directory exists
 */
async function ensureDataDir() {
  await ensureDir(DATA_DIR);
}

/**
 * Load productivity data
 */
export async function loadProductivity() {
  await ensureDataDir();
  const data = await readJSONFile(PRODUCTIVITY_FILE, DEFAULT_PRODUCTIVITY);
  // Merge with defaults to ensure all fields exist
  return {
    ...DEFAULT_PRODUCTIVITY,
    ...data,
    streaks: { ...DEFAULT_PRODUCTIVITY.streaks, ...data.streaks }
  };
}

/**
 * Save productivity data
 */
async function saveProductivity(data) {
  await ensureDataDir();
  data.lastUpdated = new Date().toISOString();
  await writeFile(PRODUCTIVITY_FILE, JSON.stringify(data, null, 2));
  return data;
}

/**
 * Get date string (YYYY-MM-DD) for a Date object
 */
function getDateString(date = new Date()) {
  return date.toISOString().split('T')[0];
}

/**
 * Get week identifier (YYYY-WXX format)
 */
function getWeekId(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${date.getFullYear()}-W${week.toString().padStart(2, '0')}`;
}

/**
 * Check if two dates are consecutive days
 */
function isConsecutiveDay(date1, date2) {
  if (!date1 || !date2) return false;
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  const diffDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  return diffDays === 1;
}

/**
 * Check if two weeks are consecutive
 */
function isConsecutiveWeek(week1, week2) {
  if (!week1 || !week2) return false;
  // Parse YYYY-WXX format
  const [y1, w1] = week1.split('-W').map(Number);
  const [y2, w2] = week2.split('-W').map(Number);

  if (y1 === y2) return w2 - w1 === 1;
  if (y2 - y1 === 1 && w1 >= 52 && w2 === 1) return true;
  return false;
}

/**
 * Recalculate all productivity metrics from agent history
 */
export async function recalculateProductivity() {
  console.log('📊 Productivity: Recalculating from agent history');

  const agents = await getAgents();
  const completedAgents = agents.filter(a => a.completedAt && a.status === 'completed');

  // Sort by completion date
  completedAgents.sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));

  // Initialize patterns
  const hourlyPatterns = {};
  const dailyPatterns = {};
  const dailyHistory = {};

  // Track dates with activity for streak calculation
  const activeDates = new Set();
  const activeWeeks = new Set();

  for (const agent of completedAgents) {
    const completedAt = new Date(agent.completedAt);
    const dateStr = getDateString(completedAt);
    const weekId = getWeekId(completedAt);
    const hour = completedAt.getHours();
    const dayOfWeek = completedAt.getDay();
    const success = agent.result?.success === true;
    const duration = agent.result?.duration || 0;

    activeDates.add(dateStr);
    activeWeeks.add(weekId);

    // Hourly patterns
    if (!hourlyPatterns[hour]) {
      hourlyPatterns[hour] = { tasks: 0, successes: 0, failures: 0, totalDuration: 0 };
    }
    hourlyPatterns[hour].tasks++;
    if (success) hourlyPatterns[hour].successes++;
    else hourlyPatterns[hour].failures++;
    hourlyPatterns[hour].totalDuration += duration;

    // Daily patterns (by day of week)
    if (!dailyPatterns[dayOfWeek]) {
      dailyPatterns[dayOfWeek] = { tasks: 0, successes: 0, failures: 0, totalDuration: 0 };
    }
    dailyPatterns[dayOfWeek].tasks++;
    if (success) dailyPatterns[dayOfWeek].successes++;
    else dailyPatterns[dayOfWeek].failures++;
    dailyPatterns[dayOfWeek].totalDuration += duration;

    // Daily history (by date)
    if (!dailyHistory[dateStr]) {
      dailyHistory[dateStr] = { tasks: 0, successes: 0, failures: 0 };
    }
    dailyHistory[dateStr].tasks++;
    if (success) dailyHistory[dateStr].successes++;
    else dailyHistory[dateStr].failures++;
  }

  // Calculate success rates for daily history
  for (const date of Object.keys(dailyHistory)) {
    const h = dailyHistory[date];
    h.successRate = h.tasks > 0 ? Math.round((h.successes / h.tasks) * 100) : 0;
  }

  // Calculate average durations
  for (const hour of Object.keys(hourlyPatterns)) {
    const p = hourlyPatterns[hour];
    p.avgDuration = p.tasks > 0 ? Math.round(p.totalDuration / p.tasks) : 0;
    p.successRate = p.tasks > 0 ? Math.round((p.successes / p.tasks) * 100) : 0;
  }
  for (const day of Object.keys(dailyPatterns)) {
    const p = dailyPatterns[day];
    p.avgDuration = p.tasks > 0 ? Math.round(p.totalDuration / p.tasks) : 0;
    p.successRate = p.tasks > 0 ? Math.round((p.successes / p.tasks) * 100) : 0;
  }

  // Calculate streaks
  const sortedDates = Array.from(activeDates).sort();
  const sortedWeeks = Array.from(activeWeeks).sort();

  const today = getDateString();
  const thisWeek = getWeekId();

  // Daily streak calculation
  let currentDaily = 0;
  let longestDaily = 0;
  let tempStreak = 0;

  for (let i = 0; i < sortedDates.length; i++) {
    if (i === 0 || isConsecutiveDay(sortedDates[i - 1], sortedDates[i])) {
      tempStreak++;
    } else {
      longestDaily = Math.max(longestDaily, tempStreak);
      tempStreak = 1;
    }
  }
  longestDaily = Math.max(longestDaily, tempStreak);

  // Current streak: count backwards from today
  const lastDate = sortedDates[sortedDates.length - 1];
  if (lastDate === today || isConsecutiveDay(lastDate, today)) {
    // Still active or just yesterday
    currentDaily = 1;
    for (let i = sortedDates.length - 1; i >= 1; i--) {
      if (isConsecutiveDay(sortedDates[i - 1], sortedDates[i])) {
        currentDaily++;
      } else {
        break;
      }
    }
  }

  // Weekly streak calculation
  let currentWeekly = 0;
  let longestWeekly = 0;
  let tempWeekStreak = 0;

  for (let i = 0; i < sortedWeeks.length; i++) {
    if (i === 0 || isConsecutiveWeek(sortedWeeks[i - 1], sortedWeeks[i])) {
      tempWeekStreak++;
    } else {
      longestWeekly = Math.max(longestWeekly, tempWeekStreak);
      tempWeekStreak = 1;
    }
  }
  longestWeekly = Math.max(longestWeekly, tempWeekStreak);

  // Current weekly streak
  const lastWeek = sortedWeeks[sortedWeeks.length - 1];
  if (lastWeek === thisWeek || isConsecutiveWeek(lastWeek, thisWeek)) {
    currentWeekly = 1;
    for (let i = sortedWeeks.length - 1; i >= 1; i--) {
      if (isConsecutiveWeek(sortedWeeks[i - 1], sortedWeeks[i])) {
        currentWeekly++;
      } else {
        break;
      }
    }
  }

  // Check for new milestones
  const milestones = [];
  const totalTasks = completedAgents.length;
  const successfulTasks = completedAgents.filter(a => a.result?.success).length;

  const taskMilestones = [10, 25, 50, 100, 250, 500, 1000];
  for (const m of taskMilestones) {
    if (totalTasks >= m) {
      milestones.push({
        type: 'tasks',
        value: m,
        achievedAt: completedAgents[m - 1]?.completedAt,
        description: `Completed ${m} tasks`
      });
    }
  }

  const streakMilestones = [3, 7, 14, 30, 60, 100];
  for (const m of streakMilestones) {
    if (longestDaily >= m) {
      milestones.push({
        type: 'streak',
        value: m,
        description: `${m}-day work streak`
      });
    }
  }

  const productivity = {
    streaks: {
      currentDaily,
      longestDaily,
      currentWeekly,
      longestWeekly,
      lastActiveDate: sortedDates[sortedDates.length - 1] || null,
      lastActiveWeek: sortedWeeks[sortedWeeks.length - 1] || null
    },
    hourlyPatterns,
    dailyPatterns,
    dailyHistory,
    milestones,
    totals: {
      totalTasks,
      successfulTasks,
      successRate: totalTasks > 0 ? Math.round((successfulTasks / totalTasks) * 100) : 0,
      activeDays: sortedDates.length,
      activeWeeks: sortedWeeks.length
    }
  };

  return await saveProductivity(productivity);
}

/**
 * Get productivity insights
 */
export async function getProductivityInsights() {
  const data = await loadProductivity();

  // Find best hours (highest success rate with at least 5 tasks)
  const hourlyEntries = Object.entries(data.hourlyPatterns || {})
    .filter(([, p]) => p.tasks >= 5)
    .map(([hour, p]) => ({ hour: parseInt(hour), ...p }))
    .sort((a, b) => b.successRate - a.successRate);

  // Find best days
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dailyEntries = Object.entries(data.dailyPatterns || {})
    .filter(([, p]) => p.tasks >= 3)
    .map(([day, p]) => ({ day: parseInt(day), dayName: dayNames[parseInt(day)], ...p }))
    .sort((a, b) => b.successRate - a.successRate);

  const insights = [];

  // Best time insight
  if (hourlyEntries.length >= 1) {
    const best = hourlyEntries[0];
    const timeLabel = best.hour < 12 ? `${best.hour || 12}AM` : `${best.hour === 12 ? 12 : best.hour - 12}PM`;
    insights.push({
      type: 'optimization',
      title: 'Peak Performance Hour',
      message: `Tasks completed around ${timeLabel} have a ${best.successRate}% success rate`,
      icon: 'clock'
    });
  }

  // Best day insight
  if (dailyEntries.length >= 1) {
    const best = dailyEntries[0];
    insights.push({
      type: 'info',
      title: 'Most Productive Day',
      message: `${best.dayName}s show ${best.successRate}% success rate with ${best.tasks} tasks completed`,
      icon: 'calendar'
    });
  }

  // Streak encouragement
  const { streaks } = data;
  if (streaks?.currentDaily >= 3) {
    insights.push({
      type: 'success',
      title: '🔥 Hot Streak!',
      message: `${streaks.currentDaily} days of continuous productivity! Keep it up!`,
      icon: 'flame'
    });
  } else if (streaks?.currentDaily === 0 && streaks?.longestDaily > 0) {
    insights.push({
      type: 'warning',
      title: 'Streak Broken',
      message: `Your best was ${streaks.longestDaily} days. Start a new streak today!`,
      icon: 'refresh'
    });
  }

  // Weekly consistency
  if (streaks?.currentWeekly >= 4) {
    insights.push({
      type: 'success',
      title: 'Weekly Warrior',
      message: `${streaks.currentWeekly} consecutive weeks of activity!`,
      icon: 'trophy'
    });
  }

  return {
    ...data,
    insights,
    bestHour: hourlyEntries[0] || null,
    worstHour: hourlyEntries[hourlyEntries.length - 1] || null,
    bestDay: dailyEntries[0] || null,
    worstDay: dailyEntries[dailyEntries.length - 1] || null
  };
}

/**
 * Update productivity data on task completion
 */
export async function onTaskCompleted(agent) {
  // Debounce recalculation - just trigger it
  // A full recalculation ensures accurate streak counting
  await recalculateProductivity();
  cosEvents.emit('productivity:updated');
}

/**
 * Get summary for the dashboard
 */
export async function getProductivitySummary() {
  const data = await loadProductivity();

  return {
    currentStreak: data.streaks?.currentDaily || 0,
    longestStreak: data.streaks?.longestDaily || 0,
    weeklyStreak: data.streaks?.currentWeekly || 0,
    lastActive: data.streaks?.lastActiveDate || null,
    totalDays: data.totals?.activeDays || 0,
    recentMilestone: data.milestones?.[data.milestones.length - 1] || null
  };
}

/**
 * Get daily task trends for visualization
 * Returns last N days of task completion data with trend analysis
 */
export async function getDailyTrends(days = 30) {
  const data = await loadProductivity();
  const dailyHistory = data.dailyHistory || {};

  // Generate date range for last N days
  const today = new Date();
  const dateRange = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dateRange.push(getDateString(d));
  }

  // Build trend data for each day
  const trendData = dateRange.map(date => {
    const dayData = dailyHistory[date] || { tasks: 0, successes: 0, failures: 0, successRate: 0 };
    return {
      date,
      dateShort: date.slice(5), // MM-DD
      ...dayData
    };
  });

  // Calculate rolling averages and trends
  const windowSize = 7;
  const withAverages = trendData.map((day, idx) => {
    const window = trendData.slice(Math.max(0, idx - windowSize + 1), idx + 1);
    const avgTasks = window.reduce((sum, d) => sum + d.tasks, 0) / window.length;
    const avgSuccessRate = window.reduce((sum, d) => sum + d.successRate, 0) / window.length;
    return {
      ...day,
      rollingAvgTasks: Math.round(avgTasks * 10) / 10,
      rollingAvgSuccessRate: Math.round(avgSuccessRate)
    };
  });

  // Calculate overall trend direction
  const recentDays = withAverages.slice(-7);
  const olderDays = withAverages.slice(-14, -7);

  const recentTotal = recentDays.reduce((sum, d) => sum + d.tasks, 0);
  const olderTotal = olderDays.reduce((sum, d) => sum + d.tasks, 0);
  const recentAvgRate = recentDays.reduce((sum, d) => sum + d.successRate, 0) / (recentDays.length || 1);
  const olderAvgRate = olderDays.reduce((sum, d) => sum + d.successRate, 0) / (olderDays.length || 1);

  let volumeTrend = 'stable';
  if (recentTotal > olderTotal * 1.2) volumeTrend = 'increasing';
  else if (recentTotal < olderTotal * 0.8) volumeTrend = 'decreasing';

  let successTrend = 'stable';
  if (recentAvgRate > olderAvgRate + 10) successTrend = 'improving';
  else if (recentAvgRate < olderAvgRate - 10) successTrend = 'declining';

  // Summary stats
  const activeDaysInRange = trendData.filter(d => d.tasks > 0).length;
  const totalTasksInRange = trendData.reduce((sum, d) => sum + d.tasks, 0);
  const avgTasksPerActiveDay = activeDaysInRange > 0
    ? Math.round(totalTasksInRange / activeDaysInRange * 10) / 10
    : 0;

  return {
    data: withAverages,
    summary: {
      days,
      activeDays: activeDaysInRange,
      totalTasks: totalTasksInRange,
      avgTasksPerActiveDay,
      avgSuccessRate: Math.round(
        trendData.filter(d => d.tasks > 0).reduce((sum, d) => sum + d.successRate, 0) /
        (activeDaysInRange || 1)
      ),
      volumeTrend,
      successTrend
    }
  };
}

/**
 * Get activity calendar data for GitHub-style heatmap
 * Returns last N weeks of daily activity in a format optimized for calendar display
 * @param {number} weeks - Number of weeks to include (default: 12)
 * @returns {Object} Calendar data with days organized by week
 */
export async function getActivityCalendar(weeks = 12) {
  const data = await loadProductivity();
  const dailyHistory = data.dailyHistory || {};

  // Calculate date range: from start of week N weeks ago to today
  const today = new Date();
  const todayStr = getDateString(today);

  // Find the start of the range (weeks ago, aligned to Sunday)
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (weeks * 7) + 1);
  // Align to Sunday
  const startDayOfWeek = startDate.getDay();
  startDate.setDate(startDate.getDate() - startDayOfWeek);

  // Build calendar grid: array of weeks, each containing 7 days
  const calendar = [];
  let currentDate = new Date(startDate);
  let currentWeek = [];
  let maxTasks = 1;

  while (currentDate <= today) {
    const dateStr = getDateString(currentDate);
    const dayData = dailyHistory[dateStr] || { tasks: 0, successes: 0, failures: 0, successRate: 0 };

    if (dayData.tasks > maxTasks) {
      maxTasks = dayData.tasks;
    }

    currentWeek.push({
      date: dateStr,
      dayOfWeek: currentDate.getDay(),
      tasks: dayData.tasks,
      successes: dayData.successes,
      failures: dayData.failures,
      successRate: dayData.successRate,
      isToday: dateStr === todayStr,
      isFuture: currentDate > today
    });

    // Start new week on Sunday
    if (currentDate.getDay() === 6) {
      calendar.push(currentWeek);
      currentWeek = [];
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  // Add remaining days if any
  if (currentWeek.length > 0) {
    calendar.push(currentWeek);
  }

  // Calculate summary stats
  const allDays = calendar.flat();
  const activeDays = allDays.filter(d => d.tasks > 0);
  const totalTasks = activeDays.reduce((sum, d) => sum + d.tasks, 0);
  const totalSuccesses = activeDays.reduce((sum, d) => sum + d.successes, 0);

  return {
    weeks: calendar,
    maxTasks,
    summary: {
      totalDays: allDays.length,
      activeDays: activeDays.length,
      totalTasks,
      totalSuccesses,
      successRate: totalTasks > 0 ? Math.round((totalSuccesses / totalTasks) * 100) : 0,
      avgTasksPerActiveDay: activeDays.length > 0
        ? Math.round((totalTasks / activeDays.length) * 10) / 10
        : 0
    },
    currentStreak: data.streaks?.currentDaily || 0
  };
}
