/**
 * CoS Activity Calendar: the "runs per day" heatmap behind the dashboard widget and the Eidoverse activity district.
 *
 * Derived on every read from the id->date index (`data/cos/agents/index.json`, kept by `archiveStaleAgents`)
 * plus completed agents still in `state.agents`; both are process-cached, so reads cost no disk I/O.
 * (Replaces the `data/cos/productivity.json` aggregate, which had no automatic writer; #7599.)
 *
 * A cell counts every completed agent record, with no outcome filtering and no `isAgentHandoff` rule.
 * The index stores only a date per id, so an outcome rule could be applied only to records still in
 * `state.agents` (~24h) and the grid would disagree with itself along that moving line; doing it for the
 * archive means opening every `metadata.json` on a 30-second poll. It is a VOLUME signal; the Today and
 * Learning tiles report outcome.
 */

import { scheduleDashboardExpiry } from '../dashboardEvents.js';
import { loadState } from './cosState.js';
import { loadAgentIndex } from './cosAgentIndex.js';

/**
 * Day key for an instant, in UTC: the same key `archiveStaleAgents`, `getTodayActivity` and `generateReport`
 * use, so keying locally would file a run in one cell and look for it in another off `TZ=UTC`.
 */
const dayKey = (date) => date.toISOString().slice(0, 10);

/**
 * Completed runs per day, from `sinceStr` forward, across both stores.
 *
 * Live state is walked FIRST so its ids can seed a set the index pass skips: a record caught mid-archive is
 * in both stores (`archiveStaleAgents` indexes it before evicting it), and deduping the other way would
 * copy the whole index. Days before `sinceStr` are dropped as read. `getAgentDates()` can't be used: it
 * discards the ids the live-state dedupe needs.
 */
async function countRunsByDate(sinceStr) {
  const [index, state] = await Promise.all([loadAgentIndex(), loadState()]);
  const counts = new Map();
  const liveIds = new Set();

  const count = (date) => {
    if (date >= sinceStr) counts.set(date, (counts.get(date) || 0) + 1);
  };

  for (const agent of Object.values(state.agents || {})) {
    if (agent.status !== 'completed' || !agent.completedAt) continue;
    liveIds.add(agent.id);
    count(agent.completedAt.slice(0, 10));
  }

  for (const [agentId, date] of index) {
    if (liveIds.has(agentId)) continue;
    count(date);
  }

  return counts;
}

/**
 * Activity calendar for the last N weeks, as a Sunday-aligned grid of exactly N whole weeks ending with the current one.
 * @param {number} weeks - How many weeks of history to include (default 12)
 */
export async function getActivityCalendar(weeks = 12) {
  const today = new Date();
  const todayStr = dayKey(today);
  const nextDay = new Date(today);
  nextDay.setUTCHours(24, 0, 0, 0);
  scheduleDashboardExpiry('cos:day:changed', nextDay.getTime());

  // Sunday of the current week, then back N-1 whole weeks, so the grid is exactly `weeks` columns wide.
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - today.getUTCDay() - (weeks - 1) * 7);
  start.setUTCHours(0, 0, 0, 0);

  const counts = await countRunsByDate(dayKey(start));

  const days = [];
  let maxTasks = 1;
  let activeDays = 0;
  let totalTasks = 0;

  for (let i = 0; i < weeks * 7; i++) {
    // Calendar arithmetic, not epoch-ms stepping: says "the i-th day after start" directly.
    const cursor = new Date(start);
    cursor.setUTCDate(start.getUTCDate() + i);
    const date = dayKey(cursor);
    const isFuture = date > todayStr;
    const tasks = isFuture ? 0 : (counts.get(date) || 0);

    if (tasks > 0) {
      activeDays++;
      totalTasks += tasks;
      if (tasks > maxTasks) maxTasks = tasks;
    }

    days.push({ date, dayOfWeek: i % 7, tasks, isToday: date === todayStr, isFuture });
  }

  const calendar = [];
  for (let i = 0; i < days.length; i += 7) calendar.push(days.slice(i, i + 7));

  return {
    weeks: calendar,
    maxTasks,
    summary: {
      activeDays,
      totalTasks,
      avgTasksPerActiveDay: activeDays > 0 ? Math.round((totalTasks / activeDays) * 10) / 10 : 0
    }
  };
}
