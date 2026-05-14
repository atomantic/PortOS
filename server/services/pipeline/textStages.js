/**
 * Pipeline — Text Stage Execution
 *
 * Runs a single text stage (idea / prose / comicScript / tvScript) against the
 * active LLM provider. Builds the prompt via promptService.buildPrompt — each
 * stage has its own template in data.sample/prompts/stages/pipeline-*.md and
 * is registered in data.sample/prompts/stage-config.json.
 *
 * The render context includes the series bible (logline, premise, characters,
 * styleNotes) plus every *prior* stage's output, so downstream stages can
 * reference upstream content with `{{stages.idea.output}}` etc.
 *
 * Errors bubble (per project convention — no try/catch) except at the SSE
 * boundary in autoRunner.js, which routes failures through a finalizer.
 */

import { runStagedLLM } from '../../lib/stageRunner.js';
import { getSeries, extractAndMergeIntoSeries } from './series.js';
import { getIssue, updateStage, TEXT_STAGE_IDS } from './issues.js';
import { getSeriesCanon } from './seriesCanon.js';
import { computeIssueTargets } from '../../lib/issueLength.js';

const STAGE_TO_TEMPLATE = Object.freeze({
  idea: 'pipeline-idea-expansion',
  prose: 'pipeline-prose',
  comicScript: 'pipeline-comic-script',
  tvScript: 'pipeline-tv-script',
});

/**
 * Build the variable bag fed into the stage template. Includes the series
 * bible (`series.*`) and every *prior* text stage's content (`stages.*`).
 * Visual stages aren't included — text templates don't need rendered images.
 */
function buildStageContext({ series, canon, issue, stageId, seedInput }) {
  const stages = {};
  for (const id of TEXT_STAGE_IDS) {
    if (id === stageId) break; // only include stages BEFORE the current one
    const cur = issue.stages?.[id] || {};
    stages[id] = {
      status: cur.status || 'empty',
      // Prefer the user-edited input over the raw LLM output when present —
      // matches how editors actually work the artifact.
      content: (cur.input?.trim() || cur.output?.trim() || ''),
    };
  }
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      styleNotes: series.styleNotes,
      universeId: series.universeId || '',
      characters: canon?.characters || series.characters || [],
    },
    issue: {
      number: issue.number,
      title: issue.title,
    },
    // Fed into every text template via {{lengthTargets.*}}. Always populated
    // (defaults to 'standard') so templates can use the fields unconditionally.
    lengthTargets: computeIssueTargets(issue),
    stages,
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
  const canon = await getSeriesCanon(series);

  await updateStage(issueId, stageId, { status: 'generating', errorMessage: '' });

  const ctx = buildStageContext({ series, canon, issue, stageId, seedInput: options.seedInput });

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
  const { issue: updatedIssue, stage } = await updateStage(issueId, stageId, {
    status: output ? 'ready' : 'error',
    output,
    lastRunId: result.runId,
    errorMessage: output ? '' : 'LLM returned empty response',
  });

  console.log(`✅ Pipeline stage — issue=${issueId.slice(0, 8)} stage=${stageId} runId=${result.runId} length=${output.length}`);

  // Only runs on `prose`: scripts derive from prose so new characters land here
  // first; idea is too short to extract usefully. Non-fatal — prose succeeded,
  // and a noisy extract shouldn't roll back the user's accepted draft.
  if (stageId === 'prose' && output) {
    await extractAndMergeIntoSeries(series.id, {
      corpus: output,
      providerOverride: options.providerId,
      parallel: true,
    }).catch((err) => {
      console.warn(`⚠️ Prose extraction failed for issue ${issueId.slice(0, 8)}: ${err.message}`);
    });
  }

  return { issue: updatedIssue, stage, runId: result.runId };
}

// Export internals for tests.
export const __testing = { buildStageContext, STAGE_TO_TEMPLATE };
