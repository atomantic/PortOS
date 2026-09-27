import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './297-release-check-slashdo-review-prompt.js';
import { DEFAULT_TASK_PROMPTS, PROMPT_VERSIONS } from '../../server/services/taskPromptDefaults.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 297 — upgrade release-check task prompt to the slashdo-backed reviewer flow', () => {
  let rootDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-297-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('updates both supported schedule locations and leaves custom prompts alone', async () => {
    const cosPath = join(rootDir, 'data', 'cos', 'task-schedule.json');
    const legacyPath = join(rootDir, 'data', 'task-schedule.json');
    writeJson(cosPath, {
      tasks: {
        'release-check': { promptVersion: 10, promptCustomized: false, prompt: 'old v10' },
        custom: { promptVersion: 10, promptCustomized: true, prompt: 'keep this' },
      },
    });
    writeJson(legacyPath, {
      tasks: {
        'release-check': { promptVersion: 10, promptCustomized: false, prompt: 'old v10' },
      },
    });

    const result = await migration.up({ rootDir });

    expect(result.updated).toBe(2);
    expect(readJson(cosPath).tasks['release-check']).toEqual({
      promptVersion: PROMPT_VERSIONS['do-release'],
      promptCustomized: false,
      prompt: DEFAULT_TASK_PROMPTS['do-release'],
    });
    expect(readJson(cosPath).tasks.custom).toEqual({
      promptVersion: 10,
      promptCustomized: true,
      prompt: 'keep this',
    });
    expect(readJson(legacyPath).tasks['release-check'].prompt).toBe(DEFAULT_TASK_PROMPTS['do-release']);
  });

  it('does not create a schedule when neither location exists', async () => {
    const result = await migration.up({ rootDir });

    expect(result.updated).toBe(0);
    expect(existsSync(join(rootDir, 'data', 'cos', 'task-schedule.json'))).toBe(false);
  });
});
