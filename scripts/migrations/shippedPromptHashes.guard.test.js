/**
 * Guards for data.reference/prompts/shipped-hashes.json (#16090): the table is
 * the only record that lets other installs recognize an untouched old shipped
 * prompt body, so it must track every live template and never lose a hash.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  SHIPPED_HASHES_RELPATH,
  readReferencePromptHashes,
  readShippedHashes,
} from './shippedPromptHashes.js';
const migrationsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(migrationsDir, '..', '..');
const REGEN = 'run `node scripts/regen-shipped-prompt-hashes.js`';
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const table = await readShippedHashes(repoRoot);
const live = await readReferencePromptHashes(repoRoot);

// The prompt-hash migrations shipped before #16090 that remain. #16827 deleted
// the 97 whose whole up() was `makePromptReplaceMigration` swapping a body,
// because the reconciler performs that swap; their hashes live on in the
// table, which the base comparison below keeps from losing one. These also
// create a missing file, retire a renamed one or rewrite other state (003,
// 005, 022). #16916 deleted the hand-rolled 007/016/020 and every first-shipment
// seed migration (`reconcileShippedPrompts` seeds and swaps). The rest stay (other
// installs may still have them pending) and are never re-pointed; a template
// edit now needs only the regen above. Never add to this list.
const FROZEN_PROMPT_HASH_MIGRATIONS = new Set([
  '003-update-pipeline-stage-prompts.js',
  '005-shape-aware-arc-prompts.js',
  '022-rename-bible-setting-to-place.js',
]);

const recordedHashes = (entry) =>
  new Set([...(entry?.retired || []), entry?.current].filter(Boolean));

/** Shipped hashes present at `base` and missing from `current`, as `key: hash`. */
const missingRetiredHashes = (base, current) => Object.entries(base).flatMap(([key, entry]) => {
  const kept = recordedHashes(current[key]);
  return [...recordedHashes(entry)].filter((hash) => !kept.has(hash)).map((hash) => `${key}: ${hash}`);
});

const isNumberedMigrationFile = (file) =>
  /^\d.*\.js$/.test(file) && !file.endsWith('.test.js');

// Only the frozen pre-#16090 migrations may declare prompt hashes.
const usesPromptHashMigration = (source) =>
  ['ACCEPTED_OLD_MD5', 'NEW_SHIPPED_MD5', 'makePromptReplaceMigration'].some((marker) => source.includes(marker));

