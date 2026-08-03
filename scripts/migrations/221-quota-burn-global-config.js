/**
 * Migration 221 — move quota-burn from a per-app scheduled task type to ONE
 * install-level burn plan.
 *
 * Background:
 *   Quota-burn used to be a `quota-burn` entry in each managed app's
 *   `taskTypeOverrides`, so its provider-family plan (prompt, reset window,
 *   reserve, dispatch cap) was duplicated per app even though the quota it
 *   spends belongs to the MACHINE, not to any one repo. Two enabled apps meant
 *   two independent loops racing for the same window budget.
 *
 *   It is now one loop in PortOS (`server/services/quotaBurnRunner.js`) reading
 *   one machine-local plan at `data/cos/quota-burn.json`. The work can still
 *   target a managed app — that is now a per-JOB `appId` rather than the app
 *   owning the schedule.
 *
 * What it writes:
 *   - `data/cos/quota-burn.json` — one family entry per configured family,
 *     carrying the old window/reserve/cap/priority settings verbatim. Each
 *     family's old free-text `prompt` becomes a single `agent-prompt` job
 *     pointing at the app whose override it came from, so an install's existing
 *     burn keeps doing exactly what it did.
 *   - `data/apps.json` — the `quota-burn` key is removed from every app's
 *     `taskTypeOverrides`. The task type no longer exists; leaving it behind
 *     would show a dead row in the CoS schedule UI.
 *   - `data/cos/task-schedule.json` — the `quota-burn` entry is removed from
 *     `tasks`. `loadSchedule` deliberately PRESERVES persisted task types that
 *     are no longer in the defaults, so without this the install-wide schedule
 *     would keep offering a type with no detector, no prompt, and no hooks.
 *
 * Conflicts: when two apps configured the SAME family, the first app in file
 * order supplies the family-level window settings and BOTH prompts survive as
 * two ordered jobs. Dropping one would silently lose configured work; merging
 * the windows would invent a setting the user never chose.
 *
 * `enabled` is deliberately carried over as-is: an install that had quota-burn
 * running keeps running it (no surprise stop), and one that never enabled it
 * stays silent. The migration itself makes NO provider calls.
 *
 * Idempotent: once no app carries a `quota-burn` override there is nothing to
 * read, and an existing `quota-burn.json` is never overwritten.
 */

import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';

const FAMILIES = ['claude', 'codex', 'agy', 'grok'];

const readJson = async (abs) => {
  const raw = await readFile(abs, 'utf-8').catch((err) => { if (err.code === 'ENOENT') return null; throw err; });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const writeJsonAtomic = async (abs, value) => {
  const tmp = `${abs}.tmp-221`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, abs);
};

/**
 * Fold every app's `taskTypeOverrides['quota-burn'].taskMetadata.families` into
 * one plan. Pure — exported for the test.
 *
 * @param {Array<{id: string, name?: string, taskTypeOverrides?: object}>} apps
 * @returns {{ config: object|null, touchedAppIds: string[] }} `config` is null
 *   when no app configured a family (nothing to migrate).
 */
