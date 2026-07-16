import { v4 as uuidv4 } from '../../lib/uuid.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getActivities } from '../meatspaceCalendar.js';
import { callProviderAISimple, parseLLMJSON } from '../../lib/aiProvider.js';
import {
  goalTypeEnum,
  goalPhasesProposalSchema,
  goalDecompositionProposalSchema
} from '../../lib/identityValidation.js';
import {
  GOALS_FILE,
  LONGEVITY_FILE,
  DEFAULT_GOALS,
  DEFAULT_LONGEVITY,
  loadJSON,
  saveJSON
} from './store.js';
import { deriveLongevity } from './longevity.js';

// === Pure Functions (exported for testing) ===

function getHorizonYears(horizon, timeHorizons) {
  const map = { '1-year': 1, '3-year': 3, '5-year': 5, '10-year': 10, '20-year': 20, 'lifetime': timeHorizons.yearsRemaining };
  return map[horizon] ?? 5;
}

/**
 * Compute time feasibility for a goal based on its linked activities.
 * Returns { feasible, totalPerWeek, weeksAvailable, links } or null if no links.
 */
export function computeGoalFeasibility(goal, timeHorizons, activities) {
  if (!goal.linkedActivities?.length || !timeHorizons) return null;

  const horizonYears = getHorizonYears(goal.horizon, timeHorizons);
  const weeksAvailable = Math.floor(Math.min(horizonYears, timeHorizons.yearsRemaining) * 52);

  let totalPerWeek = 0;
  const links = [];
  for (const link of goal.linkedActivities) {
    const activity = activities.find(a => a.name === link.activityName);
    if (!activity) continue;
    const freq = link.requiredFrequency ?? activity.frequency;
    // Normalize to per-week
    let perWeek;
    switch (activity.cadence) {
      case 'day': perWeek = freq * 7; break;
      case 'week': perWeek = freq; break;
      case 'month': perWeek = freq / 4.35; break;
      case 'year': perWeek = freq / 52; break;
      default: perWeek = 0;
    }
    totalPerWeek += perWeek;
    const totalOverHorizon = Math.floor(perWeek * weeksAvailable);
    links.push({ activityName: link.activityName, perWeek: Math.round(perWeek * 10) / 10, totalOverHorizon });
  }

  return {
    feasible: weeksAvailable > 0,
    weeksAvailable,
    totalPerWeek: Math.round(totalPerWeek * 10) / 10,
    links
  };
}

export function computeGoalUrgency(goal, timeHorizons) {
  if (!timeHorizons || !goal.horizon) return null;

  const horizonYears = getHorizonYears(goal.horizon, timeHorizons);
  const yearsRemaining = timeHorizons.yearsRemaining;

  if (horizonYears <= 0 || yearsRemaining <= 0) return 1;

  // Urgency: higher when horizon approaches or exceeds remaining years
  // 0 = plenty of time, 1 = urgent
  const rawUrgency = 1 - Math.min(1, yearsRemaining / (horizonYears * 2));
  // Boost urgency for goals whose horizon exceeds remaining healthy years
  const healthPressure = horizonYears > timeHorizons.healthyYearsRemaining ? 0.2 : 0;
  const urgency = Math.min(1, Math.round((rawUrgency + healthPressure) * 100) / 100);

  return urgency;
}

/**
 * Compute velocity (percent/month) and trend from progressHistory.
 * Returns { percentPerMonth, trend, projectedCompletion } or null if insufficient data.
 */
export function computeGoalVelocity(goal) {
  const history = goal.progressHistory;
  if (!history?.length || history.length < 2) return null;

  // Find earliest and latest entries in O(n) instead of sorting
  let first = history[0];
  let last = history[0];
  for (const entry of history) {
    if (entry.date < first.date) first = entry;
    if (entry.date >= last.date) last = entry;
  }

  const daysDiff = (new Date(last.date) - new Date(first.date)) / (1000 * 60 * 60 * 24);
  if (Number.isNaN(daysDiff) || daysDiff < 1) return null;

  const monthsDiff = daysDiff / 30.44;
  const totalChange = last.value - first.value;
  const percentPerMonth = Math.round((totalChange / monthsDiff) * 10) / 10;

  // Trend: compare recent half vs first half velocity using median date
  let trend = 'stable';
  if (history.length >= 4) {
    const midDate = new Date((new Date(first.date).getTime() + new Date(last.date).getTime()) / 2);
    // Find entry closest to midpoint
    let midEntry = first;
    let minDist = Infinity;
    for (const entry of history) {
      const dist = Math.abs(new Date(entry.date) - midDate);
      if (dist < minDist) { minDist = dist; midEntry = entry; }
    }
    const firstHalfDays = (new Date(midEntry.date) - new Date(first.date)) / (1000 * 60 * 60 * 24);
    const secondHalfDays = (new Date(last.date) - new Date(midEntry.date)) / (1000 * 60 * 60 * 24);
    if (firstHalfDays > 0 && secondHalfDays > 0) {
      const firstVel = (midEntry.value - first.value) / firstHalfDays;
      const secondVel = (last.value - midEntry.value) / secondHalfDays;
      if (secondVel > firstVel * 1.2) trend = 'increasing';
      else if (secondVel < firstVel * 0.8) trend = 'decreasing';
    }
  }

  // Projected completion date
  let projectedCompletion = null;
  const remaining = 100 - (goal.progress ?? 0);
  if (percentPerMonth > 0 && remaining > 0) {
    const monthsToGo = remaining / percentPerMonth;
    const projected = new Date();
    projected.setDate(projected.getDate() + Math.round(monthsToGo * 30.44));
    projectedCompletion = projected.toISOString().slice(0, 10);
  }

  return { percentPerMonth, trend, projectedCompletion };
}

