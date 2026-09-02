import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './332-release-check-fix-blockers-prompt.js';
import { DEFAULT_TASK_PROMPTS, PROMPT_VERSIONS, PREVIOUS_DEFAULT_PROMPTS } from '../../server/services/taskPromptDefaults.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const oldPrompt = PREVIOUS_DEFAULT_PROMPTS['release-check'].at(-1);

describe('migration 332 — make release-check fix release blockers', () => {
  let rootDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-332-'));
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
        'release-check': { promptVersion: 12, promptCustomized: false, prompt: oldPrompt },
        custom: { promptVersion: 12, promptCustomized: true, prompt: 'keep this' },
      },
    });
    writeJson(legacyPath, {
      tasks: {
        'release-check': { promptVersion: 12, promptCustomized: false, prompt: oldPrompt },
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
      promptVersion: 12,
      promptCustomized: true,
      prompt: 'keep this',
    });
    expect(readJson(legacyPath).tasks['release-check'].prompt).toBe(DEFAULT_TASK_PROMPTS['release-check']);
  });

  // Both guards are keyed on the 'release-check' task itself, so the mocks must be
  // stored under that key — a task keyed anything else is skipped before either
  // guard runs, and `updated === 0` would then pass without exercising them.
  it('does not rewrite a current or customized release-check prompt', async () => {
    const cosPath = join(rootDir, 'data', 'cos', 'task-schedule.json');
    const legacyPath = join(rootDir, 'data', 'task-schedule.json');
    writeJson(cosPath, {
      tasks: {
        'release-check': {
          promptVersion: PROMPT_VERSIONS['release-check'],
          promptCustomized: false,
          prompt: DEFAULT_TASK_PROMPTS['release-check'],
        },
      },
    });
    // Customized AND behind the current version: only promptCustomized can spare it.
    writeJson(legacyPath, {
      tasks: {
        'release-check': { promptVersion: 12, promptCustomized: true, prompt: 'custom release policy' },
      },
    });

    const result = await migration.up({ rootDir });

    expect(result.updated).toBe(0);
    expect(readJson(cosPath).tasks['release-check'].prompt).toBe(DEFAULT_TASK_PROMPTS['release-check']);
    expect(readJson(legacyPath).tasks['release-check']).toEqual({
      promptVersion: 12,
      promptCustomized: true,
      prompt: 'custom release policy',
    });
  });
});
