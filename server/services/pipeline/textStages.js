/**
 * Pipeline — Text Stage Execution
 *
 * Runs a single text stage (idea / prose / comicScript / teleplay) against the
 * active LLM provider. Builds the prompt via promptService.buildPrompt — each
 * stage has its own template in data.reference/prompts/stages/pipeline-*.md and
 * is registered in data.reference/prompts/stage-config.json.
 *
 * The render context includes the series bible (logline, premise, characters,
 * styleNotes) plus every *prior* stage's output, so downstream stages can
 * reference upstream content with `{{stages.idea.output}}` etc.
 *
 * Errors bubble (per project convention — no try/catch) except at the SSE
 * boundary in autoRunner.js, which routes failures through a finalizer.
 */

import { runStagedLLM } from '../../lib/stageRunner.js';
import { getSeries } from './series.js';
import { extractCanonFromProse, summarizeCanonExtraction } from '../universeCanon.js';
import { getIssue, listIssues, updateStage, assertStageUnlocked, TEXT_STAGE_IDS } from './issues.js';
import { getSeriesCanon } from './seriesCanon.js';
import { getUniverse } from '../universeBuilder.js';
import { compareIssuesByPosition, NO_LINKED_UNIVERSE_PLACEHOLDER } from './arcPlanner.js';
import { computeIssueTargets } from '../../lib/issueLength.js';
import { renderEntitiesSummary } from '../../lib/universePromptRenderers.js';
import { composeStyleNotes } from '../../lib/styleGuide.js';
import { renderTickingClock } from '../../lib/storyArc.js';
import { matchCharactersInText } from '../../lib/scenePrompt.js';

const STAGE_TO_TEMPLATE = Object.freeze({
  idea: 'pipeline-idea-expansion',
  prose: 'pipeline-prose',
  comicScript: 'pipeline-comic-script',
  teleplay: 'pipeline-teleplay',
});

// Human labels for the {{#sourceMaterials}} block so the LLM sees "Comic Script"
// rather than "comicScript". Mirrors the client's PIPELINE_STAGE_LABELS.
const STAGE_LABELS = Object.freeze({
  idea: 'Idea / Beat Sheet',
  prose: 'Prose Draft',
  comicScript: 'Comic Script',
  teleplay: 'Teleplay',
});

// The stage that conventionally feeds each target when no explicit source is
// chosen — mirrors the strict forward chain. Idea has no upstream text stage
// (it derives from the seed); comic/teleplay both adapt prose. Used to compute
// the default source set so autoRunner and the legacy UI path are unchanged.
const DEFAULT_FORWARD_SOURCE = Object.freeze({
  prose: ['idea'],
  comicScript: ['prose'],
  teleplay: ['prose'],
});

// User-edited input takes precedence over raw LLM output — matches how editors
// actually work the artifact. Exported so backfill paths (storyBuilder) read a
// stage's content through the same precedence rule.
export const stageContentOf = (stage) => (stage?.input?.trim() || stage?.output?.trim() || '');

// Set exactly one of `beats` / `synopsis` per neighbor so the prompt's
// beat-level guidance doesn't leak into synopsis-only entries (the template
// gates on each field independently).
function shapeNeighborForIdeaPrompt(iss) {
  if (!iss) return null;
  const beats = (iss.stages?.idea?.output || '').trim();
  const synopsis = (iss.stages?.idea?.input || '').trim();
  const base = {
    number: iss.number,
    title: iss.title,
    arcPosition: iss.arcPosition,
    arcRole: iss.arcRole || null,
  };
  return beats ? { ...base, beats } : { ...base, synopsis };
}