/**
 * Compute time tracking stats from progressLog entries.
 * Returns { totalMinutes, weeklyAverage, entriesCount }.
 */
export function computeTimeTracking(goal) {
  const log = goal.progressLog;
  if (!log?.length) return { totalMinutes: 0, weeklyAverage: 0, entriesCount: 0 };

  let totalMinutes = 0;
  let minDate = log[0].date;
  let maxDate = log[0].date;
  for (const e of log) {
    totalMinutes += e.durationMinutes || 0;
    if (e.date < minDate) minDate = e.date;
    if (e.date > maxDate) maxDate = e.date;
  }

  const daySpan = (new Date(maxDate) - new Date(minDate)) / (1000 * 60 * 60 * 24);
  const weeks = Math.max(1, daySpan / 7);
  const weeklyAverage = Math.round(totalMinutes / weeks);

  return { totalMinutes, weeklyAverage, entriesCount: log.length };
}

function hasAncestorCycle(goals, goalId, newParentId) {
  let current = newParentId;
  const visited = new Set();
  while (current) {
    if (current === goalId) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    const parent = goals.find(g => g.id === current);
    current = parent?.parentId || null;
  }
  return false;
}

// === Service Functions ===

export async function getGoals() {
  const data = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  // Lazy migration: backfill parentId, tags, linkedActivities on goals missing them
  let needsSave = false;
  for (const goal of data.goals) {
    if (goal.parentId === undefined) { goal.parentId = null; needsSave = true; }
    if (!Array.isArray(goal.tags)) { goal.tags = []; needsSave = true; }
    if (!Array.isArray(goal.linkedActivities)) { goal.linkedActivities = []; needsSave = true; }
    if (!Array.isArray(goal.linkedCalendars)) { goal.linkedCalendars = []; needsSave = true; }
    if (!Array.isArray(goal.featureAreas)) { goal.featureAreas = []; needsSave = true; }
    if (goal.progress === undefined) { goal.progress = 0; needsSave = true; }
    if (!Array.isArray(goal.progressHistory)) { goal.progressHistory = []; needsSave = true; }
    if (!Array.isArray(goal.todos)) { goal.todos = []; needsSave = true; }
    if (goal.targetDate === undefined) { goal.targetDate = null; needsSave = true; }
    if (goal.timeBlockConfig === undefined) { goal.timeBlockConfig = null; needsSave = true; }
    if (!Array.isArray(goal.scheduledEvents)) { goal.scheduledEvents = []; needsSave = true; }
    if (!Array.isArray(goal.checkIns)) { goal.checkIns = []; needsSave = true; }
    if (!goal.goalType) { goal.goalType = 'standard'; needsSave = true; }
    // Lazy-migrate milestones with description and order
    for (const ms of (goal.milestones || [])) {
      if (ms.description === undefined) { ms.description = ''; needsSave = true; }
      if (ms.order === undefined) { ms.order = 0; needsSave = true; }
      if (!Array.isArray(ms.tasks)) { ms.tasks = []; needsSave = true; }
    }
  }
  if (needsSave) await saveJSON(GOALS_FILE, data);
  return data;
}

export async function setBirthDate(birthDate) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  goals.birthDate = birthDate;
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  // Sync to meatspace config (canonical source), skip goals sync since we just wrote it
  const { updateBirthDate } = await import('../meatspace.js');
  await updateBirthDate(birthDate, { syncGoals: false });

  // Re-derive longevity with new birth date
  const longevity = await deriveLongevity(birthDate);

  // Recalculate urgency for all active goals
  if (longevity.timeHorizons) {
    for (const goal of goals.goals) {
      if (goal.status === 'active') {
        goal.urgency = computeGoalUrgency(goal, longevity.timeHorizons);
      }
    }
    goals.lifeExpectancy = longevity.lifeExpectancy;
    goals.timeHorizons = longevity.timeHorizons;
    await saveJSON(GOALS_FILE, goals);
  }

  return goals;
}

