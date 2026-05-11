/**
 * Scene-list extraction — split a prose draft OR a TV teleplay into a
 * structured `scenes[]` shape both Writers Room and Pipeline can consume.
 *
 * Mirrors the bibleExtractor.js pattern: this module owns the LLM call +
 * sanitization, the caller owns persistence. Returns the same scene shape
 * the writers-room evaluator's `script` analysis produces, so a writers-room
 * scene array and a pipeline-extracted scene array are byte-for-byte the
 * same shape (the Pipeline UI then reads `description` ← `visualPrompt`
 * for legacy field-name compat — see `extractedScenesToStoryboards` below).
 *
 * Two source modes:
 *
 *   - `prose`   → uses the existing `writers-room-script` stage prompt
 *                 (prose-paragraph granularity, sluglines invented).
 *   - `tvScript`→ uses the new `pipeline-extract-scenes` stage prompt
 *                 (sluglines already present in the teleplay markdown,
 *                  parse them rather than invent).
 */

import { runStagedLLM } from './stageRunner.js';
import { BIBLE_KIND, pickPromptFields, isStr, trimTo } from './storyBible.js';

export const SOURCE_KIND = Object.freeze({ PROSE: 'prose', TV_SCRIPT: 'tvScript' });

const STAGE_FOR_SOURCE = Object.freeze({
  [SOURCE_KIND.PROSE]: 'writers-room-script',
  [SOURCE_KIND.TV_SCRIPT]: 'pipeline-extract-scenes',
});

// Per-field caps. Match the BIBLE_LIMITS pattern: bound every LLM-sourced
// string so a runaway scene list can't push stages.storyboards past
// STAGE_OUTPUT_MAX (400kB) on the issue-persist round-trip.
const SCENE_LIMITS = Object.freeze({
  ID_MAX: 80,
  HEADING_MAX: 200,
  SLUGLINE_MAX: 200,
  SUMMARY_MAX: 2000,
  CHARACTER_NAME_MAX: 100,
  CHARACTERS_PER_SCENE_MAX: 24,
  ACTION_MAX: 2000,
  DIALOGUE_LINE_MAX: 1000,
  DIALOGUE_ENTRIES_MAX: 60,
  VISUAL_PROMPT_MAX: 4000,
  SOURCE_SEG_ID_MAX: 80,
  SOURCE_SEG_IDS_MAX: 32,
});

// ---------- canonical scene shape (single source of truth) ----------

function sanitizeScene(s, i) {
  if (!s || typeof s !== 'object') return null;
  const id = trimTo(s.id, SCENE_LIMITS.ID_MAX) || `scene-${String(i + 1).padStart(2, '0')}`;
  const heading = trimTo(s.heading, SCENE_LIMITS.HEADING_MAX) || `Scene ${i + 1}`;
  const slugline = trimTo(s.slugline, SCENE_LIMITS.SLUGLINE_MAX);
  return {
    id,
    heading,
    slugline: slugline || null,
    summary: trimTo(s.summary, SCENE_LIMITS.SUMMARY_MAX),
    characters: Array.isArray(s.characters)
      ? s.characters.map((c) => trimTo(c, SCENE_LIMITS.CHARACTER_NAME_MAX)).filter(Boolean).slice(0, SCENE_LIMITS.CHARACTERS_PER_SCENE_MAX)
      : [],
    action: trimTo(s.action, SCENE_LIMITS.ACTION_MAX),
    dialogue: Array.isArray(s.dialogue)
      ? s.dialogue
          .filter((d) => d && typeof d === 'object' && (isStr(d.character) || isStr(d.line)))
          .slice(0, SCENE_LIMITS.DIALOGUE_ENTRIES_MAX)
          .map((d) => ({
            character: trimTo(d.character, SCENE_LIMITS.CHARACTER_NAME_MAX),
            line: trimTo(d.line, SCENE_LIMITS.DIALOGUE_LINE_MAX),
          }))
      : [],
    visualPrompt: trimTo(s.visualPrompt, SCENE_LIMITS.VISUAL_PROMPT_MAX),
    sourceSegmentIds: Array.isArray(s.sourceSegmentIds)
      ? s.sourceSegmentIds.map((segId) => trimTo(segId, SCENE_LIMITS.SOURCE_SEG_ID_MAX)).filter(Boolean).slice(0, SCENE_LIMITS.SOURCE_SEG_IDS_MAX)
      : [],
  };
}