// Mirrors the writer's working frame when drafting beats: whole-series arc
// + parent volume + immediate-neighbor issues. Other text stages (prose,
// comicScript, teleplay) don't need it — they derive from beats which
// already encode it.
async function buildIdeaContextAugment(series, issue) {
  const seasons = Array.isArray(series.seasons) ? series.seasons : [];
  const season = issue.seasonId ? seasons.find((s) => s.id === issue.seasonId) : null;

  // Arc block — only when the series actually has generated arc content
  // (shape-only arcs aren't enough context for the LLM to lean on).
  const arc = series.arc;
  const hasArcText = !!(arc && (arc.logline || arc.summary || arc.protagonistArc || arc.themes?.length));
  const arcBlock = hasArcText
    ? {
        logline: arc.logline || '',
        summary: arc.summary || '',
        protagonistArc: arc.protagonistArc || '',
        themesCsv: Array.isArray(arc.themes) ? arc.themes.join(', ') : '',
      }
    : null;

  // Ticking clock — a pre-rendered guidance string (or null when the clock is
  // absent or toggled off). Surfaced as its own template section, independent
  // of `arcBlock`: a clock is the author's explicit decision that the story
  // *has* a countdown, so it must steer the beats even on a clock-only arc with
  // no logline/summary/themes. `renderTickingClock` already gates on
  // `tickingClock.enabled === true`.
  const tickingClock = renderTickingClock(arc?.tickingClock);

  if (!season) {
    return {
      arc: arcBlock,
      tickingClock,
      volume: null,
      arcRole: issue.arcRole || null,
      positionInVolume: null,
      priorIssue: null,
      nextIssue: null,
      priorVolume: null,
    };
  }

  const allIssues = await listIssues({ seriesId: series.id });
  const volumeIssues = allIssues
    .filter((i) => i.seasonId === season.id)
    .sort(compareIssuesByPosition);
  const idx = volumeIssues.findIndex((i) => i.id === issue.id);
  const priorIssue = idx > 0 ? shapeNeighborForIdeaPrompt(volumeIssues[idx - 1]) : null;
  const nextIssue = idx >= 0 && idx < volumeIssues.length - 1
    ? shapeNeighborForIdeaPrompt(volumeIssues[idx + 1])
    : null;
  const positionInVolume = idx >= 0
    ? { ordinal: idx + 1, total: volumeIssues.length }
    : null;

  // Prior volume — only relevant when this issue opens its volume (no prior
  // siblings within the same volume). Use the season number sequence (not
  // creation order) so out-of-order seasons still produce the right neighbor.
  let priorVolume = null;
  if (idx <= 0) {
    const sortedSeasons = seasons
      .slice()
      .sort((a, b) => (a.number || 0) - (b.number || 0));
    const seasonIdx = sortedSeasons.findIndex((s) => s.id === season.id);
    if (seasonIdx > 0) {
      const prev = sortedSeasons[seasonIdx - 1];
      priorVolume = {
        number: prev.number,
        title: prev.title || '',
        endingHook: prev.endingHook || '',
      };
    }
  }

  return {
    arc: arcBlock,
    tickingClock,
    volume: {
      number: season.number,
      title: season.title || '',
      logline: season.logline || '',
      synopsis: season.synopsis || '',
      endingHook: season.endingHook || '',
      episodeCountTarget: season.episodeCountTarget || 0,
      themesCsv: Array.isArray(season.themes) ? season.themes.join(', ') : '',
    },
    arcRole: issue.arcRole || null,
    positionInVolume,
    priorIssue,
    nextIssue,
    priorVolume,
  };
}

/**
 * Resolve the ordered list of stage ids whose content should feed this
 * generation as source material.
 *
 * - When `sourceStageIds` is provided (non-empty), use exactly those — this is
 *   the backport path (e.g. generate prose FROM comicScript). Each id must be a
 *   valid text stage, must not be the target stage itself, and must have
 *   content; anything failing those checks is dropped.
 * - When omitted/empty, fall back to the conventional forward source(s) that
 *   have content — so the auto-runner and the legacy UI behave exactly as before.
 *
 * Returned in TEXT_STAGE_IDS order for stable prompt rendering.
 */
function resolveSourceStageIds({ issue, stageId, sourceStageIds }) {
  const requested = new Set(Array.isArray(sourceStageIds)
    ? sourceStageIds
    : DEFAULT_FORWARD_SOURCE[stageId] || []);
  return TEXT_STAGE_IDS.filter((id) =>
    requested.has(id)
    && id !== stageId
    && stageContentOf(issue.stages?.[id]));
}

// A character's free-text `role` reads as a principal when it names a lead /
// recurring archetype. Used only as the fallback when an issue's source text
// names no canon character (a thinly-seeded early issue) — better to ship the
// series principals than the whole 68-character cast.
const PRINCIPAL_ROLE_RE = /\b(main|lead|protagonist|principal|recurring|primary|hero|central)\b/i;