export async function createGoal({ title, description, horizon, category, goalType, parentId, tags, targetDate, timeBlockConfig, featureAreas }) {
  const goals = await getGoals();
  const longevity = await loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY);

  // Validate parentId references an existing goal
  if (parentId && !goals.goals.find(g => g.id === parentId)) {
    throw new ServerError('Parent goal not found', { status: 400, code: 'INVALID_PARENT' });
  }

  const id = `goal-${uuidv4()}`;
  const goal = {
    id,
    title,
    description: description || '',
    horizon: horizon || '5-year',
    category: category || 'mastery',
    goalType: goalType || 'standard',
    parentId: parentId || null,
    tags: [...new Set((tags || []).map(t => t.trim()).filter(Boolean))],
    linkedActivities: [],
    linkedCalendars: [],
    featureAreas: Array.isArray(featureAreas) ? featureAreas : [],
    targetDate: targetDate || null,
    timeBlockConfig: timeBlockConfig || null,
    scheduledEvents: [],
    checkIns: [],
    urgency: null,
    status: 'active',
    milestones: [],
    progress: 0,
    progressHistory: [],
    todos: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Calculate urgency if time horizons available
  if (longevity.timeHorizons) {
    goal.urgency = computeGoalUrgency(goal, longevity.timeHorizons);
  }

  goals.goals.push(goal);
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  console.log(`🎯 Goal created: "${title}" (${horizon}, urgency: ${goal.urgency ?? 'n/a'})`);
  return goal;
}

export async function updateGoal(goalId, updates) {
  const goals = await getGoals();
  const idx = goals.goals.findIndex(g => g.id === goalId);
  if (idx === -1) return null;

  const goal = goals.goals[idx];

  // Validate parentId doesn't create a cycle
  if (updates.parentId !== undefined && updates.parentId !== null) {
    if (!goals.goals.find(g => g.id === updates.parentId)) {
      throw new ServerError('Parent goal not found', { status: 400, code: 'INVALID_PARENT' });
    }
    if (hasAncestorCycle(goals.goals, goalId, updates.parentId)) {
      throw new ServerError('Cannot set parent: would create a cycle', { status: 400, code: 'CYCLE_DETECTED' });
    }
  }

  const allowed = ['title', 'description', 'horizon', 'category', 'goalType', 'status', 'parentId', 'tags', 'targetDate', 'timeBlockConfig', 'featureAreas'];
  for (const key of allowed) {
    if (updates[key] !== undefined) goal[key] = updates[key];
  }
  // Normalize tags: deduplicate and trim
  if (goal.tags) {
    goal.tags = [...new Set(goal.tags.map(t => t.trim()).filter(Boolean))];
  }
  goal.updatedAt = new Date().toISOString();

  // Recalculate urgency if horizon changed
  const longevity = await loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY);
  if (longevity.timeHorizons) {
    goal.urgency = computeGoalUrgency(goal, longevity.timeHorizons);
  }

  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return goal;
}

export async function deleteGoal(goalId) {
  const goals = await getGoals();
  const idx = goals.goals.findIndex(g => g.id === goalId);
  if (idx === -1) return false;

  const deletedGoal = goals.goals[idx];
  // Orphan children: reparent to deleted goal's parent (or root)
  const now = new Date().toISOString();
  for (const goal of goals.goals) {
    if (goal.parentId === goalId) {
      goal.parentId = deletedGoal.parentId || null;
      goal.updatedAt = now;
    }
  }

  goals.goals.splice(idx, 1);
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return true;
}

