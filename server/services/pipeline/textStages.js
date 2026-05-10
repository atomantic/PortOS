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

import { buildPrompt } from '../promptService.js';
import { getActiveProvider, getProviderById } from '../providers.js';
import { executeApiRun, executeCliRun, createRun } from '../runner.js';
import { getSeries } from './series.js';
import { getIssue, updateStage, TEXT_STAGE_IDS } from './issues.js';

const STAGE_TO_TEMPLATE = Object.freeze({
  idea: 'pipeline-idea-expansion',
  prose: 'pipeline-prose',
  comicScript: 'pipeline-comic-script',
  tvScript: 'pipeline-tv-script',
});

const isCliProvider = (provider) => provider?.type === 'cli';

// Wraps executeCliRun / executeApiRun as a Promise. Mirrors the pattern in
// worldBuilderExpand.js#callLLM — both runner entry points are async and can
// reject before onComplete fires, so we forward those rejections through the
// outer Promise instead of letting them surface as unhandledRejection.
async function callLLM(provider, model, prompt) {
  const { runId } = await createRun({
    providerId: provider.id,
    model,
    prompt,
    source: 'pipeline-text-stage',
  });
  return new Promise((resolve, reject) => {
    let text = '';
    if (isCliProvider(provider)) {
      executeCliRun(
        runId,
        provider,
        prompt,
        process.cwd(),
        (chunk) => { text += chunk; },
        (result) => {
          if (result?.error || result?.success === false) {
            reject(new Error(result?.error || 'CLI execution failed'));
          } else {
            resolve({ text, runId });
          }
        },
        provider.timeout ?? 300000,
      ).catch(reject);
    } else {
      executeApiRun(
        runId,
        provider,
        model,
        prompt,
        process.cwd(),
        [],
        (data) => { text += typeof data === 'string' ? data : (data?.text || ''); },
        (result) => {
          if (result?.error) reject(new Error(result.error));
          else resolve({ text, runId });
        },
      ).catch(reject);
    }
  });
}

/**
 * Build the variable bag fed into the stage template. Includes the series
 * bible (`series.*`) and every *prior* text stage's content (`stages.*`).
 * Visual stages aren't included — text templates don't need rendered images.
 */
function buildStageContext({ series, issue, stageId, seedInput }) {
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
      worldId: series.worldId || '',
      characters: series.characters || [],
    },
    issue: {
      number: issue.number,
      title: issue.title,
    },
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

  await updateStage(issueId, stageId, { status: 'generating', errorMessage: '' });

  const ctx = buildStageContext({ series, issue, stageId, seedInput: options.seedInput });
  const prompt = await buildPrompt(template, ctx);

  let provider = options.providerId ? await getProviderById(options.providerId).catch(() => null) : null;
  if (!provider) provider = await getActiveProvider();
  if (!provider) {
    await updateStage(issueId, stageId, {
      status: 'error',
      errorMessage: 'No AI provider available',
    });
    throw new Error('No AI provider available for pipeline text stage');
  }
  const model = options.model || provider.defaultModel || provider.models?.[0] || null;

  console.log(`📝 Pipeline stage — issue=${issueId.slice(0, 8)} stage=${stageId} provider=${provider.name}/${model || 'default'}`);

  // Catch only at this boundary so the stage record persists the failure
  // before the error bubbles to the caller — without this, an LLM throw
  // would leave the stage stuck in `generating` forever.
  let text;
  let runId;
  try {
    ({ text, runId } = await callLLM(provider, model, prompt));
  } catch (err) {
    await updateStage(issueId, stageId, {
      status: 'error',
      errorMessage: (err?.message || String(err)).slice(0, 4000),
    });
    throw err;
  }

  const output = (text || '').trim();
  const { issue: updatedIssue, stage } = await updateStage(issueId, stageId, {
    status: output ? 'ready' : 'error',
    output,
    lastRunId: runId,
    errorMessage: output ? '' : 'LLM returned empty response',
  });

  console.log(`✅ Pipeline stage — issue=${issueId.slice(0, 8)} stage=${stageId} runId=${runId} length=${output.length}`);
  return { issue: updatedIssue, stage, runId };
}

// Export internals for tests.
export const __testing = { buildStageContext, STAGE_TO_TEMPLATE };
