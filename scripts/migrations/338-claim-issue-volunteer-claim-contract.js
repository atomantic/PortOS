/**
 * Upgrade the scheduled claim-issue prompt to v25, where handing an issue to a
 * human volunteer writes the same forge state PortOS's deterministic
 * issue-watcher writes for the same event — assignee + `in-progress` + the
 * contributor invitations retired — instead of the exact opposite.
 *
 * Existing installs persist task prompts under data/cos/task-schedule.json (and
 * older installs may still use data/task-schedule.json). Customized prompts
 * remain untouched.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { DEFAULT_TASK_PROMPTS, PROMPT_VERSIONS } from '../../server/services/taskPromptDefaults.js';

const TASK_TYPE = 'claim-issue';

const SCHEDULE_PATHS = [
  join('data', 'cos', 'task-schedule.json'),
  join('data', 'task-schedule.json'),
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
      const task = schedule?.tasks?.[TASK_TYPE];
      if (!task) continue;

      const currentVersion = task.promptVersion || 1;
      if (task.promptCustomized || currentVersion >= PROMPT_VERSIONS[TASK_TYPE]) continue;

      task.prompt = DEFAULT_TASK_PROMPTS[TASK_TYPE];
      task.promptVersion = PROMPT_VERSIONS[TASK_TYPE];
      await writeFile(fullPath, `${JSON.stringify(schedule, null, 2)}\n`);
      updatedCount += 1;
      console.log(`📝 ${relPath}: upgraded ${TASK_TYPE} prompt v${currentVersion} → v${PROMPT_VERSIONS[TASK_TYPE]}`);
    }
    return { updated: updatedCount };
  },
};
