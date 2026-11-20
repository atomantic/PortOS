/**
 * A shipped migration's filename is its applied-list identity (#16094).
 *
 * The number prefix is only an ordering hint: `run-migrations` keys the ledger
 * on the filename and sorts lexically. Existing collisions stay in place,
 * while new migrations must pick an unused number. Renaming or deleting a migration
 * that an install may already have applied is the real hazard — the renamed
 * file reads as "never applied" and re-runs on every install, and a deleted
 * one silently drops its transform for installs that have not run it yet.
 *
 * So this guard is base-relative: every migration filename present on the
 * merge base must still exist in the tree. Retirements are an explicit,
 * reviewed exception list, never a pattern match.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const MIGRATIONS_DIR = 'scripts/migrations';

// Migrations deliberately retired from the tree. Add an entry only with the
// retirement rationale in the same change; never add one to silence a rename.
// An applied-list entry naming a missing file is inert either way: pending =
// files on disk minus applied.

// Log-only registration stubs deleted in #16815. Each up() only logged; the
// work its comment describes runs at boot (ensureSchema or a server backfill) or
// is additive and absent-tolerant, so no transform is dropped.
const RETIRED_LOG_ONLY_STUBS = [
  '049-catalog-payload-schemaversion.js',
  '050-catalog-ingredient-relations.js',
  '051-catalog-tags-table.js',
  '052-catalog-ingredient-media.js',
  '053-catalog-friendly-universe-tags.js',
  '054-catalog-scrap-chunking.js',
  '055-reconcile-canon-catalog.js',
  '077-prune-imported-legacy-files.js',
  '078-song-recording-pitch-analysis.js',
  '079-song-training-progress.js',
  '108-mood-boards-table.js',
  '139-writers-room-folder-exercise-soft-delete.js',
  '160-privacy-vault-tables.js',
  '161-human-activity-events-table.js',
  '162-privacy-orgs-tables.js',
  '163-tribe-people-phones.js',
  '176-privacy-broker-tables.js',
  '178-privacy-change-events-table.js',
  '194-commission-feedback-federation.js',
  '207-universe-style-references.js',
  '212-games-table.js',
  '217-stacker-news-schema.js',
  '236-privacy-household-subjects.js',
  '276-post-runs-db-import.js',
  '282-cd-project-commission-backpointer.js',
  '287-fableloom-table.js',
  '312-fableloom-federation.js',
  '315-voice-profiles-table.js',
  '316-fableloom-production-assets.js',
  '323-fableloom-render-format.js',
  '326-fableloom-render-preferences.js',
  '328-user-action-events-table.js',
  '335-tribe-identities-table.js',
  '336-beeper-outbox-table.js',
  '381-mind-tool-recipes.js',
  '382-beeper-outbox-send-time.js',
  '386-decks.js',
  '413-beeper-account-continuation.js',
  '414-beeper-message-reconciliation.js',
  '416-voice-studio-library.js',
  '418-media-prompt-examinations.js',
  '420-code-animation-production-projects.js',
  '421-brain-memory-links.js',
  '434-catalog-media-reference-library.js',
  '435-storyboards-table.js',
  '436-storyboard-recipes-table.js',
];

// Pure prompt-replace migrations deleted in #16827. Each up() was only
// `makePromptReplaceMigration` over prompts that still ship: swap an installed
// copy whose hash is a known shipped body for the live reference body.
// `reconcileShippedPrompts` makes the same swap after every full pass from
// `data.reference/prompts/shipped-hashes.json`, which records every hash these
// files declared, so an install with one still pending ends on the same body.
// None of them created a missing file or retired a renamed one (003 and 005
// do, and stay), and no surviving migration reads a body one of them replaced.
const RETIRED_PROMPT_REPLACE_MIGRATIONS = [
  '004-augment-idea-expansion-context.js',
  '006-extract-scenes-shots.js',
  '010-simplify-cos-agent-briefing.js',
  '013-comic-script-back-cover.js',
  '019-arc-volume-prompts-canon-context.js',
  '023-resolve-prompt-episode-anchor.js',
  '025-idea-stage-character-detail.js',
  '027-text-stage-prompts-entities-summary.js',
  '042-fix-editorial-analysis-prompt.js',
  '054-source-agnostic-stage-prompts.js',
  '055-story-builder-idea-backfill-prompt.js',
  '056-manuscript-anchored-findings-prompt.js',
  '057-comic-structure-completeness-prompt.js',
  '060-manuscript-multi-edit-fix-prompt.js',
  '063-comic-script-panel-decomposition-prompt.js',
  '066-manuscript-finding-replacement-strategy-prompts.js',
  '083-completeness-with-edits-prompt.js',
  '084-manuscript-fix-example-placeholders.js',
  '098-idea-stage-ticking-clock.js',
  '114-extract-scenes-shot-grammar.js',
  '122-script-verify-continuity-loop-prompt.js',
  '123-arc-resolve-episode-corrections.js',
  '124-idea-stage-scope-discipline.js',
  '126-comic-script-visible-text-prompt.js',
  '127-pipeline-scene-markers-prompts.js',
  '128-teleplay-canonical-scene-list-prompt.js',
  '137-editorial-telling-emotion-broaden.js',
  '138-editorial-chekhov-setup-payoff-taxonomy.js',
  '144-editorial-on-the-nose-subtype.js',
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
];

// Seed, hash and prompt-bump migrations deleted in #16916 (99). Their work is now
// done on every boot by `reconcileShippedPrompts`, which seeds missing shipped
// prompts and `stage-config.json` entries and swaps retired bodies, or by
// `taskScheduleStore.js#readSchedule()` (task-schedule prompt bumps). 428 was
// already disarmed by the runner and is simply absent now.
const RETIRED_SEED_AND_BUMP_MIGRATIONS = [
  '007-places-int-ext-time-of-day.js',
  '015-importer-stage-prompts.js',
  '016-importer-fence-source.js',
  '017-volume-cover-concepts-stage.js',
  '020-comic-cover-concepts-stage.js',
  '020-importer-screenplay-user-requested-count.js',
  '022-character-extended-fields.js',
  '041-editorial-analysis-stage.js',
  '043-story-builder-prompts.js',
  '048-catalog-ideas-scenes-concepts-stage.js',
  '062-story-builder-arc-refine-prompt.js',
  '065-writers-room-continue-prompt.js',
  '068-pipeline-audio-cues-prompt.js',
  '069-twin-spoken-written-compare-prompt.js',
  '071-writers-room-cd-bridge-prompt.js',
  '072-twin-image-identity-prompt.js',
  '087-manuscript-reformat-stage.js',
  '088-series-generate-stage.js',
  '089-canon-describe-from-prose-stage.js',
  '090-script-verify-stage.js',
  '091-seed-image-prompt-stages.js',
  '092-editorial-info-dumping-stage.js',
  '093-reverse-outline-stage.js',
  '094-object-attachment-check-stages.js',
  '095-pov-rewrite-stages.js',
  '096-editorial-style-conformance-stage.js',
  '097-continuity-bible-stage.js',
  '099-editorial-interiority-stage.js',
  '100-editorial-chekhov-stage.js',
  '101-editorial-dead-metaphor-stage.js',
  '102-editorial-endings-cliffhanger-stage.js',
  '103-editorial-opening-start-stage.js',
  '104-editorial-mirror-description-stage.js',
  '105-editorial-dialogue-pleasantries-stage.js',
  '106-editorial-kill-your-darlings-stage.js',
  '107-editorial-sensory-grounding-stages.js',
  '109-editorial-arc-transitions-stage.js',
  '110-editorial-telling-emotion-stage.js',
  '111-editorial-plot-structure-stage.js',
  '112-editorial-on-the-nose-stage.js',
  '113-editorial-voice-distinctiveness-stage.js',
  '115-editorial-theme-coherence-stage.js',
  '116-editorial-unmodeled-names-stage.js',
  '117-editorial-eyeline-match-stage.js',
  '118-editorial-appearance-continuity-stage.js',
  '119-editorial-comic-page-turn-stage.js',
  '125-beat-continuity-prompts.js',
  '129-editorial-timeline-contradiction-stage.js',
  '130-editorial-character-consistency-stage.js',
  '131-editorial-climax-agency-stage.js',
  '132-editorial-reaction-proportionality-stage.js',
  '133-editorial-secondary-arc-stage.js',
  '134-editorial-voice-consistency-stage.js',
  '135-editorial-fact-accuracy-stage.js',
  '136-editorial-comic-prose-sync-stage.js',
  '140-editorial-pacing-escalation-stage.js',
  '141-editorial-arc-regression-stage.js',
  '142-editorial-interiority-balance-stage.js',
  '143-editorial-object-weight-proportionality-stage.js',
  '150-seed-comic-page-refine-render-stage.js',
  '151-editorial-head-hopping-stage.js',
  '165-reader-panel-persona-stages.js',
  '167-editorial-world-doctrine-stages.js',
  '168-editorial-premature-reveal-stage.js',
  '174-series-voice-discover-stage.js',
  '175-cd-plan-stage.js',
  '180-series-concept-judge-stage.js',
  '182-seed-cwqe-quality-stages.js',
  '183-seed-craft-anti-patterns-partial.js',
  '189-model-personality-stages.js',
  '218-cos-task-enhance-stage.js',
  '227-editorial-summary-not-scene-stage.js',
  '229-editorial-reported-speech-stage.js',
  '230-editorial-interiority-register-stage.js',
  '232-universe-canon-character-stages.js',
  '233-digital-twin-stage-templates.js',
  '235-pipeline-self-improve-stage.js',
  '237-pipeline-observer-stage.js',
  '238-pipeline-foundation-repair-stage.js',
  '239-pipeline-character-foundation-stage.js',
  '264-universe-canon-entry-expand-stage.js',
  '281-reconcile-missing-releases-prompt.js',
  '286-fableloom-stages.js',
  '289-fableloom-reformat-stage.js',
  '293-agents-md-prompt-rename.js',
  '297-release-check-slashdo-review-prompt.js',
  '306-fableloom-episode-feedback-stage.js',
  '308-release-check-advisory-review-prompt.js',
  '309-fableloom-generate-series-plan-stage.js',
  '317-fableloom-episode-outline-stages.js',
  '318-fableloom-series-teleplay-review-stage.js',
  '320-fableloom-editorial-automation-stages.js',
  '322-fableloom-editorial-self-improve-stage.js',
  '332-release-check-fix-blockers-prompt.js',
  '338-claim-issue-volunteer-claim-contract.js',
  '351-fableloom-timed-shots.js',
  '363-cast-integrity-stages.js',
  '403-catalog-extract-stage.js',
  '428-prune-dangling-collection-images.js',
];

export const RETIRED_MIGRATIONS = new Set([
  ...RETIRED_LOG_ONLY_STUBS,
  ...RETIRED_PROMPT_REPLACE_MIGRATIONS,
  ...RETIRED_SEED_AND_BUMP_MIGRATIONS,
]);

// Same selection as `scanMigrationFiles` in scripts/lib/migrationFiles.js.
export const isShippedMigrationName = (name) => /^\d+-.*\.js$/.test(name) && !name.endsWith('.test.js');

/** Base-branch migration filenames that no longer exist in `currentNames`. */
export function missingShippedMigrations(baseNames, currentNames, retired = RETIRED_MIGRATIONS) {
  const current = new Set(currentNames);
  return baseNames
    .filter((name) => isShippedMigrationName(name) && !retired.has(name) && !current.has(name))
    .sort();
}

