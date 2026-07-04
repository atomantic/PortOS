/**
 * Flip the frozen old `issueAuthorFilter: 'owner'` default → `'self'` for the
 * global `claim-issue` / `claim-work` schedule entries.
 *
 * Background: slashdo v3.19.0 added the `/do:next --self` security boundary
 * (only claim issues YOU filed — `@me` — never act on work embedded in a third
 * party's issue), and PortOS adopted `'self'` as the new default for forge
 * issue-claiming (`server/services/taskSchedule.js` DEFAULT_TASK_INTERVALS,
 * `cosTaskGenerator.js`, `perpetualWork.js`). But `loadSchedule()` merges
 * stored taskMetadata OVER the code default, and any install that ever saved
 * the schedule froze the *then-default* `issueAuthorFilter: 'owner'` onto disk
 * in `data/task-schedule.json`. Those installs would never pick up the new
 * `'self'` default from code alone.
 *
 * This migration rewrites a stored `'owner'` (the prior default) to `'self'`
 * for the two global forge-claim task types only. It is deliberately narrow:
 *   - Only `'owner'` is touched — `'any'` is the one value a user could only
 *     have chosen on purpose (it was never a default), so it is preserved.
 *   - Only the GLOBAL schedule is migrated. Per-app overrides
 *     (`taskTypeOverrides`) are written ONLY when the user explicitly picks a
 *     non-inherit value in the app-management UI, so an app-level `'owner'` is a
 *     deliberate choice and is left untouched.
 * Idempotent: a re-run finds `'self'` (or no stored filter) and makes no change.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const SCHEDULE_REL_PATH = 'data/task-schedule.json';
const TARGET_TASK_TYPES = ['claim-issue', 'claim-work'];
const OLD_DEFAULT = 'owner';
const NEW_DEFAULT = 'self';

export default {
  async up({ rootDir }) {
    const schedulePath = join(rootDir, SCHEDULE_REL_PATH);
    const raw = await readFile(schedulePath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${SCHEDULE_REL_PATH} not present — skipping (fresh install defaults to '${NEW_DEFAULT}')`);
      return { updated: 0, reason: 'no-schedule-file' };
    }

    let schedule;
    try {
      schedule = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${SCHEDULE_REL_PATH}: invalid JSON, skipping (${err.message})`);
      return { updated: 0, reason: 'invalid-json' };
    }

    const tasks = schedule?.tasks;
    if (!tasks || typeof tasks !== 'object') {
      console.log(`⚠️ ${SCHEDULE_REL_PATH}: no tasks map, skipping`);
      return { updated: 0, reason: 'no-tasks' };
    }

    let touched = 0;
    for (const taskType of TARGET_TASK_TYPES) {
      const meta = tasks[taskType]?.taskMetadata;
      if (meta && typeof meta === 'object' && meta.issueAuthorFilter === OLD_DEFAULT) {
        meta.issueAuthorFilter = NEW_DEFAULT;
        touched += 1;
        console.log(`📝 ${SCHEDULE_REL_PATH}: ${taskType} issueAuthorFilter '${OLD_DEFAULT}' → '${NEW_DEFAULT}'`);
      }
    }

    if (touched === 0) {
      console.log(`✅ ${SCHEDULE_REL_PATH}: no frozen '${OLD_DEFAULT}' issue-author filters — no change`);
      return { updated: 0, reason: 'already-applied' };
    }

    await writeFile(schedulePath, `${JSON.stringify(schedule, null, 2)}\n`);
    return { updated: touched };
  },
};
