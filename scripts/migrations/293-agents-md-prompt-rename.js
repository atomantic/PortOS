/**
 * Upgrade the scheduled task prompts that name the agent-instructions file (#4852).
 *
 * AGENTS.md is now the canonical cross-vendor name, so seven shipped defaults
 * changed from "read CLAUDE.md" to "read AGENTS.md (or CLAUDE.md)". Existing
 * installs carry their own copy in data/cos/task-schedule.json, so this walks the
 * stored schedule and upgrades every affected task whose prompt is still an
 * unmodified default (promptCustomized !== true) — the same rule the auto-upgrade
 * on read applies. A user-edited prompt is left alone.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { DEFAULT_TASK_PROMPTS, PROMPT_VERSIONS } from '../../server/services/taskPromptDefaults.js';
import { currentTaskTypeName } from '../../server/lib/scheduledTaskTypes.js';

const SCHEDULE_PATHS = [
  join('data', 'cos', 'task-schedule.json'),
  join('data', 'task-schedule.json'),
];

const TASK_KEYS = [
  'documentation',
  'plan-task',
  'claim-issue',
  'claim-issue-gitlab',
  'claim-issue-jira',
  'release-check',
  'stash-cleanup',
];

async function readJson(path) {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default {
  async up({ rootDir }) {
    let updatedCount = 0;
    for (const relPath of SCHEDULE_PATHS) {
      const fullPath = join(rootDir, relPath);
      const schedule = await readJson(fullPath);
      if (!schedule?.tasks) continue;

      let dirty = false;
      for (const key of TASK_KEYS) {
        const task = schedule.tasks[key];
        if (!task) continue;
        // release-check was renamed do-release; migration 417 moves the task later.
        const promptKey = currentTaskTypeName(key);
        const currentVersion = task.promptVersion || 1;
        if (task.promptCustomized || currentVersion >= PROMPT_VERSIONS[promptKey]) continue;
        task.prompt = DEFAULT_TASK_PROMPTS[promptKey];
        task.promptVersion = PROMPT_VERSIONS[promptKey];
        dirty = true;
        updatedCount += 1;
        console.log(`📝 ${relPath}: upgraded ${key} prompt v${currentVersion} → v${PROMPT_VERSIONS[promptKey]}`);
      }
      if (dirty) await writeFile(fullPath, `${JSON.stringify(schedule, null, 2)}\n`);
    }
    return { updated: updatedCount };
  },
};
