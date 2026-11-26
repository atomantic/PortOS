import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { guardCorpus, readText, REPO_ROOT, trackedFiles, workingTreeFiles } from '../../../../scripts/lib/guardCorpus.js';
import * as lib from '../../../../scripts/migrations/_lib.js';
import { sourceDeclaresPurge } from '../../../../scripts/run-migrations.js';

const MIGRATION_PATH = 'scripts/migrations';
const MIGRATIONS_DIR = join(REPO_ROOT, MIGRATION_PATH);
const SOURCE_PATHSPEC = [`${MIGRATION_PATH}/*.js`];

let directoryNames;
const migrationNames = () => (directoryNames ??= readdirSync(MIGRATIONS_DIR).sort());
const isMigrationSource = (path) => path.endsWith('.js') && !path.endsWith('.test.js');
const isNumberedSource = (file) => /^\d{3}-/.test(file) && isMigrationSource(file);

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

const RETIRED_MIGRATIONS = new Set([
  ...RETIRED_LOG_ONLY_STUBS,
  ...RETIRED_PROMPT_REPLACE_MIGRATIONS,
  ...RETIRED_SEED_AND_BUMP_MIGRATIONS,
]);

// Same selection as `scanMigrationFiles` in scripts/lib/migrationFiles.js.
const isShippedMigrationName = (name) => /^\d+-.*\.js$/.test(name) && !name.endsWith('.test.js');

