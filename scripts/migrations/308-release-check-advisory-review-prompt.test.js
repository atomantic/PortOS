import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './308-release-check-advisory-review-prompt.js';
import { DEFAULT_TASK_PROMPTS, PROMPT_VERSIONS, PREVIOUS_DEFAULT_PROMPTS } from '../../server/services/taskPromptDefaults.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const oldPrompt = PREVIOUS_DEFAULT_PROMPTS['release-check'].at(-1);

describe('migration 308 — make release-check review advisory', () => {
  let rootDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-308-'));
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
        'release-check': { promptVersion: 11, promptCustomized: false, prompt: oldPrompt },
        custom: { promptVersion: 11, promptCustomized: true, prompt: 'keep this' },
      },
    });
    writeJson(legacyPath, {
      tasks: {
        'release-check': { promptVersion: 11, promptCustomized: false, prompt: oldPrompt },
      },
    });

    const result = await migration.up({ rootDir });

    expect(result.updated).toBe(2);
    expect(readJson(cosPath).tasks['release-check']).toEqual({
      promptVersion: PROMPT_VERSIONS['release-check'],
      promptCustomized: false,
      prompt: DEFAULT_TASK_PROMPTS['release-check'],
    });
    expect(readJson(cosPath).tasks.custom).toEqual({
      promptVersion: 11,
      promptCustomized: true,
      prompt: 'keep this',
    });
    expect(readJson(legacyPath).tasks['release-check'].prompt).toBe(DEFAULT_TASK_PROMPTS['release-check']);
  });

  it('does not rewrite a current or customized prompt', async () => {
    const path = join(rootDir, 'data', 'cos', 'task-schedule.json');
    writeJson(path, {
      tasks: {
        current: { promptVersion: PROMPT_VERSIONS['release-check'], promptCustomized: false, prompt: DEFAULT_TASK_PROMPTS['release-check'] },
        custom: { promptVersion: 11, promptCustomized: true, prompt: 'custom release policy' },
      },
    });

    const result = await migration.up({ rootDir });

    expect(result.updated).toBe(0);
    expect(readJson(path).tasks.custom.prompt).toBe('custom release policy');
  });
});
