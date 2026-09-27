import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './281-reconcile-missing-releases-prompt.js';
import { DEFAULT_TASK_PROMPTS, PROMPT_VERSIONS } from '../../server/services/taskPromptDefaults.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 281 — upgrade release-check task prompt to v9', () => {
  let rootDir;
  let schedulePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-281-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    schedulePath = join(rootDir, 'data', 'cos', 'task-schedule.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('no-ops cleanly when task-schedule.json is missing', async () => {
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(existsSync(schedulePath)).toBe(false);
  });

  it('upgrades an uncustomized release-check prompt to v9', async () => {
    writeJson(schedulePath, {
      tasks: {
        'release-check': {
          promptVersion: 8,
          promptCustomized: false,
          prompt: 'old prompt v8',
        },
      },
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const updated = readJson(schedulePath);
    expect(updated.tasks['release-check'].promptVersion).toBe(PROMPT_VERSIONS['do-release']);
    expect(updated.tasks['release-check'].promptVersion).toBeGreaterThanOrEqual(9);
    expect(updated.tasks['release-check'].prompt).toBe(DEFAULT_TASK_PROMPTS['do-release']);
  });

  it('leaves a user-customized release-check prompt untouched', async () => {
    writeJson(schedulePath, {
      tasks: {
        'release-check': {
          promptVersion: 8,
          promptCustomized: true,
          prompt: 'my custom release check prompt',
        },
      },
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    const after = readJson(schedulePath);
    expect(after.tasks['release-check'].promptVersion).toBe(8);
    expect(after.tasks['release-check'].prompt).toBe('my custom release check prompt');
  });
});
