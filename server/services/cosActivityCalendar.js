/**
 * CoS Activity Calendar
 *
 * The GitHub-style "runs per day" heatmap behind the dashboard widget and the
 * Eidoverse activity district.
 *
 * Derived on every read from the two stores that agent history actually lives
 * in — the id→date-bucket index (`data/cos/agents/index.json`, maintained by
 * `archiveStaleAgents`) plus the completed agents still resident in
 * `state.agents` — so it is correct the moment a run finishes. Both are
 * process-cached (`loadAgentIndex` memoizes, `loadState` holds `stateCache`),
 * so the widget's 30-second poll costs no disk I/O.
 *
 * It replaces the `data/cos/productivity.json` aggregate this used to read
 * (#7599). That file had no automatic writer: nothing in the server called the
 * incremental updater, so it only changed when a human opened the retired
 * Productivity page and pressed Refresh. On this repo's own install it had gone
 * four months without a write, which made every heatmap cell read zero.
 *
 * ## What a cell counts
 *
 * Every completed agent record, with no outcome filtering of any kind: not
 * success vs failure, and not the `isAgentHandoff` continuation rule that the
 * daily report and weekly digest apply.
 *
 * That is deliberate, and it is the only self-consistent choice available here.
 * The index stores a date per agent id and nothing else, so an outcome rule
 * could only ever be evaluated against the records still in `state.agents` —
 * roughly the last 24 hours, per `completedAgentRetentionMs`. Applying it there
 * and not to the archive would drop a provider swap from today's cell while
 * counting it in all ~90 older ones, so the grid would disagree with itself
 * along a moving 24-hour line. Answering properly for the archive means opening
 * every record's `metadata.json` — hundreds of files on a 30-second poll.
 *
 * So this is a VOLUME signal — how much ran on each day — and it is honest
 * about being one. Outcome is reported live and exactly by the Today and
 * Learning tiles beside the heatmap, which read `getTodayActivity` and task
 * learning rather than this grid.
 */

import { loadState } from './cosState.js';
import { loadAgentIndex } from './cosAgentIndex.js';

/**
 * Day key for an instant, in UTC.
 *
 * UTC, not server-local, because that is what every other CoS agent-history day
 * key already is: `archiveStaleAgents` buckets a record under
 * `completedAt.slice(0, 10)`, and `getTodayActivity` / `generateReport` ask for
 * a day with `toISOString().split('T')[0]`. Keying the grid locally instead
 * would file a run in one cell and look for it in another on any install not
 * running `TZ=UTC`.
 */
const dayKey = (date) => date.toISOString().slice(0, 10);

const MS_PER_DAY = 86400000;

/**
 * Completed runs per day, from `sinceStr` forward, across both stores.
 *
 * Live state is walked FIRST so its ids can be collected into a set the index
 * pass skips. That direction matters: a record caught mid-archive is in both
 * stores at once (`archiveStaleAgents` indexes it before evicting it from
 * state), and deduping the other way round would mean copying the whole index —
 * thousands of entries on an aged install — to overwrite a few dozen keys.
 *
 * Days before `sinceStr` are dropped as they are read rather than counted and
 * discarded later; the index spans an install's entire history while the grid
 * only ever asks for the last few weeks of it.
 *
 * `getAgentDates()` tallies the same index, but cannot be used here: it returns
 * `{date, count}` with the ids discarded, and the ids are exactly what the
 * live-state dedupe needs.
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
 * Activity calendar for the last N weeks, as a Sunday-aligned grid of exactly N
 * whole weeks ending with the current one.
 *
 * @param {number} weeks - How many weeks of history to include (default 12)
 */
export async function getActivityCalendar(weeks = 12) {
  const today = new Date();
  const todayStr = dayKey(today);

  // Sunday of the current week, then back N-1 whole weeks — so the grid is
  // exactly `weeks` columns wide whatever weekday it is read on.
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - today.getUTCDay() - (weeks - 1) * 7);
  start.setUTCHours(0, 0, 0, 0);

  const counts = await countRunsByDate(dayKey(start));

  const days = [];
  let maxTasks = 1;
  let activeDays = 0;
  let totalTasks = 0;

  for (let i = 0; i < weeks * 7; i++) {
    const date = dayKey(new Date(start.getTime() + i * MS_PER_DAY));
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
