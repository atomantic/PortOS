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

// The hash-replace migrations shipped before #16090. They stay (other installs
// may still have them pending) and are never re-pointed; a template edit now
// needs only the regen above. Never add to this list.
const FROZEN_PROMPT_HASH_MIGRATIONS = new Set([
  '003-update-pipeline-stage-prompts.js',
  '004-augment-idea-expansion-context.js',
  '005-shape-aware-arc-prompts.js',
  '006-extract-scenes-shots.js',
  '007-places-int-ext-time-of-day.js',
  '010-simplify-cos-agent-briefing.js',
  '013-comic-script-back-cover.js',
  '019-arc-volume-prompts-canon-context.js',
  '020-importer-screenplay-user-requested-count.js',
  '022-rename-bible-setting-to-place.js',
  '023-resolve-prompt-episode-anchor.js',
  '025-idea-stage-character-detail.js',
  '027-text-stage-prompts-entities-summary.js',
  '042-fix-editorial-analysis-prompt.js',
  '043-story-builder-prompts.js',
  '054-source-agnostic-stage-prompts.js',
  '055-story-builder-idea-backfill-prompt.js',
  '056-manuscript-anchored-findings-prompt.js',
  '057-comic-structure-completeness-prompt.js',
  '060-manuscript-multi-edit-fix-prompt.js',
  '063-comic-script-panel-decomposition-prompt.js',
  '066-manuscript-finding-replacement-strategy-prompts.js',
  '083-completeness-with-edits-prompt.js',
  '084-manuscript-fix-example-placeholders.js',
  '091-seed-image-prompt-stages.js',
  '098-idea-stage-ticking-clock.js',
  '102-editorial-endings-cliffhanger-stage.js',
  '114-extract-scenes-shot-grammar.js',
  '119-editorial-comic-page-turn-stage.js',
  '122-script-verify-continuity-loop-prompt.js',
  '123-arc-resolve-episode-corrections.js',
  '124-idea-stage-scope-discipline.js',
  '126-comic-script-visible-text-prompt.js',
  '127-pipeline-scene-markers-prompts.js',
  '128-teleplay-canonical-scene-list-prompt.js',
  '137-editorial-telling-emotion-broaden.js',
  '138-editorial-chekhov-setup-payoff-taxonomy.js',
  '144-editorial-on-the-nose-subtype.js',
  '150-seed-comic-page-refine-render-stage.js',
  '155-heal-cd-treatment-cast-strand.js',
  '166-craft-knowledge-prompt-upgrades.js',
  '169-prose-cross-issue-continuity.js',
  '171-character-framework-prompt.js',
  '172-structure-rules-season-episodes.js',
  '173-mice-thread-nesting-arc-overview.js',
  '179-series-multi-concept-ideation.js',
  '181-writers-room-voice-exemplars.js',
  '187-cos-agent-briefing-target-app-label.js',
  '193-cd-plan-locked-render-settings.js',
  '199-cd-plan-result-references.js',
  '228-craft-partial-zoom-into-the-moment.js',
  '240-character-foundation-exhaustive-cast.js',
  '241-foundation-judge-repair-ownership.js',
  '243-post-arc-character-transition-ownership.js',
  '245-arc-resolve-finding-keyed-patches.js',
  '248-foundation-judge-author-intent.js',
  '249-arc-overview-author-intent.js',
  '250-arc-spine-checkpoint-prompts.js',
  '251-arc-resolve-field-sparsity.js',
  '252-arc-resolve-avoid-list.js',
  '253-arc-resolve-spine-scope.js',
  '254-arc-resolve-character-arcs.js',
  '255-character-visual-foundation.js',
  '256-series-linked-character-profiles.js',
  '257-complete-character-expand-fields.js',
  '258-arc-resolve-exact-text-patches.js',
  '259-arc-resolve-text-budgets.js',
  '260-arc-resolve-isolated-repairs.js',
  '261-exhaustive-arc-verification.js',
  '263-arc-verify-world-category-canon.js',
  '266-resolve-outcome-telemetry-legend.js',
  '267-arc-resolve-character-arc-budgets.js',
  '275-pipeline-planning-economy.js',
  '276-distinct-climax-arc-role-prompts.js',
  '277-cd-plan-commission-controls.js',
  '288-fableloom-scene-format.js',
  '310-fableloom-camera-cuts.js',
  '311-fableloom-audience-participation.js',
  '319-fableloom-protagonist-continuity.js',
  '321-fableloom-outline-expansion-contract.js',
  '324-fableloom-playable-challenge-contract.js',
  '349-fableloom-plan-synopsis-sync.js',
  '350-fableloom-opening-comprehension.js',
  '352-fableloom-shot-visual-continuity.js',
  '360-character-psychology-prompts.js',
  '361-series-concept-character-engines.js',
  '362-writers-room-character-framework.js',
  '364-foundation-judge-cast-integrity.js',
  '365-fableloom-editorial-cast-integrity.js',
  '366-writers-room-evaluate-psychology.js',
  '367-character-evolution-editorial-prompts.js',
  '368-fableloom-plan-review-evolution.js',
  '369-writers-room-evaluate-character-evolution.js',
  '371-video-treatment-contract.js',
  '372-video-source-context.js',
  '373-video-review-revisions.js',
  '377-pilot-developmental-gate.js',
  '378-arc-countdown-repair.js',
  '379-arc-episode-metadata-repair.js',
  '380-arc-spine-existing-plans.js',
  '383-pipeline-series-design.js',
  '384-fableloom-series-design.js',
  '385-pipeline-scene-progression.js',
  '385-stranded-stage-prompt-history.js',
  '394-factual-extraction-lens-prompts.js',
  '431-security-audit-skill-trust-model.js',
  '453-writers-room-cd-bridge-continue-from-prior.js',
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