const LAST_LEGACY_PREFIX = 462;

function collidingMigrationPrefixes(baseNames, currentNames) {
  const base = new Set(baseNames);
  const current = new Set(currentNames);
  const byPrefix = new Map();
  for (const name of new Set([...base, ...current])) {
    if (!isShippedMigrationName(name)) continue;
    const prefix = Number(name.slice(0, name.indexOf('-')));
    const names = byPrefix.get(prefix) ?? [];
    names.push(name);
    byPrefix.set(prefix, names);
  }
  return [...byPrefix].filter(([prefix, names]) => names.length > 1 && names.some(name =>
    current.has(name) && (prefix > LAST_LEGACY_PREFIX || !base.has(name)),
  )).map(([, names]) => names);
}

const git = (...args) => execFileSync('git', args, {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const basenamesIn = (listing) => listing
  .split('\n')
  .filter(Boolean)
  .map((path) => path.slice(path.lastIndexOf('/') + 1));

describe('shipped migration filenames stay stable', () => {
  it('no migration present on the merge base was renamed or deleted', (context) => {
    const explicitBase = process.env.CI_BASE_SHA?.trim();
    let base;
    if (explicitBase) {
      // The planner chose this commit; a bad SHA must fail, not fall back.
      base = git('rev-parse', '--verify', `${explicitBase}^{commit}`);
    } else {
      try {
        base = git('merge-base', 'origin/main', 'HEAD');
      } catch {
        context.skip('No merge base available; fetch origin/main to check shipped migration filenames.');
        return;
      }
    }
    const baseNames = basenamesIn(git('ls-tree', '--name-only', base, `${MIGRATIONS_DIR}/`));
    const currentNames = readdirSync(join(REPO_ROOT, MIGRATIONS_DIR));
    expect(missingShippedMigrations(baseNames, currentNames),
      `Migrations shipped at ${base} were renamed or deleted; installs that applied them would re-run or lose them. Restore the file, or record a retirement in RETIRED_MIGRATIONS.`,
    ).toEqual([]);
    expect(collidingMigrationPrefixes(baseNames, currentNames),
      'New migrations must use an unused number. Keep previously shipped filenames intact.',
    ).toEqual([]);
  });

  describe('filename identity matching', () => {
    it('flags a rename that moves the number prefix', () => {
      expect(missingShippedMigrations(['011-backfill.js'], ['500-backfill.js'])).toEqual(['011-backfill.js']);
    });

    it('flags a deletion even when a same-numbered file is added (bypass probe)', () => {
      expect(missingShippedMigrations(['011-backfill.js'], ['011-other.js'])).toEqual(['011-backfill.js']);
    });

    it('grandfathers shipped collisions and ignores test siblings', () => {
      const shipped = ['011-backfill.js', '011-other.js'];
      expect(collidingMigrationPrefixes(shipped, [...shipped, '011-backfill.test.js'])).toEqual([]);
    });

    it('flags new collisions with both historical and newly added migrations', () => {
      const shipped = ['011-backfill.js'];
      expect(collidingMigrationPrefixes(shipped, [
        ...shipped, '011-other.js', '463-first.js', '463-second.js',
      ])).toEqual([
        ['011-backfill.js', '011-other.js'], ['463-first.js', '463-second.js'],
      ]);
    });

    it('keeps checking collisions after the legacy cutoff on a current base', () => {
      const names = ['463-first.js', '463-second.js'];
      expect(collidingMigrationPrefixes(names, names)).toEqual([names]);
    });

    it('honours an explicit retirement and ignores test siblings', () => {
      expect(missingShippedMigrations(['011-backfill.js', '012-x.test.js'], [], new Set(['011-backfill.js']))).toEqual([]);
      expect(missingShippedMigrations(['012-x.test.js'], [])).toEqual([]);
    });
  });
});