export async function getGoalsTree() {
  const goals = await getGoals();
  const longevity = await loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY);
  const activities = await getActivities();

  // Enrich goals with urgency, feasibility, velocity, and time tracking
  const enriched = goals.goals.map(goal => {
    const enrichedGoal = { ...goal };
    if (goal.status === 'active' && longevity.timeHorizons) {
      enrichedGoal.urgency = computeGoalUrgency(goal, longevity.timeHorizons);
      enrichedGoal.feasibility = computeGoalFeasibility(goal, longevity.timeHorizons, activities);
    }
    enrichedGoal.velocity = computeGoalVelocity(goal);
    enrichedGoal.timeTracking = computeTimeTracking(goal);
    return enrichedGoal;
  });

  // Build hierarchical tree
  const goalMap = new Map(enriched.map(g => [g.id, { ...g, children: [] }]));
  const roots = [];
  for (const node of goalMap.values()) {
    if (node.parentId && goalMap.has(node.parentId)) {
      goalMap.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Build tag index (deduplicated per tag)
  const tagIndex = {};
  for (const goal of enriched) {
    for (const tag of new Set(goal.tags || [])) {
      if (!tagIndex[tag]) tagIndex[tag] = [];
      tagIndex[tag].push(goal.id);
    }
  }

  return {
    roots,
    flat: enriched,
    tagIndex,
    birthDate: goals.birthDate,
    lifeExpectancy: longevity.lifeExpectancy || goals.lifeExpectancy,
    timeHorizons: longevity.timeHorizons || goals.timeHorizons
  };
}

export async function linkActivity(goalId, { activityName, requiredFrequency, note }) {
  const goals = await getGoals();
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  // Prevent duplicates
  if (goal.linkedActivities.some(l => l.activityName === activityName)) {
    // Update existing link
    const link = goal.linkedActivities.find(l => l.activityName === activityName);
    if (requiredFrequency !== undefined) link.requiredFrequency = requiredFrequency;
    if (note !== undefined) link.note = note;
  } else {
    goal.linkedActivities.push({
      activityName,
      requiredFrequency: requiredFrequency || null,
      note: note || ''
    });
  }
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  console.log(`🔗 Activity "${activityName}" linked to goal "${goal.title}"`);
  return goal;
}

export async function unlinkActivity(goalId, activityName) {
  const goals = await getGoals();
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const idx = goal.linkedActivities.findIndex(l => l.activityName === activityName);
  if (idx === -1) return goal;

  goal.linkedActivities.splice(idx, 1);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  console.log(`🔗 Activity "${activityName}" unlinked from goal "${goal.title}"`);
  return goal;
}

export async function addMilestone(goalId, { title, targetDate }) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const milestone = {
    id: `ms-${uuidv4()}`,
    title,
    targetDate: targetDate || null,
    completedAt: null,
    tasks: [],
    createdAt: new Date().toISOString()
  };

  goal.milestones.push(milestone);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return milestone;
}

export async function addProgressEntry(goalId, { date, note, durationMinutes }) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  if (!goal.progressLog) goal.progressLog = [];

  const entry = {
    id: `prog-${uuidv4()}`,
    date,
    note,
    durationMinutes: durationMinutes || null,
    createdAt: new Date().toISOString()
  };

  goal.progressLog.push(entry);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  console.log(`📝 Progress logged for "${goal.title}": ${note} (${durationMinutes ? durationMinutes + 'min' : 'no duration'})`);
  return entry;
}

export async function deleteProgressEntry(goalId, entryId) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const idx = (goal.progressLog || []).findIndex(e => e.id === entryId);
  if (idx === -1) return null;

  goal.progressLog.splice(idx, 1);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return { deleted: true };
}

export async function completeMilestone(goalId, milestoneId) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const milestone = goal.milestones.find(m => m.id === milestoneId);
  if (!milestone) return null;

  milestone.completedAt = new Date().toISOString();
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return milestone;
}

export async function linkCalendarToGoal(goalId, { subcalendarId, subcalendarName, matchPattern }) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  if (!goal.linkedCalendars) goal.linkedCalendars = [];

  // Prevent duplicates
  const existing = goal.linkedCalendars.find(lc => lc.subcalendarId === subcalendarId);
  if (existing) {
    existing.subcalendarName = subcalendarName;
    existing.matchPattern = matchPattern || '';
  } else {
    goal.linkedCalendars.push({
      subcalendarId,
      subcalendarName,
      matchPattern: matchPattern || '',
      linkedAt: new Date().toISOString()
    });
  }

  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  console.log(`📅 Calendar "${subcalendarName}" linked to goal "${goal.title}"`);
  return goal;
}

export async function unlinkCalendarFromGoal(goalId, subcalendarId) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  if (!goal.linkedCalendars) return goal;
  const idx = goal.linkedCalendars.findIndex(lc => lc.subcalendarId === subcalendarId);
  if (idx === -1) return goal;

  goal.linkedCalendars.splice(idx, 1);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  console.log(`📅 Calendar unlinked from goal "${goal.title}"`);
  return goal;
}

export async function getGoalCalendarEvents(goalId, startDate, endDate) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal || !goal.linkedCalendars?.length) return [];

  const { getEvents } = await import('../calendarSync.js');
  const { events } = await getEvents({ startDate, endDate, limit: 200 });

  const linkedIds = new Set(goal.linkedCalendars.map(lc => lc.subcalendarId));
  const patternMap = {};
  for (const lc of goal.linkedCalendars) {
    patternMap[lc.subcalendarId] = lc.matchPattern;
  }

  return events.filter(e => {
    if (!linkedIds.has(e.subcalendarId)) return false;
    const pattern = patternMap[e.subcalendarId];
    if (!pattern) return true;
    return e.title?.toLowerCase().includes(pattern.toLowerCase());
  });
}

// =============================================================================
// AI Phase Planning
// =============================================================================

