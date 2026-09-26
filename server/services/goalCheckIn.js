import { v4 as uuidv4 } from '../lib/uuid.js';
import { callProviderAISimple, parseLLMJSON } from './aiProvider.js';
import { addNotification, NOTIFICATION_TYPES } from './notifications.js';
import { loadJSON, mutateGoals, GOALS_FILE, DEFAULT_GOALS } from './identity/store.js';

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

export async function runGoalCheckIn({ background = false } = {}) {
  const { getActiveProvider } = await import('./providers.js');
  // This initial load is only to decide WHICH goals to prompt for and to build
  // the LLM prompts — it is never the snapshot that gets saved. The slow LLM
  // calls below can take seconds to minutes, during which the user can add a
  // progress entry or edit a goal; `mutateGoals` re-reads goals.json right
  // before persisting so that concurrent edit survives (#8755).
  const initialGoals = await loadJSON(GOALS_FILE, DEFAULT_GOALS, { strict: true });
  const activeGoals = initialGoals.goals.filter(g => g.status === 'active' && g.targetDate);

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

  // Parallelize LLM calls. `background` provenance comes from the caller: the
  // scheduled fire (executeScriptJob with no `manual`) passes true, so the client
  // coalesces per-provider error toasts — a systematically-failing provider then
  // yields one notification, not one red toast per goal. A manual "Run now" passes
  // false, so its failures report individually, since the user is watching.
  const llmResults = await Promise.all(
    checkInData.map(d => callProviderAISimple(provider, provider.defaultModel, d.prompt, { background }))
  );

  const results = [];
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // Build the check-in records off the snapshot captured before the LLM calls
  // (title/status text only needs to be roughly current), but apply them to a
  // freshly re-read goals document inside `mutateGoals` so a concurrent edit
  // that landed while the LLM calls were in flight isn't clobbered (#8755).
  const checkInsByGoalId = new Map();
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

    checkInsByGoalId.set(d.goal.id, checkIn);
    results.push({ goalId: d.goal.id, title: d.goal.title, status: d.status, checkIn });
  }

  await mutateGoals(goals => {
    for (const goal of goals.goals) {
      const checkIn = checkInsByGoalId.get(goal.id);
      if (!checkIn) continue;
      if (!goal.checkIns) goal.checkIns = [];
      goal.checkIns.push(checkIn);
      goal.updatedAt = now;
    }
    goals.updatedAt = now;
    return goals;
  });

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