// Word-boundary, case-insensitive containment test (same escaping the bible
// matcher in scenePrompt.js uses). Local copy so the first-name supplement below
// doesn't have to widen the shared matcher (which `canonReadiness` also calls).
const wordInText = (needle, haystack) => {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
};

// First-name token of a multi-word canon name ("Mira Reyes" → "Mira"). Drafts
// routinely refer to a character by first name only after introduction, which
// the full-name/alias matcher (whole-name word boundary) misses — so a clearly
// in-issue character would lose their full record. Single-word names need no
// supplement (the matcher already handles them).
const firstNameToken = (c) => {
  const parts = String(c?.name || '').trim().split(/\s+/);
  return parts.length > 1 ? parts[0] : '';
};

/**
 * Scope the full-record character bible to the cast relevant to THIS issue (#1511).
 *
 * Injecting every canon character's full record into every issue's prose and
 * comic-script prompt is the token-bloat this addresses: a 68-character bible is
 * ~52K tokens re-sent on every issue × every stage, when most issues feature a
 * handful of the cast. We keep full records only for characters the issue's own
 * source text names (via the bible matcher PLUS a first-name supplement), and let
 * the always-present compact `worldEntitiesSummary` roster carry the rest of the
 * cast for continuity refs.
 *
 * Matching errs toward INCLUSION: the first-name supplement can over-match a
 * shared/common-word first name, but the ceiling is the whole cast (the old
 * behavior), so it never drops a featured character — only ever costs a little
 * extra budget. Under-matching, by contrast, would silently strip an in-issue
 * character's bible from a draft that features them.
 *
 * Fallback order — never returns an empty block:
 *   1. characters named in the issue's source text (full name/alias OR first name);
 *   2. else the series principals (lead/recurring `role`);
 *   3. else the whole cast (no signal at all — preserve prior behavior).
 */
export function scopeCharactersForIssue(allCharacters, scopeText) {
  if (!Array.isArray(allCharacters) || allCharacters.length === 0) return [];
  const byKey = new Map();
  for (const c of matchCharactersInText(scopeText, allCharacters)) byKey.set(c.id || c.name, c);
  if (scopeText) {
    for (const c of allCharacters) {
      const key = c.id || c.name;
      if (!byKey.has(key) && wordInText(firstNameToken(c), scopeText)) byKey.set(key, c);
    }
  }
  if (byKey.size) return [...byKey.values()];
  const principals = allCharacters.filter((c) => PRINCIPAL_ROLE_RE.test(c?.role || ''));
  if (principals.length) return principals;
  return allCharacters;
}

/**
 * Concatenate the text that defines an issue's scope — its title, the unsaved
 * `seedInput` driving this run (the idea stage generates beats straight from it,
 * so a character named only in the seed must still be matched), synopsis
 * (`idea.input`), beat sheet (`idea.output`), and whatever source stages this
 * generation adapts from — into one haystack for the character matcher.
 */
function buildIssueScopeText(issue, sourceMaterials, seedInput) {
  return [
    issue.title,
    seedInput,
    issue.stages?.idea?.input,
    issue.stages?.idea?.output,
    ...sourceMaterials.map((s) => s.content),
  ].filter(Boolean).join('\n\n');
}

/**
 * Build the variable bag fed into the stage template. Includes the series
 * bible (`series.*`) and every *prior* text stage's content (`stages.*`), plus
 * a source-agnostic `sourceMaterials` array (the stages explicitly chosen as
 * source, defaulting to the conventional forward source).
 * Visual stages aren't included — text templates don't need rendered images.
 */
