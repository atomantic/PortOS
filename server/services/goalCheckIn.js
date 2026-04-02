import { writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { PATHS, readJSONFile, ensureDir } from '../lib/fileUtils.js';
import { callProviderAISimple, parseLLMJSON } from '../lib/aiProvider.js';
import { addNotification, NOTIFICATION_TYPES } from './notifications.js';

const GOALS_FILE = join(PATHS.digitalTwin, 'goals.json');

function computeExpectedProgress(goal) {
  const start = new Date(goal.createdAt);
  const target = new Date(goal.targetDate + 'T00:00:00');
  const now = new Date();
  const totalDays = (target - start) / (1000 * 60 * 60 * 24);
  const elapsed = (now - start) / (1000 * 60 * 60 * 24);
  if (totalDays <= 0) return 100;
  return Math.min(100, Math.round((elapsed / totalDays) * 100));
}

function determineStatus(actual, expected) {
  const ratio = expected > 0 ? actual / expected : 1;
  if (ratio >= 0.8) return 'on-track';
  if (ratio >= 0.5) return 'behind';
  return 'at-risk';
}

function buildCheckInPrompt(goal, expectedProgress, actualProgress, status, recentEntries) {
  return `You are a goal accountability coach. Give a brief assessment (2-3 sentences) and 1-3 specific recommendations.

Goal: ${goal.title}
Description: ${goal.description || 'None'}
Target date: ${goal.targetDate}
Expected progress: ${expectedProgress}%
Actual progress: ${actualProgress}%
Status: ${status}
Recent activity entries (last 7 days): ${recentEntries.length}
Milestones completed: ${goal.milestones?.filter(m => m.completedAt).length || 0}/${goal.milestones?.length || 0}

Respond with JSON only (no markdown fences): { "assessment": "string", "recommendations": ["string", ...] }`;
}

export async function runGoalCheckIn() {
  const { getActiveProvider } = await import('./providers.js');
  const goals = await readJSONFile(GOALS_FILE, { goals: [] });
  const activeGoals = goals.goals.filter(g => g.status === 'active' && g.targetDate);

  if (!activeGoals.length) {
    console.log('📊 Goal check-in: no active goals with target dates');
    return { checked: 0 };
  }

  const provider = await getActiveProvider();
  if (!provider) {
    console.log('📊 Goal check-in: no AI provider available');
    return { checked: 0, error: 'No AI provider' };
  }

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Build check-in data and LLM prompts for all goals
  const checkInData = activeGoals.map(goal => {
    const expectedProgress = computeExpectedProgress(goal);
    const actualProgress = goal.progress ?? 0;
    const status = determineStatus(actualProgress, expectedProgress);
    const recentEntries = (goal.progressLog || []).filter(e => new Date(e.date) >= sevenDaysAgo);
    const attendanceRate = Math.min(100, Math.round((recentEntries.length / 7) * 100));
    const prompt = buildCheckInPrompt(goal, expectedProgress, actualProgress, status, recentEntries);
    return { goal, expectedProgress, actualProgress, status, attendanceRate, prompt };
  });

  // Parallelize LLM calls
  const llmResults = await Promise.all(
    checkInData.map(d => callProviderAISimple(provider, provider.defaultModel, d.prompt))
  );

  const results = [];
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  for (let i = 0; i < checkInData.length; i++) {
    const d = checkInData[i];
    const llmResult = llmResults[i];

    let assessment = '';
    let recommendations = [];
    if (!llmResult.error) {
      try {
        const parsed = parseLLMJSON(llmResult.text);
        assessment = parsed.assessment || '';
        recommendations = parsed.recommendations || [];
      } catch {
        // LLM returned invalid JSON — continue with empty assessment
      }
    }

    const checkIn = {
      id: `ci-${uuidv4()}`,
      date: today,
      status: d.status,
      expectedProgress: d.expectedProgress,
      actualProgress: d.actualProgress,
      attendanceRate: d.attendanceRate,
      assessment,
      recommendations,
      createdAt: now
    };

    if (!d.goal.checkIns) d.goal.checkIns = [];
    d.goal.checkIns.push(checkIn);
    d.goal.updatedAt = now;
    results.push({ goalId: d.goal.id, title: d.goal.title, status: d.status, checkIn });
  }

  goals.updatedAt = now;
  await ensureDir(PATHS.digitalTwin);
  await writeFile(GOALS_FILE, JSON.stringify(goals, null, 2));

  // Send Telegram notification
  const statusEmoji = { 'on-track': '🟢', 'behind': '🟡', 'at-risk': '🔴' };
  const summary = results.map(r => `${statusEmoji[r.status] || '⚪'} ${r.title}: ${r.status} (${r.checkIn.actualProgress}%/${r.checkIn.expectedProgress}%)`).join('\n');

  await addNotification({
    type: NOTIFICATION_TYPES.HEALTH_ISSUE,
    title: 'Goal Check-in',
    message: `Weekly check-in for ${results.length} goal(s):\n${summary}`,
    priority: results.some(r => r.status === 'at-risk') ? 'high' : 'medium'
  });

  console.log(`📊 Goal check-in complete: ${results.length} goals checked`);
  return { checked: results.length, results };
}
