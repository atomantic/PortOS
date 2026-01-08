/**
 * Weekly Digest Service
 *
 * Generates comprehensive weekly summaries of CoS activity.
 * Tracks week-over-week improvements, trending task types,
 * error patterns, and accomplishments.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cosEvents, emitLog, getAgents } from './cos.js';
import { getLearningInsights, getAllTaskDurations } from './taskLearning.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data/cos');
const DIGESTS_DIR = join(DATA_DIR, 'digests');

/**
 * Get the start of a week (Monday) for a given date
 */
function getWeekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  return new Date(d.setDate(diff));
}

/**
 * Get the ISO week number for a date
 */
function getWeekNumber(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Get week identifier (YYYY-WXX format)
 */
function getWeekId(date = new Date()) {
  const year = date.getFullYear();
  const week = getWeekNumber(date);
  return `${year}-W${week.toString().padStart(2, '0')}`;
}

/**
 * Ensure digest directory exists
 */
async function ensureDigestDir() {
  if (!existsSync(DIGESTS_DIR)) {
    await mkdir(DIGESTS_DIR, { recursive: true });
  }
}

/**
 * Get digest file path for a week
 */
function getDigestPath(weekId) {
  return join(DIGESTS_DIR, `${weekId}.json`);
}

/**
 * Load a digest for a specific week
 */
async function loadDigest(weekId) {
  const path = getDigestPath(weekId);
  if (!existsSync(path)) {
    return null;
  }
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save a digest
 */
async function saveDigest(digest) {
  await ensureDigestDir();
  const path = getDigestPath(digest.weekId);
  await writeFile(path, JSON.stringify(digest, null, 2));
  return path;
}

/**
 * Format duration in human-readable format
 */
function formatDuration(ms) {
  if (!ms) return '0m';
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }
  if (hours > 0) {
    const remainingMins = mins % 60;
    return `${hours}h ${remainingMins}m`;
  }
  return `${mins}m`;
}

/**
 * Calculate percentage change between two values
 */
function percentChange(current, previous) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * Generate a weekly digest for a specific week
 */
export async function generateWeeklyDigest(weekId = null) {
  const targetWeekId = weekId || getWeekId();
  const weekStart = getWeekStart(new Date());
  weekStart.setHours(0, 0, 0, 0);

  emitLog('info', `Generating weekly digest for ${targetWeekId}`, { weekId: targetWeekId }, '[WeeklyDigest]');

  // Get all agents
  const agents = await getAgents();

  // Filter agents completed this week
  const weekAgents = agents.filter(a => {
    if (!a.completedAt) return false;
    const completedWeek = getWeekId(new Date(a.completedAt));
    return completedWeek === targetWeekId;
  });

  // Calculate basic stats
  const totalTasks = weekAgents.length;
  const succeededTasks = weekAgents.filter(a => a.result?.success).length;
  const failedTasks = totalTasks - succeededTasks;
  const successRate = totalTasks > 0 ? Math.round((succeededTasks / totalTasks) * 100) : 0;

  // Calculate total work time
  const totalWorkTimeMs = weekAgents.reduce((sum, a) => sum + (a.result?.duration || 0), 0);

  // Group by task type
  const byTaskType = {};
  for (const agent of weekAgents) {
    const taskType = agent.metadata?.analysisType || agent.metadata?.taskType || 'user-task';
    if (!byTaskType[taskType]) {
      byTaskType[taskType] = { completed: 0, succeeded: 0, failed: 0, totalDurationMs: 0 };
    }
    byTaskType[taskType].completed++;
    if (agent.result?.success) {
      byTaskType[taskType].succeeded++;
    } else {
      byTaskType[taskType].failed++;
    }
    byTaskType[taskType].totalDurationMs += (agent.result?.duration || 0);
  }

  // Find top accomplishments (successful tasks with longest duration - they did the most work)
  const accomplishments = weekAgents
    .filter(a => a.result?.success)
    .map(a => ({
      id: a.id,
      taskId: a.taskId,
      description: truncateDescription(a.metadata?.taskDescription || a.taskId),
      taskType: a.metadata?.analysisType || a.metadata?.taskType || 'task',
      duration: a.result?.duration || 0,
      completedAt: a.completedAt
    }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 10);

  // Find recurring issues (failed tasks with similar patterns)
  const errorPatterns = {};
  for (const agent of weekAgents.filter(a => !a.result?.success)) {
    const error = agent.result?.error || agent.result?.errorAnalysis?.category || 'unknown';
    if (!errorPatterns[error]) {
      errorPatterns[error] = { count: 0, tasks: [] };
    }
    errorPatterns[error].count++;
    errorPatterns[error].tasks.push({
      id: agent.taskId,
      description: truncateDescription(agent.metadata?.taskDescription, 50)
    });
  }

  // Sort task types by completion count
  const taskTypeRanking = Object.entries(byTaskType)
    .map(([type, stats]) => ({
      type,
      ...stats,
      successRate: stats.completed > 0 ? Math.round((stats.succeeded / stats.completed) * 100) : 0
    }))
    .sort((a, b) => b.completed - a.completed);

  // Get previous week's digest for comparison
  const prevWeekDate = new Date(weekStart);
  prevWeekDate.setDate(prevWeekDate.getDate() - 7);
  const prevWeekId = getWeekId(prevWeekDate);
  const prevDigest = await loadDigest(prevWeekId);

  // Calculate week-over-week changes
  const weekOverWeek = {
    tasksChange: prevDigest ? percentChange(totalTasks, prevDigest.summary.totalTasks) : null,
    successRateChange: prevDigest ? successRate - prevDigest.summary.successRate : null,
    workTimeChange: prevDigest ? percentChange(totalWorkTimeMs, prevDigest.summary.totalWorkTimeMs) : null
  };

  // Generate insights
  const insights = generateInsights(taskTypeRanking, errorPatterns, weekOverWeek, totalTasks);

  const digest = {
    weekId: targetWeekId,
    generatedAt: new Date().toISOString(),
    weekStart: weekStart.toISOString(),
    weekEnd: new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString(),

    summary: {
      totalTasks,
      succeededTasks,
      failedTasks,
      successRate,
      totalWorkTimeMs,
      totalWorkTime: formatDuration(totalWorkTimeMs)
    },

    weekOverWeek,
    previousWeekId: prevDigest ? prevWeekId : null,

    byTaskType: taskTypeRanking,

    accomplishments,

    issues: Object.entries(errorPatterns)
      .map(([error, data]) => ({ error, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),

    insights
  };

  // Save the digest
  await saveDigest(digest);

  emitLog('success', `Weekly digest generated: ${totalTasks} tasks, ${successRate}% success`, {
    weekId: targetWeekId,
    totalTasks,
    successRate
  }, '[WeeklyDigest]');

  cosEvents.emit('digest:generated', digest);

  return digest;
}

/**
 * Truncate description to a reasonable length
 */
function truncateDescription(desc, maxLen = 100) {
  if (!desc) return 'No description';
  if (desc.length <= maxLen) return desc;
  return desc.substring(0, maxLen - 3) + '...';
}

/**
 * Generate human-readable insights from the week's data
 */
function generateInsights(taskTypeRanking, errorPatterns, weekOverWeek, totalTasks) {
  const insights = [];

  // Insight about overall productivity
  if (totalTasks === 0) {
    insights.push({
      type: 'info',
      title: 'Quiet Week',
      message: 'No tasks were completed this week.'
    });
  } else if (totalTasks >= 20) {
    insights.push({
      type: 'success',
      title: 'High Productivity',
      message: `Completed ${totalTasks} tasks this week - excellent output!`
    });
  }

  // Week-over-week comparison
  if (weekOverWeek.tasksChange !== null) {
    if (weekOverWeek.tasksChange > 20) {
      insights.push({
        type: 'success',
        title: 'Increased Output',
        message: `Task completion increased by ${weekOverWeek.tasksChange}% compared to last week.`
      });
    } else if (weekOverWeek.tasksChange < -20) {
      insights.push({
        type: 'warning',
        title: 'Decreased Output',
        message: `Task completion decreased by ${Math.abs(weekOverWeek.tasksChange)}% compared to last week.`
      });
    }

    if (weekOverWeek.successRateChange !== null && Math.abs(weekOverWeek.successRateChange) >= 10) {
      if (weekOverWeek.successRateChange > 0) {
        insights.push({
          type: 'success',
          title: 'Improved Success Rate',
          message: `Success rate improved by ${weekOverWeek.successRateChange} percentage points.`
        });
      } else {
        insights.push({
          type: 'warning',
          title: 'Declining Success Rate',
          message: `Success rate dropped by ${Math.abs(weekOverWeek.successRateChange)} percentage points.`
        });
      }
    }
  }

  // Top performing task type
  const topType = taskTypeRanking.find(t => t.completed >= 3 && t.successRate >= 90);
  if (topType) {
    insights.push({
      type: 'success',
      title: 'Star Performer',
      message: `${formatTaskType(topType.type)} tasks achieved ${topType.successRate}% success rate.`
    });
  }

  // Problematic task type
  const problemType = taskTypeRanking.find(t => t.completed >= 3 && t.successRate < 50);
  if (problemType) {
    insights.push({
      type: 'warning',
      title: 'Needs Attention',
      message: `${formatTaskType(problemType.type)} tasks have only ${problemType.successRate}% success rate.`
    });
  }

  // Recurring errors
  const topError = Object.entries(errorPatterns).sort((a, b) => b[1].count - a[1].count)[0];
  if (topError && topError[1].count >= 3) {
    insights.push({
      type: 'action',
      title: 'Recurring Issue',
      message: `"${topError[0]}" error occurred ${topError[1].count} times this week.`
    });
  }

  // Most worked on type
  if (taskTypeRanking.length > 0) {
    const mostWorked = taskTypeRanking[0];
    insights.push({
      type: 'info',
      title: 'Focus Area',
      message: `Most effort spent on ${formatTaskType(mostWorked.type)} tasks (${mostWorked.completed} completed).`
    });
  }

  return insights;
}

/**
 * Format task type for display
 */
function formatTaskType(taskType) {
  if (taskType.startsWith('self-improve:')) {
    return taskType.replace('self-improve:', '').replace(/-/g, ' ');
  }
  return taskType.replace(/-/g, ' ');
}

/**
 * Get digest for a specific week
 */
export async function getWeeklyDigest(weekId = null) {
  const targetWeekId = weekId || getWeekId();

  // Check if digest exists
  let digest = await loadDigest(targetWeekId);

  // Generate if it doesn't exist or if it's the current week (refresh)
  if (!digest || targetWeekId === getWeekId()) {
    digest = await generateWeeklyDigest(targetWeekId);
  }

  return digest;
}

/**
 * List all available weekly digests
 */
export async function listWeeklyDigests() {
  await ensureDigestDir();

  const files = await readdir(DIGESTS_DIR);
  const digests = [];

  for (const file of files.filter(f => f.endsWith('.json'))) {
    const weekId = file.replace('.json', '');
    const digest = await loadDigest(weekId);
    if (digest) {
      digests.push({
        weekId: digest.weekId,
        weekStart: digest.weekStart,
        weekEnd: digest.weekEnd,
        totalTasks: digest.summary.totalTasks,
        successRate: digest.summary.successRate,
        generatedAt: digest.generatedAt
      });
    }
  }

  return digests.sort((a, b) => b.weekId.localeCompare(a.weekId));
}

/**
 * Get comparative stats between two weeks
 */
export async function compareWeeks(weekId1, weekId2) {
  const digest1 = await loadDigest(weekId1);
  const digest2 = await loadDigest(weekId2);

  if (!digest1 || !digest2) {
    return null;
  }

  return {
    week1: { weekId: weekId1, ...digest1.summary },
    week2: { weekId: weekId2, ...digest2.summary },
    comparison: {
      tasksChange: percentChange(digest1.summary.totalTasks, digest2.summary.totalTasks),
      successRateChange: digest1.summary.successRate - digest2.summary.successRate,
      workTimeChange: percentChange(digest1.summary.totalWorkTimeMs, digest2.summary.totalWorkTimeMs)
    }
  };
}

/**
 * Get current week progress (partial digest for in-progress week)
 */
export async function getCurrentWeekProgress() {
  const weekId = getWeekId();
  const weekStart = getWeekStart();
  weekStart.setHours(0, 0, 0, 0);

  // Get all agents
  const agents = await getAgents();

  // Filter agents completed this week
  const weekAgents = agents.filter(a => {
    if (!a.completedAt) return false;
    const completedWeek = getWeekId(new Date(a.completedAt));
    return completedWeek === weekId;
  });

  // Currently running agents
  const runningAgents = agents.filter(a => a.status === 'running');

  const totalTasks = weekAgents.length;
  const succeededTasks = weekAgents.filter(a => a.result?.success).length;
  const successRate = totalTasks > 0 ? Math.round((succeededTasks / totalTasks) * 100) : 0;
  const totalWorkTimeMs = weekAgents.reduce((sum, a) => sum + (a.result?.duration || 0), 0);

  // Calculate active work time for running agents
  const activeTimeMs = runningAgents.reduce((sum, a) => {
    if (!a.startedAt) return sum;
    return sum + (Date.now() - new Date(a.startedAt).getTime());
  }, 0);

  // Days remaining in week
  const now = new Date();
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const daysRemaining = Math.ceil((weekEnd - now) / (24 * 60 * 60 * 1000));

  // Project weekly totals based on current pace
  const daysPassed = 7 - daysRemaining;
  const projectedTasks = daysPassed > 0 ? Math.round(totalTasks * (7 / daysPassed)) : totalTasks;

  return {
    weekId,
    weekStart: weekStart.toISOString(),
    daysRemaining,
    daysPassed,

    current: {
      totalTasks,
      succeededTasks,
      failedTasks: totalTasks - succeededTasks,
      successRate,
      totalWorkTimeMs,
      totalWorkTime: formatDuration(totalWorkTimeMs),
      runningAgents: runningAgents.length,
      activeTimeMs,
      activeTime: formatDuration(activeTimeMs)
    },

    projected: {
      tasks: projectedTasks,
      workTimeMs: daysPassed > 0 ? Math.round(totalWorkTimeMs * (7 / daysPassed)) : totalWorkTimeMs,
      workTime: formatDuration(daysPassed > 0 ? Math.round(totalWorkTimeMs * (7 / daysPassed)) : totalWorkTimeMs)
    },

    recentCompletions: weekAgents
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
      .slice(0, 5)
      .map(a => ({
        id: a.id,
        taskId: a.taskId,
        success: a.result?.success,
        description: truncateDescription(a.metadata?.taskDescription, 60),
        completedAt: a.completedAt
      }))
  };
}

/**
 * Generate a text summary suitable for notifications or logging
 */
export async function generateTextSummary(weekId = null) {
  const digest = await getWeeklyDigest(weekId);
  if (!digest) return null;

  const lines = [
    `Weekly Digest: ${digest.weekId}`,
    `=====================================`,
    ``,
    `Summary:`,
    `  - Tasks Completed: ${digest.summary.totalTasks}`,
    `  - Success Rate: ${digest.summary.successRate}%`,
    `  - Total Work Time: ${digest.summary.totalWorkTime}`,
    ``
  ];

  if (digest.weekOverWeek.tasksChange !== null) {
    lines.push(`Week-over-Week:`);
    lines.push(`  - Tasks: ${digest.weekOverWeek.tasksChange > 0 ? '+' : ''}${digest.weekOverWeek.tasksChange}%`);
    if (digest.weekOverWeek.successRateChange !== null) {
      lines.push(`  - Success Rate: ${digest.weekOverWeek.successRateChange > 0 ? '+' : ''}${digest.weekOverWeek.successRateChange} pts`);
    }
    lines.push(``);
  }

  if (digest.accomplishments.length > 0) {
    lines.push(`Top Accomplishments:`);
    for (const acc of digest.accomplishments.slice(0, 5)) {
      lines.push(`  - ${acc.description}`);
    }
    lines.push(``);
  }

  if (digest.insights.length > 0) {
    lines.push(`Insights:`);
    for (const insight of digest.insights) {
      const icon = insight.type === 'success' ? '+' : insight.type === 'warning' ? '!' : '-';
      lines.push(`  [${icon}] ${insight.title}: ${insight.message}`);
    }
  }

  return lines.join('\n');
}
