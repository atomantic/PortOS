/**
 * Update the scheduled release-check task prompt to v9 (reconciling unpublished releases).
 *
 * This migration checks data/cos/task-schedule.json (and data/task-schedule.json)
 * to ensure stored task prompt versions for release-check upgrade to v9 when uncustomized.
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

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export default {
  async up({ rootDir }) {
    let updatedCount = 0;
    for (const relPath of SCHEDULE_PATHS) {
      const fullPath = join(rootDir, relPath);
      const schedule = await readJson(fullPath);
      if (!schedule?.tasks?.['release-check']) continue;

      const task = schedule.tasks['release-check'];
      const currentVersion = task.promptVersion || 1;
      if (!task.promptCustomized && currentVersion < PROMPT_VERSIONS['do-release']) {
        task.prompt = DEFAULT_TASK_PROMPTS['do-release'];
        task.promptVersion = PROMPT_VERSIONS['do-release'];
        await writeJson(fullPath, schedule);
        updatedCount += 1;
        console.log(`📝 ${relPath}: upgraded release-check prompt v${currentVersion} → v${PROMPT_VERSIONS['do-release']}`);
      }
    }
    return { updated: updatedCount };
  },
};