function buildStageContext({ series, canon, world, issue, stageId, seedInput, sourceStageIds }) {
  const stages = {};
  for (const id of TEXT_STAGE_IDS) {
    if (id === stageId) break; // only include stages BEFORE the current one
    const cur = issue.stages?.[id] || {};
    stages[id] = {
      status: cur.status || 'empty',
      // Prefer the user-edited input over the raw LLM output when present —
      // matches how editors actually work the artifact.
      content: stageContentOf(cur),
    };
  }
  // Source-agnostic block: whichever stages were chosen (or the conventional
  // default) rendered as labeled blocks. This is what lets a target stage adapt
  // from ANY other populated stage — generate prose from a comic script, or
  // backfill the beat sheet from finished prose.
  const sourceMaterials = resolveSourceStageIds({ issue, stageId, sourceStageIds })
    .map((id) => ({ stageId: id, label: STAGE_LABELS[id] || id, content: stageContentOf(issue.stages?.[id]) }));
  // Compact one-line-per-kind synopsis of the linked universe's canon. Lets
  // per-issue text prompts reference named entities without paying the full
  // canon-block token cost — `series.characters` carries full records only for
  // the issue-relevant cast (scoped below), and this compact roster covers the
  // rest of the cast plus places/objects for continuity anchors. Characters are
  // rendered UNCAPPED here (`maxPerKind: { characters: Infinity }`): because the
  // full-record block is now scoped, the roster is the only place a non-featured
  // character is represented, so it must list the whole cast or a mid-bible
  // character would vanish from the prompt entirely. Places/objects stay at the
  // default cap — they were never full-record-injected, so their behavior is
  // unchanged.
  const worldEntitiesSummary = world
    ? (renderEntitiesSummary(world, { maxPerKind: { characters: Infinity } }) || '(none)')
    : NO_LINKED_UNIVERSE_PLACEHOLDER;
  // Scope the heavyweight full-record character block to the cast this issue
  // actually involves (#1511) — full records only for characters named in the
  // issue's source text, principals as fallback, never empty. The compact
  // roster above keeps the whole cast known for naming/continuity.
  const scopedCharacters = scopeCharactersForIssue(
    canon?.characters || [],
    buildIssueScopeText(issue, sourceMaterials, seedInput),
  );
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      // Fold the structured style guide (tense/POV/rating/reading-level/tone/
      // conventions) into the free-text styleNotes the template already renders,
      // so prose/script generation honors house style with no new template
      // variable (and thus no stage-prompt migration). See composeStyleNotes.
      styleNotes: composeStyleNotes(series),
      universeId: series.universeId || '',
      characters: scopedCharacters,
    },
    issue: {
      number: issue.number,
      title: issue.title,
    },
    worldEntitiesSummary,
    // Fed into every text template via {{lengthTargets.*}}. Always populated
    // (defaults to 'standard') so templates can use the fields unconditionally.
    lengthTargets: computeIssueTargets(issue),
    stages,
    sourceMaterials,
    // Scalar guard for templates that want a one-time header before the
    // {{#sourceMaterials}} loop — the engine can't nest same-name sections.
    hasSourceMaterials: sourceMaterials.length > 0,
    seed: (seedInput || issue.stages?.[stageId]?.input || '').trim(),
  };
}

/**
 * Run one text stage end-to-end:
 *   1. Mark the stage `generating`.
 *   2. Build the prompt via promptService.buildPrompt(<template>, ctx).
 *   3. Call the LLM (active provider unless overridden).
 *   4. Persist the response as `stages.<stageId>.output` with `status: ready`.
 *
 * Returns { issue, stage, runId }.
 *
 * On error, marks the stage `error` with the message and rethrows so the
 * caller (route or autoRunner) can react.
 */