describe('shipped prompt hash table', () => {
  it('records the current hash of every live reference prompt', () => {
    expect(Object.keys(live).length).toBeGreaterThan(100);
    const stale = Object.entries(live)
      .filter(([key, hash]) => table[key]?.current !== hash)
      .map(([key, hash]) => `${key}: table has ${table[key]?.current ?? '(no entry)'}, live is ${hash}`);
    expect(stale, `A prompt body changed without retiring its old hash — ${REGEN}`).toEqual([]);
  });

  it('records a current hash only for prompts that still ship', () => {
    const orphaned = Object.entries(table)
      .filter(([key, entry]) => entry.current && !(key in live))
      .map(([key]) => key);
    expect(orphaned, `Prompt removed from data.reference — ${REGEN}`).toEqual([]);
  });

  it('holds only well-formed, unique md5 hashes', () => {
    const bad = Object.entries(table).flatMap(([key, entry]) => {
      const hashes = [...(entry.retired || []), ...(entry.current ? [entry.current] : [])];
      const problems = hashes.filter((hash) => !/^[0-9a-f]{32}$/.test(hash)).map((hash) => `${key}: malformed ${hash}`);
      if (new Set(entry.retired || []).size !== (entry.retired || []).length) problems.push(`${key}: duplicate retired hash`);
      return problems;
    });
    expect(bad).toEqual([]);
  });

  it('keeps every current or retired hash present at the comparison base', (context) => {
    let base;
    const explicitBase = process.env.CI_BASE_SHA?.trim();
    if (explicitBase) {
      base = git('rev-parse', '--verify', `${explicitBase}^{commit}`);
    } else if (process.env.GITHUB_ACTIONS === 'true') {
      // Push, schedule and dispatch never get CI_BASE_SHA from diff-base.
      base = git('rev-parse', '--verify', 'HEAD^1^{commit}');
    } else {
      try {
        base = git('merge-base', 'origin/main', 'HEAD');
      } catch {
        context.skip('No merge base available; fetch origin/main to check shipped prompt hashes.');
        return;
      }
    }
    const path = `data.reference/${SHIPPED_HASHES_RELPATH}`;
    if (!git('ls-tree', base, '--', path)) {
      // A base predating the table has no recorded hashes to retain.
      context.skip(`${path} does not exist at ${base}`);
      return;
    }
    const previous = git('show', `${base}:${path}`);
    expect(missingRetiredHashes(JSON.parse(previous), table),
      `Shipped prompt hashes removed since ${base}; restore them — every install holding that body is stranded otherwise`,
    ).toEqual([]);
  });

  it('retires every hash a frozen prompt migration declared for a live prompt', async () => {
    const uncovered = [];
    for (const file of FROZEN_PROMPT_HASH_MIGRATIONS) {
      const mod = await import(pathToFileURL(join(migrationsDir, file)).href);
      const subdirs = mod.DRIFT_SUBDIRS || {};
      for (const map of [mod.ACCEPTED_OLD_MD5 || {}, mod.NEW_SHIPPED_MD5 || {}]) {
        for (const [name, value] of Object.entries(map)) {
          const key = `${subdirs[name] || 'stages'}/${name}`;
          if (!(key in live)) continue;
          for (const hash of Array.isArray(value) ? value : [value]) {
            if (hash !== live[key] && !table[key]?.retired?.includes(hash)) uncovered.push(`${file} → ${key}: ${hash}`);
          }
        }
      }
    }
    expect(uncovered).toEqual([]);
  });

  it('ships a stages/<key>.md template for every stage-config.json entry', () => {
    // reconcileShippedPrompts merges absent stage-config entries and seeds
    // absent templates independently; an entry without its template would
    // surface as "Template not found" on an upgraded install.
    const config = JSON.parse(readFileSync(join(repoRoot, 'data.reference', 'prompts', 'stage-config.json'), 'utf8'));
    const missing = Object.keys(config.stages || {}).filter((key) => !(`stages/${key}.md` in table));
    expect(missing).toEqual([]);
  });

  it('allows no new numbered prompt-hash migration', () => {
    const migrations = readdirSync(migrationsDir).filter(isNumberedMigrationFile);
    expect(migrations).toEqual(expect.arrayContaining([...FROZEN_PROMPT_HASH_MIGRATIONS]));
    const offenders = migrations
      .filter((file) => !FROZEN_PROMPT_HASH_MIGRATIONS.has(file))
      .filter((file) => usesPromptHashMigration(readFileSync(join(migrationsDir, file), 'utf8')));
    expect(offenders, [
      'A new migration declares ACCEPTED_OLD_MD5 / NEW_SHIPPED_MD5 or uses makePromptReplaceMigration.',
      `A prompt template edit needs no migration: edit the .md and ${REGEN}.`,
      'See server/AGENTS.md "Prompt templates".',
    ].join(' ')).toEqual([]);
  });
});

describe('missingRetiredHashes', () => {
  const base = { 'stages/a.md': { current: 'c', retired: ['x', 'y'] } };

  it.each([
    ['a retired hash', { 'stages/a.md': { current: 'c', retired: ['y'] } }, ['stages/a.md: x']],
    ['the formerly current hash', { 'stages/a.md': { current: 'd', retired: ['x', 'y'] } }, ['stages/a.md: c']],
    ['the entire entry', {}, ['stages/a.md: x', 'stages/a.md: y', 'stages/a.md: c']],
  ])('detects deletion of %s', (_name, current, missing) => {
    expect(missingRetiredHashes(base, current)).toEqual(missing);
  });

  it('allows appended hashes and a revert to a retired body', () => {
    expect(missingRetiredHashes(base, { 'stages/a.md': { current: 'x', retired: ['y', 'c'] } })).toEqual([]);
  });
});
