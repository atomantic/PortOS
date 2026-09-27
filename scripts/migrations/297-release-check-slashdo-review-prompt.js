/**
 * Upgrade the scheduled release-check prompt to the slashdo-backed v11 flow.
 *
 * Existing installs persist task prompts under data/cos/task-schedule.json (and
 * older installs may still use data/task-schedule.json). The prompt-version
 * loader handles this on read, but the explicit migration updates both files at
 * install time so the stored schedule and the runtime default converge together.
 * Customized prompts remain untouched.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { DEFAULT_TASK_PROMPTS, PROMPT_VERSIONS } from '../../server/services/taskPromptDefaults.js';

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
      const task = schedule?.tasks?.['release-check'];
      if (!task) continue;

      const currentVersion = task.promptVersion || 1;
      if (task.promptCustomized || currentVersion >= PROMPT_VERSIONS['do-release']) continue;

      task.prompt = DEFAULT_TASK_PROMPTS['do-release'];
      task.promptVersion = PROMPT_VERSIONS['do-release'];
      await writeFile(fullPath, `${JSON.stringify(schedule, null, 2)}\n`);
      updatedCount += 1;
      console.log(`📝 ${relPath}: upgraded release-check prompt v${currentVersion} → v${PROMPT_VERSIONS['do-release']}`);
    }
    return { updated: updatedCount };
  },
};