// Re-planning (acceptGoalPhases / acceptGoalDecomposition) replaces
// goal.milestones wholesale, which would orphan any goal.scheduledEvents — each
// references an old milestone id AND a live Google Calendar block. Refuse to
// overwrite milestones while scheduled events exist so calendar blocks aren't
// silently stranded; the user unschedules first (removeScheduledEvents /
// rescheduleTimeBlocks). A 409 reject is chosen over auto-deleting here because
// deletion requires live Google OAuth — coupling accept to calendar auth would
// either fail the accept (no token) or silently orphan events if swallowed.
// Applied identically by both accept paths to keep them consistent.
function assertNoScheduledEvents(goal) {
  if (goal.scheduledEvents?.length) {
    throw new ServerError(
      'Goal has scheduled calendar events tied to the current milestones. Unschedule them before re-planning so the calendar blocks are not orphaned.',
      { status: 409, code: 'GOAL_HAS_SCHEDULED_EVENTS' }
    );
  }
}

export async function generateGoalPhases(goalId, { providerId, model } = {}) {
  const { getActiveProvider, getProviderById } = await import('../providers.js');
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  if (!goal.targetDate) throw new ServerError('Goal must have a target date to generate phases', { status: 400, code: 'MISSING_TARGET_DATE' });

  const provider = providerId ? await getProviderById(providerId) : await getActiveProvider();
  if (!provider) throw new ServerError('No AI provider available', { status: 503, code: 'NO_PROVIDER' });
  const selectedModel = model ?? provider.defaultModel;

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are a goal planning assistant. Given a goal with a target completion date, generate 3-7 ordered phases that break this goal into achievable milestones.

Goal title: ${goal.title}
Goal description: ${goal.description || 'No description provided'}
Today's date: ${today}
Target completion date: ${goal.targetDate}

Generate phases that:
- Are ordered chronologically with evenly distributed target dates between now and the target date
- Have clear, actionable titles
- Include brief descriptions of what each phase involves
- The last phase's target date should match or be near the goal's target date

Respond with a JSON array only (no markdown fences, no explanation). Each element must have:
- "title": string (phase name)
- "description": string (1-2 sentences)
- "targetDate": string (YYYY-MM-DD format)
- "order": number (0-based index)`;

  const result = await callProviderAISimple(provider, selectedModel, prompt, { max_tokens: 2000 });
  if (result.error) throw new ServerError(`AI generation failed: ${result.error}`, { status: 502, code: 'AI_ERROR' });

  let parsed;
  try {
    parsed = parseLLMJSON(result.text);
  } catch (e) {
    throw new ServerError(`AI returned invalid phase data: ${e.message}`, { status: 502, code: 'AI_PARSE_ERROR' });
  }
  const validated = goalPhasesProposalSchema.safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.issues[0]?.message || 'shape mismatch';
    throw new ServerError(`AI returned invalid phase data: ${detail}`, { status: 502, code: 'AI_PARSE_ERROR' });
  }

  console.log(`🎯 Generated ${validated.data.length} phases for goal "${goal.title}"`);
  return validated.data;
}

export async function acceptGoalPhases(goalId, phases) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  assertNoScheduledEvents(goal);

  goal.milestones = phases.map((phase, idx) => ({
    id: `ms-${uuidv4()}`,
    title: phase.title,
    description: phase.description || '',
    targetDate: phase.targetDate || null,
    order: phase.order ?? idx,
    completedAt: null,
    tasks: [],
    createdAt: new Date().toISOString()
  }));

  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  console.log(`🎯 Accepted ${phases.length} phases for goal "${goal.title}"`);
  return goal;
}

// =============================================================================
// Goal Decomposition (LLM-powered) — milestones pre-populated with tasks
// =============================================================================

// Builds a single-pass proposal: ordered milestones, each carrying concrete
// tasks. Unlike generateGoalPhases (flat milestones, no tasks) this closes the
// "now hand-add every todo" gap. Returns the proposal WITHOUT persisting so the
// user can review/edit before accept (mirrors generate → accept-phases).
export async function decomposeGoal(goalId, { providerId, model } = {}) {
  const { getActiveProvider, getProviderById } = await import('../providers.js');
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });

  const provider = providerId ? await getProviderById(providerId) : await getActiveProvider();
  if (!provider) throw new ServerError('No AI provider available', { status: 503, code: 'NO_PROVIDER' });
  const selectedModel = model ?? provider.defaultModel;

  const today = new Date().toISOString().slice(0, 10);
  // targetDate is optional for decomposition (relative ordering only) — unlike
  // generateGoalPhases which hard-requires it for date distribution.
  const dateGuidance = goal.targetDate
    ? `Distribute milestone target dates chronologically (YYYY-MM-DD) between today (${today}) and the goal's target date (${goal.targetDate}); the last milestone should land on or near the target date.`
    : `The goal has no target date — order milestones relatively and OMIT the "targetDate" field.`;

  const prompt = `You are a goal decomposition assistant. Break the goal below into an ordered sequence of milestones, each pre-populated with concrete, actionable tasks.

Goal title: ${goal.title}
Goal description: ${goal.description || 'No description provided'}
Today's date: ${today}
${goal.targetDate ? `Target completion date: ${goal.targetDate}` : 'Target completion date: none set'}

Produce 3-7 milestones, each with 2-5 tasks. ${dateGuidance}

Respond with a JSON array only (no markdown fences, no explanation). Each element must have:
- "title": string (milestone name)
- "description": string (1-2 sentences)
${goal.targetDate ? '- "targetDate": string (YYYY-MM-DD format)\n' : ''}- "order": number (0-based index)
- "tasks": array of { "title": string, "priority": "low"|"medium"|"high", "estimateMinutes": number (whole minutes) }`;

  const result = await callProviderAISimple(provider, selectedModel, prompt, { max_tokens: 4000, temperature: 0.4 });
  if (result.error) throw new ServerError(`AI decomposition failed: ${result.error}`, { status: 502, code: 'AI_ERROR' });

  let parsed;
  try {
    parsed = parseLLMJSON(result.text);
  } catch (e) {
    throw new ServerError(`AI returned invalid decomposition data: ${e.message}`, { status: 502, code: 'AI_PARSE_ERROR' });
  }
  const validated = goalDecompositionProposalSchema.safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.issues[0]?.message || 'shape mismatch';
    throw new ServerError(`AI returned invalid decomposition data: ${detail}`, { status: 502, code: 'AI_PARSE_ERROR' });
  }

  const milestones = validated.data;
  const taskCount = milestones.reduce((sum, ms) => sum + ms.tasks.length, 0);
  console.log(`🧩 Decomposed goal "${goal.title}" into ${milestones.length} milestones / ${taskCount} tasks`);
  return milestones;
}

