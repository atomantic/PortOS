import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './147-issue-author-filter-self-default.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 147 — flip frozen issueAuthorFilter owner → self', () => {
  let rootDir;
  let schedulePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-147-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    schedulePath = join(rootDir, 'data', 'task-schedule.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('no-ops cleanly when task-schedule.json is missing (fresh install)', async () => {
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('no-schedule-file');
    expect(existsSync(schedulePath)).toBe(false);
  });

  it('flips a frozen owner default to self for both claim-issue and claim-work', async () => {
    writeJson(schedulePath, {
      tasks: {
        'claim-issue': { enabled: true, taskMetadata: { useWorktree: false, issueAuthorFilter: 'owner' } },
        'claim-work': { enabled: false, taskMetadata: { issueAuthorFilter: 'owner' } },
      },
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(2);
    const after = readJson(schedulePath);
    expect(after.tasks['claim-issue'].taskMetadata.issueAuthorFilter).toBe('self');
    expect(after.tasks['claim-work'].taskMetadata.issueAuthorFilter).toBe('self');
    // Sibling metadata is preserved.
    expect(after.tasks['claim-issue'].taskMetadata.useWorktree).toBe(false);
  });

  it("preserves a deliberate 'any' choice (never a default)", async () => {
    writeJson(schedulePath, {
      tasks: { 'claim-issue': { taskMetadata: { issueAuthorFilter: 'any' } } },
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('already-applied');
    expect(readJson(schedulePath).tasks['claim-issue'].taskMetadata.issueAuthorFilter).toBe('any');
  });

  it('is idempotent — a self value is left untouched', async () => {
    writeJson(schedulePath, {
      tasks: { 'claim-work': { taskMetadata: { issueAuthorFilter: 'self' } } },
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('already-applied');
  });

  it('does not touch unrelated task types', async () => {
    writeJson(schedulePath, {
      tasks: {
        'pr-watcher': { taskMetadata: { prAuthorFilter: 'owner' } },
        'plan-task': { taskMetadata: { useWorktree: false } },
      },
    });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    const after = readJson(schedulePath);
    expect(after.tasks['pr-watcher'].taskMetadata.prAuthorFilter).toBe('owner');
  });

  it('survives an unreadable JSON file', async () => {
    writeFileSync(schedulePath, 'not json');
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('invalid-json');
  });
});