export function buildGlobalPlan(apps) {
  const families = {};
  const touchedAppIds = [];
  let jobSeq = 0;
  for (const app of apps) {
    const override = app?.taskTypeOverrides?.['quota-burn'];
    if (!override) continue;
    touchedAppIds.push(app.id);
    const configured = override.taskMetadata?.families;
    if (!configured || typeof configured !== 'object') continue;
    // The OLD shape had TWO independent switches: the task type had to be
    // enabled for the app (`isTaskTypeEnabledForApp` reads `override.enabled`)
    // AND the family had to be enabled inside `taskMetadata.families`. Reading
    // only the family flag would arm a burn on an install that configured a
    // family, tried it, then switched the whole task type off — unrequested
    // provider spend on upgrade. Both must be true.
    const appArmed = override.enabled === true;
    for (const [familyId, value] of Object.entries(configured)) {
      if (!FAMILIES.includes(familyId) || !value || typeof value !== 'object') continue;
      const armed = appArmed && value.enabled === true;
      const existing = families[familyId];
      const jobs = existing?.jobs || [];
      const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
      if (prompt) {
        jobSeq += 1;
        jobs.push({
          id: `migrated-${jobSeq}`,
          // A job carried over from an app whose burn was OFF stays off, so a
          // family armed by a different app doesn't start running this app's
          // prompt as a side effect of the merge.
          enabled: armed,
          label: `${app.name || app.id} burn work`,
          jobType: 'agent-prompt',
          // The family-level `model` was the agent's model in the old shape;
          // it becomes the job's, since model choice is now per job.
          model: value.model || null,
          providerId: null,
          params: {
            appId: app.id,
            prompt,
            useWorktree: override.taskMetadata?.useWorktree !== false,
            openPR: override.taskMetadata?.openPR !== false,
            simplify: override.taskMetadata?.simplify !== false,
          },
        });
      }
      const windowSettings = {
        providerId: value.providerId || null,
        scope: typeof value.scope === 'string' ? value.scope : null,
        resetWithinHours: Number.isFinite(Number(value.resetWithinHours)) ? Number(value.resetWithinHours) : 24,
        reservePercent: Number.isFinite(Number(value.reservePercent)) ? Number(value.reservePercent) : 0,
        maxDispatchesPerWindow: Number.isFinite(Number(value.maxDispatchesPerWindow)) ? Number(value.maxDispatchesPerWindow) : 5,
        priority: Number.isFinite(Number(value.priority)) ? Number(value.priority) : 0,
      };
      if (!existing) {
        families[familyId] = { enabled: armed, ...windowSettings, jobs };
        continue;
      }
      // Two apps configured the same family. `enabled` is OR'd — an install
      // that had this family burning keeps burning it, regardless of which app
      // happens to come first in apps.json. The window settings come from the
      // first ARMED contributor (falling back to the first contributor at all),
      // so a stale disabled config can't quietly halve a live cap.
      families[familyId] = {
        ...existing,
        ...(armed && !existing.enabled ? windowSettings : {}),
        enabled: existing.enabled || armed,
        jobs,
      };
    }
  }
  if (!Object.keys(families).length) return { config: null, touchedAppIds };
  return {
    config: {
      // Master switch on only when at least one family was actually armed — an
      // install that configured but never enabled a family stays silent.
      enabled: Object.values(families).some((family) => family.enabled === true),
      // The old shape re-probed on `recheckCron: '0 */12 * * *'`. Carrying that
      // cadence across (rather than the new 30-minute default) keeps an
      // upgraded install at ~2 provider scrapes a day instead of 48 — each of
      // which spawns a multi-second TUI child per enabled family.
      checkIntervalMinutes: 720,
      families,
    },
    touchedAppIds,
  };
}

/**
 * Drop the dead `quota-burn` entry from the install-wide schedule file. Runs
 * even when no app carried an override — an install could have flipped the type
 * on globally and never scoped it to an app.
 */
async function pruneScheduleFile(rootDir) {
  const scheduleFile = join(rootDir, 'data', 'cos', 'task-schedule.json');
  const schedule = await readJson(scheduleFile);
  if (!schedule?.tasks || !Object.hasOwn(schedule.tasks, 'quota-burn')) return false;
  const { 'quota-burn': _dropped, ...tasks } = schedule.tasks;
  await writeJsonAtomic(scheduleFile, { ...schedule, tasks });
  console.log('🔥 migration 221: removed the dead quota-burn entry from the CoS schedule');
  return true;
}

export default {
  async up({ rootDir }) {
    const prunedSchedule = await pruneScheduleFile(rootDir);
    const appsFile = join(rootDir, 'data', 'apps.json');
    const data = await readJson(appsFile);
    const appsMap = data?.apps && typeof data.apps === 'object' ? data.apps : null;
    if (!appsMap) {
      console.log('🔥 migration 221: no data/apps.json — fresh install, no-op');
      return { ok: true, reason: 'no-apps', prunedSchedule };
    }

    const apps = Object.entries(appsMap).map(([id, app]) => ({ id, ...app }));
    const { config, touchedAppIds } = buildGlobalPlan(apps);
    if (!touchedAppIds.length) {
      console.log('🔥 migration 221: no app carries a quota-burn override — nothing to migrate');
      return { ok: true, reason: 'no-overrides', prunedSchedule };
    }

    const cosDir = join(rootDir, 'data', 'cos');
    const configFile = join(cosDir, 'quota-burn.json');
    if (config) {
      const existing = await readJson(configFile);
      if (existing) {
        console.log('🔥 migration 221: data/cos/quota-burn.json already exists — leaving it as-is');
      } else {
        await mkdir(cosDir, { recursive: true });
        await writeJsonAtomic(configFile, config);
        const count = Object.keys(config.families).length;
        console.log(`🔥 migration 221: wrote a global burn plan with ${count} famil${count === 1 ? 'y' : 'ies'}`);
      }
    }

    for (const id of touchedAppIds) {
      const { 'quota-burn': _dropped, ...rest } = appsMap[id].taskTypeOverrides || {};
      appsMap[id] = { ...appsMap[id], taskTypeOverrides: rest };
    }
    await writeJsonAtomic(appsFile, { ...data, apps: appsMap });
    console.log(`🔥 migration 221: removed the quota-burn task-type override from ${touchedAppIds.length} app(s)`);
    return { ok: true, apps: touchedAppIds.length, prunedSchedule };
  },
};