// Persists a reviewed decomposition proposal, normalizing each milestone's
// tasks into the stored shape (mirrors acceptGoalPhases). Overwrites
// goal.milestones — the proposal is the new plan.
export async function acceptGoalDecomposition(goalId, milestones) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  assertNoScheduledEvents(goal);

  const now = new Date().toISOString();
  goal.milestones = milestones.map((ms, idx) => ({
    id: `ms-${uuidv4()}`,
    title: ms.title,
    description: ms.description || '',
    targetDate: ms.targetDate || null,
    order: ms.order ?? idx,
    completedAt: null,
    tasks: (Array.isArray(ms.tasks) ? ms.tasks : []).map(t => ({
      id: `ms-task-${uuidv4()}`,
      title: t.title,
      priority: t.priority || 'medium',
      estimateMinutes: t.estimateMinutes ?? null,
      status: 'pending',
      completedAt: null,
      createdAt: now
    })),
    createdAt: now
  }));

  goal.updatedAt = now;
  goals.updatedAt = now;
  await saveJSON(GOALS_FILE, goals);
  const taskCount = goal.milestones.reduce((sum, ms) => sum + ms.tasks.length, 0);
  console.log(`🧩 Accepted decomposition for "${goal.title}": ${goal.milestones.length} milestones / ${taskCount} tasks`);
  return goal;
}

// Toggles a milestone task's done state (mirrors updateTodo's done/pending flip).
export async function completeMilestoneTask(goalId, milestoneId, taskId) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const milestone = goal.milestones?.find(m => m.id === milestoneId);
  if (!milestone) return null;

  const task = milestone.tasks?.find(t => t.id === taskId);
  if (!task) return null;

  const done = task.status === 'done';
  task.status = done ? 'pending' : 'done';
  task.completedAt = done ? null : new Date().toISOString();
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return task;
}

// =============================================================================
// Goal Hierarchy Organization (LLM-powered)
// =============================================================================

