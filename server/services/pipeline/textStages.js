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

  if (!season) {
    return {
      arc: arcBlock,
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
  // canon-block token cost — `series.characters` already covers the bible-
  // sized character context, this adds places/objects + other characters not
  // pulled into the series-canon for continuity anchors.
  const worldEntitiesSummary = world
    ? (renderEntitiesSummary(world) || '(none)')
    : NO_LINKED_UNIVERSE_PLACEHOLDER;
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      styleNotes: series.styleNotes,
      universeId: series.universeId || '',
      characters: canon?.characters || [],
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
export const __testing = { buildStageContext, buildIdeaContextAugment, shapeNeighborForIdeaPrompt, resolveSourceStageIds, STAGE_TO_TEMPLATE, STAGE_LABELS, DEFAULT_FORWARD_SOURCE };