/**
 * Sanitize the full LLM envelope: `{ title, logline, scenes: [...] }`.
 * Cap at 200 scenes to match the visual-stage `scenes` cap in
 * `pipeline/issues.js#sanitizeVisualStage` so an over-eager extraction
 * can't silently lose entries to a downstream slice.
 */
export function sanitizeSceneList(raw, { maxScenes = 200 } = {}) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(obj.scenes) ? obj.scenes : [];
  return {
    title: isStr(obj.title) ? obj.title.trim() : null,
    logline: isStr(obj.logline) ? obj.logline.trim() : null,
    scenes: list.slice(0, maxScenes).map(sanitizeScene).filter(Boolean),
  };
}

// ---------- LLM driver ----------

/**
 * @param {object} args
 * @param {string} args.source          prose body OR teleplay markdown
 * @param {string} args.sourceKind      'prose' | 'tvScript'
 * @param {Array}  [args.characters]    bible entries (for deference)
 * @param {Array}  [args.settings]      bible entries (for deference)
 * @param {Array}  [args.objects]       bible entries (for deference)
 * @param {object} [args.work]          variables consumed by writers-room-script (`work.title`, `work.kind`, `work.wordCount`)
 * @param {object} [args.series]        variables consumed by pipeline-extract-scenes (`series.name`, `series.styleNotes`)
 * @param {object} [args.issue]         variables consumed by pipeline-extract-scenes (`issue.number`, `issue.title`)
 * @param {string} [args.providerOverride]
 * @param {string} [args.tag]           override the run-tracking source tag
 * @returns {Promise<{ extracted: { title, logline, scenes }, runId, providerId, model }>}
 */
export async function extractScenes({
  source,
  sourceKind = SOURCE_KIND.PROSE,
  characters = [],
  settings = [],
  objects = [],
  work,
  series,
  issue,
  providerOverride,
  tag,
}) {
  const stage = STAGE_FOR_SOURCE[sourceKind];
  if (!stage) throw new Error(`extractScenes: unknown sourceKind "${sourceKind}"`);
  if (!isStr(source) || !source.trim()) {
    throw new Error('extractScenes: source is required');
  }

  // Both prompts read the same `existing<X>Json` envelope so the model can
  // defer to canonical character/setting names instead of re-improvising.
  // Pipeline's series.characters and Writers Room's per-work characters both
  // sanitize through `pickPromptFields` to strip ids/timestamps/source/notes.
  const variables = {
    returnsJson: true,
    sourceKind,
    existingCharactersJson: JSON.stringify((characters || []).map((c) => pickPromptFields(BIBLE_KIND.CHARACTER, c))),
    existingSettingsJson: JSON.stringify((settings || []).map((s) => pickPromptFields(BIBLE_KIND.SETTING, s))),
    existingObjectsJson: JSON.stringify((objects || []).map((o) => pickPromptFields(BIBLE_KIND.OBJECT, o))),
  };
  // Variable-shape compat: writers-room-script.md reads `{{draftBody}}` +
  // `{{work.*}}`; pipeline-extract-scenes.md reads `{{teleplay}}` +
  // `{{series.*}}` / `{{issue.*}}`. Populate both — Mustache silently drops
  // unbound names.
  variables.draftBody = source;
  variables.teleplay = source;
  if (work) variables.work = work;
  if (series) variables.series = series;
  if (issue) variables.issue = issue;

  const result = await runStagedLLM(stage, variables, {
    providerOverride,
    returnsJson: true,
    source: tag || `scene-extract-${sourceKind}`,
  });

  return {
    extracted: sanitizeSceneList(result.content),
    runId: result.runId,
    providerId: result.providerId,
    model: result.model,
  };
}