export async function organizeGoals({ providerId, model } = {}) {
  const { getActiveProvider, getProviderById } = await import('../providers.js');
  const goals = await getGoals();
  const activeGoals = goals.goals.filter(g => g.status === 'active');

  if (activeGoals.length < 2) {
    throw new ServerError('Need at least 2 active goals to organize', { status: 400, code: 'TOO_FEW_GOALS' });
  }

  const provider = providerId ? await getProviderById(providerId) : await getActiveProvider();
  if (!provider) throw new ServerError('No AI provider available', { status: 503, code: 'NO_PROVIDER' });
  const selectedModel = model ?? provider.defaultModel;

  const goalSummaries = activeGoals.map(g => ({
    id: g.id,
    title: g.title,
    description: g.description || '',
    horizon: g.horizon,
    category: g.category,
    currentType: g.goalType || 'standard',
    currentParentId: g.parentId
  }));

  const prompt = `You are a life purpose analyst. Given a list of personal goals, analyze them and organize them into a meaningful hierarchy.

Your task:
1. Identify the single APEX goal — the ultimate north-star purpose that all other goals serve. This is the person's deepest "why". If none of the existing goals captures this, suggest one.
2. Identify SUB-APEX goals — major life pillars that directly support the apex goal (e.g., "Stay alive and healthy as long as possible", "Build lasting legacy").
3. Organize remaining goals as STANDARD goals under the appropriate sub-apex or apex parent.
4. Suggest a parentId hierarchy — which goal should be parent of which.

Current goals:
${JSON.stringify(goalSummaries, null, 2)}

Respond with JSON only (no markdown fences). The response must be an object with:
- "apexGoal": { "existingId": string|null, "suggestedTitle": string|null, "suggestedDescription": string|null } — if an existing goal IS the apex, set existingId. If no existing goal fits, suggest a new one.
- "organization": array of { "id": string, "goalType": "apex"|"sub-apex"|"standard", "suggestedParentId": string|null, "reasoning": string }
  - For each existing goal, assign its type and suggested parent.
  - The apex goal has null parentId.
  - Sub-apex goals MUST have suggestedParentId set to the apex goal's existingId (if an existing goal is the apex) or "__new_apex__" (if you are suggesting a new apex goal). Sub-apex goals are never root nodes.
  - Standard goals should have suggestedParentId set to the most appropriate sub-apex goal id, or to the apex goal id if they directly support the apex.
  - The reasoning should be 1 sentence explaining why this goal fits where it does.
- "suggestedSubApex": array of { "title": string, "description": string, "category": string, "suggestedParentId": string|null } — suggest 0-3 sub-apex goals if the existing goals don't cover major life pillars well. Set suggestedParentId to the apex goal's existingId or "__new_apex__" if suggesting a new apex.
- "analysis": string — 2-3 sentences summarizing the person's core purpose and how their goals connect.`;

  const result = await callProviderAISimple(provider, selectedModel, prompt, { max_tokens: 3000, temperature: 0.4 });
  if (result.error) throw new ServerError(`AI organization failed: ${result.error}`, { status: 502, code: 'AI_ERROR' });

  let parsed;
  try {
    parsed = parseLLMJSON(result.text);
  } catch (e) {
    throw new ServerError(`AI returned invalid organization data: ${e.message}`, { status: 502, code: 'AI_PARSE_ERROR' });
  }

  // Validate required shape from LLM response
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.organization)) {
    throw new ServerError('AI returned unexpected shape: missing organization array', { status: 502, code: 'AI_PARSE_ERROR' });
  }
  if (!parsed.apexGoal || typeof parsed.apexGoal !== 'object') {
    throw new ServerError('AI returned unexpected shape: missing apexGoal', { status: 502, code: 'AI_PARSE_ERROR' });
  }

  // Filter organization to only known goal IDs
  const goalIds = new Set(activeGoals.map(g => g.id));
  parsed.organization = parsed.organization.filter(item => item.id && goalIds.has(item.id));

  console.log(`🎯 Organized ${activeGoals.length} goals into hierarchy`);
  return parsed;
}

export async function applyGoalOrganization(organization) {
  const goals = await getGoals();
  const now = new Date().toISOString();
  const goalMap = new Map(goals.goals.map(g => [g.id, g]));
  let changed = 0;

  for (const item of organization) {
    const goal = goalMap.get(item.id);
    if (!goal) continue;

    let goalChanged = false;

    if (item.goalType && goalTypeEnum.options.includes(item.goalType)) {
      if (goal.goalType !== item.goalType) {
        goal.goalType = item.goalType;
        goalChanged = true;
      }
    }
    if (item.suggestedParentId !== undefined) {
      const newParentId = item.suggestedParentId;
      if (newParentId === null || goalMap.has(newParentId)) {
        if (!newParentId || !hasAncestorCycle(goals.goals, goal.id, newParentId)) {
          if (goal.parentId !== newParentId) {
            goal.parentId = newParentId;
            goalChanged = true;
          }
        }
      }
    }
    if (goalChanged) {
      goal.updatedAt = now;
      changed++;
    }
  }

  if (changed > 0) {
    goals.updatedAt = now;
    await saveJSON(GOALS_FILE, goals);
  }
  console.log(`🎯 Applied organization to ${changed} goals`);
  return { applied: changed };
}

// =============================================================================
// Goal AI Check-In
// =============================================================================