/** Base-branch migration filenames that no longer exist in `currentNames`. */
function missingShippedMigrations(baseNames, currentNames, retired = RETIRED_MIGRATIONS) {
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
    const baseNames = basenamesIn(git('ls-tree', '--name-only', base, `${MIGRATION_PATH}/`));
    const currentNames = migrationNames();
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

// First migration number the conventions apply to. Raise it only when a
// migration below it is retired from the tree — never to exempt a new one.
const GUARDED_FROM = 429;

// No-op migrations kept on purpose. 456 is an empty `up()` retained as the
// shipped ID: its test pins that the upgrade never rewrites customized style
// notes, so deleting the file would delete that regression guard too (#16815).
const FROZEN_STUBS = new Set([
  '456-reality-style-snapshot-limit.js',
]);

const LIB_EXPORTS = new Set(Object.keys(lib));

// Local names applied migrations used for a helper `_lib.js` now exports
// under another name.
const LOCAL_ALIASES = {
  readJson: 'readJsonOrNull',
  readJsonFile: 'readJsonOrNull',
  readJsonSafe: 'readJsonOrNull',
  writeJson: 'writeJsonAtomic',
  writeJsonFile: 'writeJsonAtomic',
  atomicWriteJson: 'writeJsonAtomic',
  writeText: 'writeTextAtomic',
  writeAtomic: 'writeTextAtomic',
};

const DECLARATION = /^\s*(?:export\s+)?(?:async\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm;

const stripComments = (source) => guardCorpus().derive('migrationWithoutComments', source, () => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1'));

/** `{ name, use }` for every top-level or nested declaration that shadows a `_lib.js` helper. */
const redeclaredLibHelpers = (source) => [...stripComments(source).matchAll(DECLARATION)]
  .map(([, name]) => name)
  .filter((name) => LIB_EXPORTS.has(name) || name in LOCAL_ALIASES)
  .map((name) => ({ name, use: LOCAL_ALIASES[name] ?? name }));

// Static `from '…/server/services/…'` and dynamic `import('…/server/services/…')`.
const SERVICE_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*)['"][^'"]*\/server\/services\//;

const importsServerServices = (source) => SERVICE_IMPORT.test(stripComments(source));

/** Text between the braces of the first `up(...) {` method, or null for a factory-built migration. */
const upBody = (source) => {
  const code = stripComments(source);
  const head = /\bup\s*\([^)]*\)\s*\{/.exec(code);
  if (!head) return null;
  let depth = 1;
  let i = head.index + head[0].length;
  const start = i;
  for (; i < code.length && depth > 0; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') depth -= 1;
  }
  return code.slice(start, i - 1);
};

/** True when `up()` does nothing but log: no `await` and no call once console statements are removed. */
const isLogOnlyStub = (source) => {
  const body = upBody(source);
  if (body === null) return false;
  const rest = body.replace(/console\.\w+\([^\n]*\);?/g, '');
  return !/\bawait\b/.test(rest) && !/[\w$]\s*\(/.test(rest);
};

const migrationNumber = (file) => Number.parseInt(file.slice(0, 3), 10);

const WRITER_CALL = /\bwriteFile(?:Sync)?\(\s*([^,)]*)/g;
const TEMP_PATH_ARG = /^(?:tmp|temp|temporary)(?:[A-Z_$][\w$]*)?$/;

/** First arguments of every in-place `writeFile` call in a migration source. */
function inPlaceWrites(source) {
  if (!source.includes('writeFile')) return [];
  return [...stripComments(source).matchAll(WRITER_CALL)]
    .map(([, firstArg]) => firstArg.trim())
    .filter((firstArg) => !TEMP_PATH_ARG.test(firstArg));
}

const FROZEN_IN_PLACE_WRITERS = new Set([
  '001-merge-worldbuilder-collections.js', '002-cd-evaluate-image-strength.js',
  '009-heal-sharing-cursor-drops.js',
  '011-renumber-pipeline-issues-by-volume.js', '012-mark-flux1-dev-gated.js',
  '014-attribute-existing-annotations.js', '018-categorize-universe-buckets.js',
  '018-rename-writers-room-settings-stage.js', '019-character-description-to-physical.js',
  '021-link-orphan-universe-collections.js',
  '022-rename-bible-setting-to-place.js',
  '024-lock-canon-and-variations.js', '026-remove-visual-style-fields.js',
  '028-backfill-universe-builder-image-sidecars.js', '031-world-to-universe-data-rename.js',
  '039-adopt-orphan-series-into-universes.js', '040-init-conflict-journal-store.js',
  '061-browser-config-headed-default.js', '067-pipeline-audio-mode-cues.js',
  '073-seed-500-miles-score.js', '074-seed-musical-rounds.js', '075-correct-500-miles-melody.js',
  '076-seed-500-miles-harmony-parts.js', '080-brain-tombstone-and-synclog-cleanup.js',
  '081-brain-daily-log-inbox-sync.js', '086-seed-round-harmony-parts.js',
  '120-rename-songs-to-rounds-data.js',
  '146-claude-ollama-providers.js', '148-cd-treatment-catalog-cast.js',
  '154-post-memory-spaced-repetition.js', '157-seed-500-miles-references.js',
  '158-fix-hey-ho-melody.js', '159-post-session-modules-default.js',
  '188-cos-learning-recent-outcomes-ring.js', '190-seed-songbook-songs.js',
  '192-post-dates-to-local-timezone.js', '214-fix-hey-ho-fourth-phrase.js',
  '215-post-durable-memory-mastery.js', '216-post-review-verification-passes.js',
  '268-cd-evaluate-image-strength-crlf.js',
]);

const IMPORTS_PROMPT_DEFAULTS = /from\s+['"][^'"]*taskPromptDefaults\.js['"]/;
const WRITES_TASK_SCHEDULE = /task-schedule\.json/;

// Applied migrations remain in place for upgrades from older installs.
const ALLOWED_REGISTRY_MIGRATIONS = new Set([
  '012-mark-flux1-dev-gated.js',
  '044-hunyuan-fp32-deprecated.js',
  '045-flux2-klein-9b-kv-tokenizer.js',
  '064-flux2-klein-9b-bf16-kv-repo.js',
  '233-wan-mlx-gen-models.js',
  '237-video-model-disclosure.js',
  '238-video-finish-profiles.js',
  '242-minimax-h3-mlx-model.js',
  '244-minimax-h3-image-to-video.js',
  '247-retire-ltx2-unified.js',
  '267-minimax-h3-native-output-controls.js',
  '268-minimax-h3-cuda-model.js',
  '270-video-registry-mlx-cuda-buckets.js',
  '271-minimax-h3-mlx-denoising-count.js',
  '273-ltx-video-cuda-runtime.js',
  '295-video-speed-profiles.js',
  '314-fastvideo-mlx-models.js',
  '315-retire-hunyuan-video.js',
  '317-minimax-h3-memory-profiles.js',
  '317-minimax-h3-ref2va.js',
  '318-ltx25-a2v-duration.js',
  '333-fasth3-dense-datafree-mlx.js',
  '334-fasth3-upstream-source-mlx.js',
  '336-fastmetal-download-size-names.js',
  '398-apple-video-model-options.js',
  '444-minimax-h3-cuda-lightx2v.js',
  '445-minimax-h3-mlx-lightx2v.js',
  '455-ltx25-guided-steps.js',
]);

const referencesMediaRegistry = (source) => /media-models\.json/.test(source)
  || (/['"](?:[^'"]*\/)?_lib\.js['"]/.test(source)
    && /\b(?:readMediaRegistry(?:Config)?|writeMediaRegistry)\b/.test(source));


function scanMigrationSources() {
  // The index preserves the prompt check's tracked scope and its missing-file
  // failures. The working inventory includes newly authored registry migrations.
  const indexed = new Set(trackedFiles(REPO_ROOT, SOURCE_PATHSPEC).filter(isMigrationSource));
  const present = new Set(workingTreeFiles(REPO_ROOT, SOURCE_PATHSPEC).filter(isMigrationSource));
  const numbered = migrationNames()
    .filter((file) => /^\d/.test(file) && isMigrationSource(file))
    .map((file) => `${MIGRATION_PATH}/${file}`);

  const violations = [];
  const expectedWriters = new Set(FROZEN_IN_PLACE_WRITERS);
  const expectedStubs = new Set(FROZEN_STUBS);
  const purgeCandidates = [];

  for (const path of new Set([...numbered, ...indexed, ...present])) {
    const source = readText(join(REPO_ROOT, path));
    const file = basename(path);
    const rootMigration = path === `${MIGRATION_PATH}/${file}`;
    if (rootMigration && /^\d/.test(file)) {
      const writes = inPlaceWrites(source);
      if (writes.length && !expectedWriters.delete(file)) {
        for (const arg of writes) violations.push(`${file}: writeFile(${arg}, …) — use writeJsonAtomic or writeTextAtomic`);
      }
    }

    if (rootMigration && isNumberedSource(file)) {
      if (/purge/i.test(source)) purgeCandidates.push([file, source]);
      const guarded = migrationNumber(file) >= GUARDED_FROM;
      if ((guarded || expectedStubs.has(file)) && isLogOnlyStub(source) && !expectedStubs.delete(file)) {
        violations.push(`${file}: up() only logs — additive DDL belongs in ensureSchema`);
      }
      if (guarded) {
        for (const { name, use } of redeclaredLibHelpers(source)) {
          violations.push(`${file}: ${name} — import ${use} from ./_lib.js`);
        }
        if (importsServerServices(source)) violations.push(`${file}: imports server/services — use _lib.js, server/lib, or a frozen transform`);
      }
    }

    if (indexed.has(path) && IMPORTS_PROMPT_DEFAULTS.test(source) && WRITES_TASK_SCHEDULE.test(source)) {
      violations.push(`${path}: prompt upgrades belong to taskScheduleStore.js readSchedule()`);
    }
    if (present.has(path) && path !== `${MIGRATION_PATH}/_lib.js`
      && !(rootMigration && ALLOWED_REGISTRY_MIGRATIONS.has(file)) && referencesMediaRegistry(source)) {
      violations.push(`${path}: media-model registry updates belong in the catalog loader`);
    }
  }

  return { indexed, present, violations, expectedWriters, expectedStubs, purgeCandidates };
}

describe('migration source conventions', () => {
  it('checks shipped transforms, atomic writes, and store ownership in one pass', async () => {
    const { indexed, present, violations, expectedWriters, expectedStubs, purgeCandidates } = scanMigrationSources();
    expect(indexed.size).toBeGreaterThan(100);
    expect(present.size).toBeGreaterThan(100);
    const head = Math.max(...migrationNames().filter(isNumberedSource).map(migrationNumber));
    expect(GUARDED_FROM).toBeLessThanOrEqual(head + 1);
    expect(violations).toEqual([]);
    expect([...expectedWriters], 'stale in-place writer exemptions').toEqual([]);
    expect([...expectedStubs], 'stale log-only stub exemptions').toEqual([]);

    // Only modules that mention purge can disagree with the static probe.
    expect(purgeCandidates.length).toBeGreaterThan(0);
    for (const [file, source] of purgeCandidates) {
      const mod = await import(pathToFileURL(join(MIGRATIONS_DIR, file)).href);
      const migration = mod?.default && typeof mod.default.up === 'function' ? mod.default : mod;
      expect({ file, purge: sourceDeclaresPurge(source) }).toEqual({ file, purge: migration?.purge === true });
    }
  });

  describe('log-only stub matching', () => {
    it('flags a logging or empty up() and passes real work', () => {
      expect(isLogOnlyStub("export default { async up() { console.log('x: created by ensureSchema'); } };")).toBe(true);
      expect(isLogOnlyStub('export default { async up() {} };')).toBe(true);
      expect(isLogOnlyStub("export default { async up({ rootDir }) { const d = await readJsonOrNull(rootDir); console.log('ok'); } };")).toBe(false);
      expect(isLogOnlyStub('export default { up: (ctx) => other.up(ctx) };')).toBe(false);
      expect(isLogOnlyStub("export default makeSeedMigration({ id: 'x' });")).toBe(false);
    });
  });

  describe('service import matching', () => {
    it('flags static and dynamic imports from server/services', () => {
      expect(importsServerServices("import { listUniverses } from '../../server/services/universeBuilder.js';")).toBe(true);
      expect(importsServerServices("const { x } = await import('../../server/services/universeCanon.js');")).toBe(true);
    });

    it('passes _lib.js, server/lib and a comment that only mentions the path', () => {
      const source = [
        "import { readJsonOrNull } from './_lib.js';",
        "import { atomicWrite } from '../../server/lib/fileUtils.js';",
        '// a frozen copy of server/services/universeCanon.js#backfill, not an import',
      ].join('\n');
      expect(importsServerServices(source)).toBe(false);
    });
  });

  describe('helper redeclaration matching', () => {
    it('flags the local readJson spelling and points at readJsonOrNull', () => {
      const source = [
        "import { readFile } from 'fs/promises';",
        'async function readJson(path) {',
        "  const raw = await readFile(path, 'utf-8').catch(() => null);",
        '  return raw == null ? null : JSON.parse(raw);',
        '}',
      ].join('\n');
      expect(redeclaredLibHelpers(source)).toEqual([{ name: 'readJson', use: 'readJsonOrNull' }]);
    });

    it('flags dashboard-grid helpers whichever declaration form they take', () => {
      const source = [
        'const rectsOverlap = (a, b) => a.x < b.x + b.w;',
        'export function collidesWith(grid, candidate) { return false; }',
        'function pickGridEntry(grid, widgetId, slot) { return slot; }',
        'function applyToLayout(layout) { return false; }',
      ].join('\n');
      expect(redeclaredLibHelpers(source).map(({ name }) => name))
        .toEqual(['rectsOverlap', 'collidesWith', 'pickGridEntry', 'applyToLayout']);
    });

    it('passes a migration that imports the helpers and declares only its own data', () => {
      const source = [
        "import { readJsonOrNull, writeJsonAtomic, applyToLayout } from './_lib.js';",
        "const SEEDS = [{ widgetId: 'example', cell: { w: 4, h: 4 } }];",
        '// a local readJson would be flagged here',
        'export default { async up({ rootDir }) { const doc = await readJsonOrNull(rootDir); return doc; } };',
      ].join('\n');
      expect(redeclaredLibHelpers(source)).toEqual([]);
    });
  });

  describe('writer matching', () => {
    it('flags a JSON.stringify serialized on an earlier line', () => {
      const source = [
        "const body = JSON.stringify(doc, null, 2);",
        "await writeFile(providersPath, body);",
      ].join('\n');
      expect(inPlaceWrites(source)).toEqual(['providersPath']);
    });

    it('flags a text rewrite of a .json store', () => {
      const source = [
        "const next = raw.replace('\"songs\"', '\"rounds\"');",
        "await writeFile(join(rootDir, 'data', 'songbook.json'), next);",
      ].join('\n');
      expect(inPlaceWrites(source)).toEqual(["join(rootDir"]);
    });

    it('flags writeFileSync and a `templatePath` (not a temp path) alike', () => {
      expect(inPlaceWrites("writeFileSync(settingsPath, JSON.stringify(doc));")).toEqual(['settingsPath']);
      expect(inPlaceWrites("await writeFile(templatePath, next);")).toEqual(['templatePath']);
    });

    it('passes the temp half of an atomic swap and the _lib.js writers', () => {
      const source = [
        "const tmp = `${path}.tmp-${process.pid}`;",
        "await writeFile(tmp, JSON.stringify(value, null, 2));",
        "await writeFile(tempPath, body);",
        "await writeFile(temporaryPath, body);",
        "await rename(tmp, path);",
        "await writeJsonAtomic(path, value);",
        "await writeTextAtomic(path, body);",
      ].join('\n');
      expect(inPlaceWrites(source)).toEqual([]);
    });

    it('ignores prose about writeFile in comments', () => {
      const source = [
        "// a plain writeFile(path, body) would truncate the store",
        "/* see writeFile(configPath, …) in migration 061 — https://example.com/x */",
        "await writeJsonAtomic(path, value);",
      ].join('\n');
      expect(inPlaceWrites(source)).toEqual([]);
    });
  });

  it('flags the copy-pasted shape wherever it appears', () => {
    expect(IMPORTS_PROMPT_DEFAULTS.test("import { PROMPT_VERSIONS } from '../../server/services/taskPromptDefaults.js';")).toBe(true);
    expect(WRITES_TASK_SCHEDULE.test("join('data', 'cos', 'task-schedule.json')")).toBe(true);
    expect(IMPORTS_PROMPT_DEFAULTS.test("import { readFile } from 'fs/promises';")).toBe(false);
  });

  it.each([
    ["const path = join(dataDir, 'media-models.json');", true],
    ["import { readMediaRegistry as read } from './_lib.js';", true],
    ["import { readMediaRegistryConfig } from './_lib.js';", true],
    ["import * as helpers from './_lib.js'; helpers.writeMediaRegistry(path, config);", true],
    ["import { readJson } from './_lib.js';", false],
  ])('detects registry access in %s', (source, expected) => {
    expect(referencesMediaRegistry(source)).toBe(expected);
  });
});
