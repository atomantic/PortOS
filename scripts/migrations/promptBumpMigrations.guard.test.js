/**
 * Guard against re-introducing the copy-pasted prompt-bump migration (#6481).
 *
 * A `PROMPT_VERSIONS` bump needs no migration: `readSchedule()` in
 * `server/services/taskScheduleStore.js` upgrades every uncustomized stored
 * prompt to the shipped default on the next `loadSchedule()` and persists the
 * result, so the first schedule read after an update converges the install
 * anyway. Six migrations shipped between 2026-08-19 and 2026-09-03 before that
 * was written down (281, 293, 297, 308, 332, 338) — each re-implementing that
 * same loop against `data/task-schedule.json`, a path the store never reads.
 * They stay (the distribution model forbids deleting applied migrations); this
 * test only stops a seventh from joining them. See `server/AGENTS.md`
 * "Prompt templates".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(HERE, '..', '..');

// Frozen: the closed precedent this migration shape is not allowed to repeat.
// Never add to this list — a new prompt bump needs no migration at all.
const ALLOWED_PROMPT_BUMP_MIGRATIONS = new Set([
  'scripts/migrations/281-reconcile-missing-releases-prompt.js',
  'scripts/migrations/293-agents-md-prompt-rename.js',
  'scripts/migrations/297-release-check-slashdo-review-prompt.js',
  'scripts/migrations/308-release-check-advisory-review-prompt.js',
  'scripts/migrations/332-release-check-fix-blockers-prompt.js',
  'scripts/migrations/338-claim-issue-volunteer-claim-contract.js',
]);

const IMPORTS_PROMPT_DEFAULTS = /from\s+['"][^'"]*taskPromptDefaults\.js['"]/;
const WRITES_TASK_SCHEDULE = /task-schedule\.json/;

let tracked;
const trackedMigrations = () => (tracked ??= execFileSync(
  'git',
  ['ls-files', 'scripts/migrations/*.js'],
  { cwd: REPO_ROOT, encoding: 'utf8' },
).split('\n').filter((path) => path && !path.endsWith('.test.js')));

describe('prompt-bump migrations stay closed', () => {
  it('finds the migrations it is meant to guard', () => {
    // A regression here means the pathspec stopped matching and every
    // assertion below started passing vacuously.
    expect(trackedMigrations()).toEqual(expect.arrayContaining([...ALLOWED_PROMPT_BUMP_MIGRATIONS]));
  });

  it('rejects a new migration that re-implements the schedule loader\'s prompt upgrade', () => {
    const offenders = trackedMigrations()
      .filter((path) => !ALLOWED_PROMPT_BUMP_MIGRATIONS.has(path))
      .filter((path) => {
        const source = readFileSync(join(REPO_ROOT, path), 'utf8');
        return IMPORTS_PROMPT_DEFAULTS.test(source) && WRITES_TASK_SCHEDULE.test(source);
      });

    expect(offenders, [
      'A migration outside the frozen prompt-bump allowlist imports',
      'taskPromptDefaults.js and writes task-schedule.json — the exact shape',
      'this guard exists to stop. A PROMPT_VERSIONS bump needs no migration:',
      'taskScheduleStore.js#readSchedule() upgrades every uncustomized stored',
      'prompt on the next loadSchedule() and persists it. See server/AGENTS.md',
      '"Prompt templates".',
    ].join(' ')).toEqual([]);
  });

  // Bypass probe: prove the detector actually fires on the shape it targets,
  // not merely that reading six known-good files finds nothing.
  it('flags the copy-pasted shape wherever it appears', () => {
    expect(IMPORTS_PROMPT_DEFAULTS.test("import { PROMPT_VERSIONS } from '../../server/services/taskPromptDefaults.js';")).toBe(true);
    expect(WRITES_TASK_SCHEDULE.test("join('data', 'cos', 'task-schedule.json')")).toBe(true);
    expect(IMPORTS_PROMPT_DEFAULTS.test("import { readFile } from 'fs/promises';")).toBe(false);
  });
});
