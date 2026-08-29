/**
 * Productivity Service
 *
 * Tracks agent work patterns and generates insights about optimal working times.
 */

import { join } from 'path';
import { cosEvents } from './cosEvents.js';
import { getAgents } from './cosAgentLifecycle.js';
import { ensureDir, getDateString, PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { getWeekId } from '../lib/isoWeek.js';

const DATA_DIR = PATHS.cos;
const PRODUCTIVITY_FILE = join(DATA_DIR, 'productivity.json');

/**
 * Default productivity data structure
 */
const DEFAULT_PRODUCTIVITY = {
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
 * Load productivity data
 */
export async function loadProductivity() {
  await ensureDir(DATA_DIR);
  const data = await readJSONFile(PRODUCTIVITY_FILE, null);
  // Clone the defaults on every read: callers (onTaskCompleted) mutate the
  // nested pattern maps in place, so handing back the module-level constant
  // would leak one call's counters into the next "no file yet" read.
  const defaults = structuredClone(DEFAULT_PRODUCTIVITY);
  if (!data) return defaults;
  // Ignore the retired streak field when reading older installs. The next
  // normal write removes it from disk without needing a destructive migration.
  const currentData = { ...data };
  delete currentData.streaks;
  if (Array.isArray(currentData.milestones)) {
    currentData.milestones = currentData.milestones.filter((milestone) => milestone?.type !== 'streak');
  }
  // Merge with defaults to ensure all current fields exist.
  return {
    ...defaults,
    ...currentData,
  };
}

/**
 * Save productivity data
 */
async function saveProductivity(data) {
  await ensureDir(DATA_DIR);
  data.lastUpdated = new Date().toISOString();
  await atomicWrite(PRODUCTIVITY_FILE, data);
  return data;
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

  // Track distinct active dates and weeks for aggregate totals.
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

  const sortedDates = Array.from(activeDates).sort();
  const sortedWeeks = Array.from(activeWeeks).sort();

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

  const productivity = {
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
    .map(([hour, p]) => ({ hour: parseInt(hour, 10), ...p }))
    .sort((a, b) => b.successRate - a.successRate);

  // Find best days
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dailyEntries = Object.entries(data.dailyPatterns || {})
    .filter(([, p]) => p.tasks >= 3)
    .map(([day, p]) => ({ day: parseInt(day, 10), dayName: dayNames[parseInt(day, 10)], ...p }))
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
 * Update productivity data incrementally on task completion.
 * Only processes the single newly completed agent instead of rescanning all agents.
 */
export async function onTaskCompleted(agent) {
  if (!agent?.completedAt) return;

  const data = await loadProductivity();
  const completedAt = new Date(agent.completedAt);
  const dateStr = getDateString(completedAt);
  const hour = completedAt.getHours();
  const dayOfWeek = completedAt.getDay();
  const success = agent.result?.success === true;
  const duration = agent.result?.duration || 0;

  // Update hourly patterns
  if (!data.hourlyPatterns[hour]) {
    data.hourlyPatterns[hour] = { tasks: 0, successes: 0, failures: 0, totalDuration: 0 };
  }
  data.hourlyPatterns[hour].tasks++;
  if (success) data.hourlyPatterns[hour].successes++;
  else data.hourlyPatterns[hour].failures++;
  data.hourlyPatterns[hour].totalDuration += duration;
  data.hourlyPatterns[hour].avgDuration = Math.round(data.hourlyPatterns[hour].totalDuration / data.hourlyPatterns[hour].tasks);
  data.hourlyPatterns[hour].successRate = Math.round((data.hourlyPatterns[hour].successes / data.hourlyPatterns[hour].tasks) * 100);

  // Update daily patterns (by day of week)
  if (!data.dailyPatterns[dayOfWeek]) {
    data.dailyPatterns[dayOfWeek] = { tasks: 0, successes: 0, failures: 0, totalDuration: 0 };
  }
  data.dailyPatterns[dayOfWeek].tasks++;
  if (success) data.dailyPatterns[dayOfWeek].successes++;
  else data.dailyPatterns[dayOfWeek].failures++;
  data.dailyPatterns[dayOfWeek].totalDuration += duration;
  data.dailyPatterns[dayOfWeek].avgDuration = Math.round(data.dailyPatterns[dayOfWeek].totalDuration / data.dailyPatterns[dayOfWeek].tasks);
  data.dailyPatterns[dayOfWeek].successRate = Math.round((data.dailyPatterns[dayOfWeek].successes / data.dailyPatterns[dayOfWeek].tasks) * 100);

  // Update daily history
  if (!data.dailyHistory[dateStr]) {
    data.dailyHistory[dateStr] = { tasks: 0, successes: 0, failures: 0 };
  }
  data.dailyHistory[dateStr].tasks++;
  if (success) data.dailyHistory[dateStr].successes++;
  else data.dailyHistory[dateStr].failures++;
  data.dailyHistory[dateStr].successRate = Math.round((data.dailyHistory[dateStr].successes / data.dailyHistory[dateStr].tasks) * 100);

  // Prune dailyHistory older than 90 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = getDateString(cutoff);
  for (const date of Object.keys(data.dailyHistory)) {
    if (date < cutoffStr) delete data.dailyHistory[date];
  }

  await saveProductivity(data);
  cosEvents.emit('productivity:updated');
}

/**
 * Get summary for the dashboard
 */
export async function getProductivitySummary() {
  const data = await loadProductivity();

  return {
    totalDays: data.totals?.activeDays || 0,
    recentMilestone: data.milestones?.[data.milestones.length - 1] || null
  };
}

/**
 * Get velocity metrics - how today compares to historical average
 * @returns {Object} Velocity data including today's count, average, and relative performance
 */
export async function getVelocityMetrics() {
  const data = await loadProductivity();
  const dailyHistory = data.dailyHistory || {};
  const today = getDateString();

  // Get today's stats
  const todayStats = dailyHistory[today] || { tasks: 0, successes: 0, failures: 0 };

  // Calculate historical daily average (excluding today)
  const historicalDays = Object.entries(dailyHistory)
    .filter(([date]) => date !== today)
    .map(([, stats]) => stats);

  // Only count days with at least 1 task for average (active days)
  const activeDays = historicalDays.filter(d => d.tasks > 0);
  const avgTasksPerDay = activeDays.length > 0
    ? activeDays.reduce((sum, d) => sum + d.tasks, 0) / activeDays.length
    : 0;

  // Calculate velocity: how today compares to average
  // null if no history, percentage otherwise
  let velocity = null;
  let velocityLabel = null;

  if (avgTasksPerDay > 0 && todayStats.tasks > 0) {
    velocity = Math.round((todayStats.tasks / avgTasksPerDay) * 100);
    if (velocity >= 150) velocityLabel = 'exceptional';
    else if (velocity >= 120) velocityLabel = 'above-average';
    else if (velocity >= 80) velocityLabel = 'on-track';
    else if (velocity >= 50) velocityLabel = 'slow';
    else velocityLabel = 'light';
  } else if (todayStats.tasks > 0 && avgTasksPerDay === 0) {
    // First active day ever
    velocity = 100;
    velocityLabel = 'first-day';
  }

  return {
    today: todayStats.tasks,
    todaySuccesses: todayStats.successes,
    todayFailures: todayStats.failures,
    avgPerDay: Math.round(avgTasksPerDay * 10) / 10,
    historicalDays: activeDays.length,
    velocity,
    velocityLabel
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

  // Build calendar up through end of today's week (Saturday) for a complete grid
  const endOfWeek = new Date(today);
  endOfWeek.setDate(endOfWeek.getDate() + (6 - endOfWeek.getDay()));

  while (currentDate <= endOfWeek) {
    const dateStr = getDateString(currentDate);
    const isFuture = currentDate > today;
    const dayData = isFuture ? { tasks: 0, successes: 0, failures: 0, successRate: 0 } :
      (dailyHistory[dateStr] || { tasks: 0, successes: 0, failures: 0, successRate: 0 });

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
      isFuture
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
    }
  };
}

/**
 * Get optimal time indicator for current hour
 * Compares current hour's success rate to find peak windows
 * @returns {Object} Optimal time data
 */
export async function getOptimalTimeInfo() {
  const data = await loadProductivity();
  const hourlyPatterns = data.hourlyPatterns || {};
  const currentHour = new Date().getHours();

  // Need minimum data to make meaningful recommendations
  const minTasksForReliable = 3;

  // Get hours with enough data, sorted by success rate
  const rankedHours = Object.entries(hourlyPatterns)
    .filter(([, p]) => p.tasks >= minTasksForReliable)
    .map(([hour, p]) => ({
      hour: parseInt(hour, 10),
      tasks: p.tasks,
      successRate: p.successRate
    }))
    .sort((a, b) => b.successRate - a.successRate);

  // Not enough data
  if (rankedHours.length < 3) {
    return { hasData: false };
  }

  // Find current hour's data
  const currentHourData = hourlyPatterns[currentHour];
  const currentSuccessRate = currentHourData?.successRate ?? null;
  const currentTasks = currentHourData?.tasks ?? 0;

  // Calculate average success rate
  const avgSuccessRate = rankedHours.reduce((sum, h) => sum + h.successRate, 0) / rankedHours.length;

  // Determine if current hour is optimal (top 25%), good (above avg), or suboptimal
  const topThreshold = Math.ceil(rankedHours.length * 0.25);
  const topHours = rankedHours.slice(0, topThreshold).map(h => h.hour);
  const isOptimal = topHours.includes(currentHour);
  const isAboveAverage = currentSuccessRate !== null && currentSuccessRate >= avgSuccessRate;

  // Find next optimal hour if current isn't optimal
  let nextOptimalHour = null;
  if (!isOptimal) {
    // Find nearest future top hour
    for (let offset = 1; offset < 24; offset++) {
      const checkHour = (currentHour + offset) % 24;
      if (topHours.includes(checkHour)) {
        nextOptimalHour = checkHour;
        break;
      }
    }
  }

  // Format hour for display
  const formatHour = (h) => {
    if (h === 0) return '12AM';
    if (h === 12) return '12PM';
    return h < 12 ? `${h}AM` : `${h - 12}PM`;
  };

  return {
    hasData: true,
    currentHour,
    currentSuccessRate,
    currentTasks,
    isOptimal,
    isAboveAverage,
    topHours,
    nextOptimalHour,
    nextOptimalFormatted: nextOptimalHour !== null ? formatHour(nextOptimalHour) : null,
    avgSuccessRate: Math.round(avgSuccessRate),
    peakSuccessRate: rankedHours[0]?.successRate ?? 0
  };
}