export async function checkInGoal(goalId, { providerId, model } = {}) {
  const { getActiveProvider, getProviderById } = await import('../providers.js');
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });

  const provider = providerId ? await getProviderById(providerId) : await getActiveProvider();
  if (!provider) throw new ServerError('No AI provider available', { status: 503, code: 'NO_PROVIDER' });
  const selectedModel = model ?? provider.defaultModel;

  const today = new Date().toISOString().slice(0, 10);
  const velocity = computeGoalVelocity(goal);

  // Calculate expected progress based on creation date and target date
  let expectedProgress = null;
  if (goal.targetDate) {
    const created = new Date(goal.createdAt).getTime();
    const target = new Date(goal.targetDate + 'T00:00:00').getTime();
    const now = Date.now();
    const elapsed = now - created;
    const total = target - created;
    expectedProgress = total > 0 ? Math.min(100, Math.round((elapsed / total) * 100)) : 100;
  }

  // Gather activity attendance if linked activities exist
  let attendanceRate = null;
  if (goal.linkedActivities?.length > 0) {
    const totalRequired = goal.linkedActivities.reduce((sum, a) => sum + (a.requiredFrequency || 1), 0);
    const recentEntries = (goal.progressLog || []).filter(e => {
      const daysAgo = (Date.now() - new Date(e.date + 'T00:00:00').getTime()) / (1000 * 60 * 60 * 24);
      return daysAgo <= 30;
    });
    attendanceRate = totalRequired > 0 ? Math.min(100, Math.round((recentEntries.length / (totalRequired * 4)) * 100)) : null;
  }

  const milestoneSummary = (goal.milestones || []).map(m =>
    `- ${m.title}${m.completedAt ? ' (DONE)' : m.targetDate ? ` (due ${m.targetDate})` : ''}`
  ).join('\n');

  const recentProgress = (goal.progressLog || []).slice(-5).map(e =>
    `- ${e.date}: ${e.note}${e.durationMinutes ? ` (${e.durationMinutes}min)` : ''}`
  ).join('\n');

  const prompt = `You are a goal coaching assistant doing a check-in assessment. Analyze the current state of this goal and provide honest, actionable feedback.

Goal: ${goal.title}
Description: ${goal.description || 'No description'}
Category: ${goal.category}
Horizon: ${goal.horizon}
Current progress: ${goal.progress}%${expectedProgress != null ? `\nExpected progress by now: ${expectedProgress}%` : ''}
Target date: ${goal.targetDate || 'None set'}
Created: ${goal.createdAt?.slice(0, 10)}
Today: ${today}${velocity ? `\nVelocity: ${velocity.percentPerMonth}%/month (${velocity.trend})${velocity.projectedCompletion ? `, projected completion: ${velocity.projectedCompletion}` : ''}` : ''}${attendanceRate != null ? `\nActivity attendance (30 days): ${attendanceRate}%` : ''}
${milestoneSummary ? `\nMilestones:\n${milestoneSummary}` : ''}
${recentProgress ? `\nRecent progress entries:\n${recentProgress}` : '\nNo recent progress logged.'}

Respond with JSON only (no markdown fences). The response must be an object with:
- "status": "on-track" | "behind" | "at-risk" — honest assessment of goal health
- "assessment": string — 2-3 sentence assessment of where things stand
- "recommendations": string[] — 2-4 specific, actionable next steps
- "encouragement": string — 1 brief motivational sentence`;

  const result = await callProviderAISimple(provider, selectedModel, prompt, { max_tokens: 1000, temperature: 0.5 });
  if (result.error) throw new ServerError(`AI check-in failed: ${result.error}`, { status: 502, code: 'AI_ERROR' });

  let parsed;
  try {
    parsed = parseLLMJSON(result.text);
  } catch (e) {
    throw new ServerError(`AI returned invalid check-in data: ${e.message}`, { status: 502, code: 'AI_PARSE_ERROR' });
  }

  const validStatuses = ['on-track', 'behind', 'at-risk'];
  const checkIn = {
    id: `ci-${uuidv4()}`,
    date: today,
    status: validStatuses.includes(parsed.status) ? parsed.status : 'behind',
    actualProgress: goal.progress,
    expectedProgress,
    attendanceRate,
    assessment: parsed.assessment || '',
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 5) : [],
    encouragement: parsed.encouragement || '',
    createdAt: new Date().toISOString()
  };

  if (!Array.isArray(goal.checkIns)) goal.checkIns = [];
  goal.checkIns.push(checkIn);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  console.log(`📋 Check-in for "${goal.title}": ${checkIn.status} (${goal.progress}%${expectedProgress != null ? ` vs ${expectedProgress}% expected` : ''})`);
  return checkIn;
}

// =============================================================================
// Goal Progress Percentage
// =============================================================================

export async function updateGoalProgress(goalId, value) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const prev = goal.progress ?? 0;
  goal.progress = value;
  if (!goal.progressHistory) goal.progressHistory = [];

  // Only log if value changed; deduplicate same-day entries to prevent bloat
  if (prev !== value) {
    const today = new Date().toISOString().slice(0, 10);
    const lastEntry = goal.progressHistory[goal.progressHistory.length - 1];
    if (lastEntry?.date === today) {
      lastEntry.value = value;
      lastEntry.timestamp = new Date().toISOString();
    } else {
      goal.progressHistory.push({ date: today, value, timestamp: new Date().toISOString() });
    }
  }

  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  console.log(`📊 Progress for "${goal.title}": ${prev}% → ${value}%`);
  return goal;
}