export async function generateStage(issueId, stageId, options = {}) {
  if (!TEXT_STAGE_IDS.includes(stageId)) {
    throw new Error(`generateStage: unsupported stageId "${stageId}"`);
  }
  const template = STAGE_TO_TEMPLATE[stageId];
  const issue = await getIssue(issueId);
  const series = await getSeries(issue.seriesId);
  // Universe canon is best-effort — an orphaned series (no universeId) or a
  // missing universe record just skips the entities summary instead of
  // failing the run.
  const [canon, world] = await Promise.all([
    getSeriesCanon(series),
    series.universeId ? getUniverse(series.universeId).catch(() => null) : Promise.resolve(null),
  ]);

  // Per-stage editorial lock — refuse before touching the stage record so a
  // locked stage doesn't get bumped to 'generating' status only to be reset.
  // Sibling to the arc / season checks elsewhere in the planner; any of the
  // three rejects.
  assertStageUnlocked(issue, stageId);

  await updateStage(issueId, stageId, { status: 'generating', errorMessage: '' });

  const ctx = buildStageContext({
    series, canon, world, issue, stageId,
    seedInput: options.seedInput,
    sourceStageIds: options.sourceStageIds,
  });
  if (stageId === 'idea') {
    Object.assign(ctx, await buildIdeaContextAugment(series, issue));
  }

  // Catch only at this boundary so the stage record persists the failure
  // before the error bubbles to the caller — without this, an LLM throw
  // would leave the stage stuck in `generating` forever.
  let result;
  try {
    result = await runStagedLLM(template, ctx, {
      providerOverride: options.providerId,
      modelOverride: options.model,
      source: 'pipeline-text-stage',
    });
  } catch (err) {
    await updateStage(issueId, stageId, {
      status: 'error',
      errorMessage: (err?.message || String(err)).slice(0, 4000),
    });
    throw err;
  }

  const output = (result.content || '').trim();
  let { issue: updatedIssue, stage } = await updateStage(issueId, stageId, {
    status: output ? 'ready' : 'error',
    output,
    lastRunId: result.runId,
    errorMessage: output ? '' : 'LLM returned empty response',
  });

  console.log(`✅ Pipeline stage — issue=${issueId.slice(0, 8)} stage=${stageId} runId=${result.runId} length=${output.length}`);

  // Only runs on `prose`: scripts derive from prose so new characters land here
  // first; idea is too short to extract usefully. Non-fatal — prose succeeded,
  // and a noisy extract shouldn't roll back the user's accepted draft.
  // Phase B.4: canon lives on the universe, so an orphan series (no
  // universeId) silently skips extraction — the prose write still
  // succeeds, the user just doesn't get the bible auto-populated until
  // they link a universe.
  if (stageId === 'prose' && output && series.universeId) {
    // Stamp new inserts as series-extracted: autoLock prevents a later AI
    // refine/differentiate from silently rewriting prose-derived canon, and
    // sourceSeriesId attributes them to the triggering series. Matches the
    // pre-B.4 `extractAndMergeIntoSeries` semantics so existing-data behavior
    // is preserved.
    // Persist the extraction outcome on the prose stage (success, partial, or
    // failed) so the Nouns UI can surface a banner and let the user retry with
    // a different provider/model. Still non-fatal — a noisy extract shouldn't
    // roll back the user's accepted prose draft. The stamp is best-effort: if
    // even the stamp write fails we only warn (no throw out of the prose path).
    //
    // Record only the override actually forwarded to the extractor (not a
    // series.llm fallback) — the extract call below passes bare
    // `options.providerId`/`options.model`, so when those are undefined the
    // extractor resolves to the global active provider. Claiming
    // `series.llm.provider` here would make the banner misreport which provider
    // failed. Empty string = "used the default/active provider".
    const provider = options.providerId || '';
    const model = options.model || '';
    const marker = await extractCanonFromProse(series.universeId, {
      corpus: output,
      providerOverride: options.providerId,
      modelOverride: options.model,
      parallel: true,
      autoLock: true,
      sourceSeriesId: series.id,
    }).then(
      ({ results, failures }) => summarizeCanonExtraction({ results, failures, provider, model }),
      (err) => {
        console.warn(`⚠️ Prose extraction failed for issue ${issueId.slice(0, 8)}: ${err.message}`);
        return summarizeCanonExtraction({ error: err, provider, model });
      },
    );
    // Use the stamped issue/stage as the return value so callers (and the
    // socket update) carry the fresh canonExtraction marker, not the pre-stamp
    // snapshot. Best-effort: on a stamp-write failure we keep the pre-stamp
    // values.
    const stamped = await updateStage(issueId, 'prose', { canonExtraction: marker }).catch((err) => {
      console.warn(`⚠️ Failed to record canon-extraction status for issue ${issueId.slice(0, 8)}: ${err.message}`);
      return null;
    });
    if (stamped) ({ issue: updatedIssue, stage } = stamped);
  }

  return { issue: updatedIssue, stage, runId: result.runId };
}

// Export internals for tests.
export const __testing = { buildStageContext, buildIdeaContextAugment, shapeNeighborForIdeaPrompt, resolveSourceStageIds, scopeCharactersForIssue, buildIssueScopeText, STAGE_TO_TEMPLATE, STAGE_LABELS, DEFAULT_FORWARD_SOURCE };
