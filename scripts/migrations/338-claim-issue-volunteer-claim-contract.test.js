import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './338-claim-issue-volunteer-claim-contract.js';
import { DEFAULT_TASK_PROMPTS, PROMPT_VERSIONS, PREVIOUS_DEFAULT_PROMPTS } from '../../server/services/taskPromptDefaults.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const oldPrompt = PREVIOUS_DEFAULT_PROMPTS['claim-issue'].at(-1);

describe('migration 338 — reconcile the claim-issue volunteer-claim contract', () => {
  let rootDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-338-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  // The outgoing default is the exact body an un-customized install is holding,
  // so this also pins that PREVIOUS_DEFAULT_PROMPTS carries the v24 text.
  it('upgrades the stored v24 default in both supported schedule locations', async () => {
    const cosPath = join(rootDir, 'data', 'cos', 'task-schedule.json');
    const legacyPath = join(rootDir, 'data', 'task-schedule.json');
    expect(oldPrompt).toContain('leave contributor-invitation labels intact');
    writeJson(cosPath, {
      tasks: {
        'claim-issue': { promptVersion: 24, promptCustomized: false, prompt: oldPrompt },
        custom: { promptVersion: 24, promptCustomized: true, prompt: 'keep this' },
      },
    });
    writeJson(legacyPath, {
      tasks: { 'claim-issue': { promptVersion: 24, promptCustomized: false, prompt: oldPrompt } },
    });

    const result = await migration.up({ rootDir });

    expect(result.updated).toBe(2);
    expect(readJson(cosPath).tasks['claim-issue']).toEqual({
      promptVersion: PROMPT_VERSIONS['claim-issue'],
      promptCustomized: false,
      prompt: DEFAULT_TASK_PROMPTS['claim-issue'],
    });
    expect(readJson(cosPath).tasks.custom).toEqual({
      promptVersion: 24, promptCustomized: true, prompt: 'keep this',
    });
    expect(readJson(legacyPath).tasks['claim-issue'].prompt).toBe(DEFAULT_TASK_PROMPTS['claim-issue']);
  });

  // Both guards key on the 'claim-issue' task itself — a task stored under any
  // other key is skipped before either guard runs, so `updated === 0` would pass
  // without exercising them.
  it('does not rewrite a current or customized claim-issue prompt', async () => {
    const cosPath = join(rootDir, 'data', 'cos', 'task-schedule.json');
    const legacyPath = join(rootDir, 'data', 'task-schedule.json');
    writeJson(cosPath, {
      tasks: {
        'claim-issue': {
          promptVersion: PROMPT_VERSIONS['claim-issue'],
          promptCustomized: false,
          prompt: DEFAULT_TASK_PROMPTS['claim-issue'],
        },
      },
    });
    writeJson(legacyPath, {
      tasks: { 'claim-issue': { promptVersion: 24, promptCustomized: true, prompt: 'custom claim policy' } },
    });

    const result = await migration.up({ rootDir });

    expect(result.updated).toBe(0);
    expect(readJson(cosPath).tasks['claim-issue'].prompt).toBe(DEFAULT_TASK_PROMPTS['claim-issue']);
    expect(readJson(legacyPath).tasks['claim-issue']).toEqual({
      promptVersion: 24, promptCustomized: true, prompt: 'custom claim policy',
    });
  });
});
