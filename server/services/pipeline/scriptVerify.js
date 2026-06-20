/**
 * Pipeline — Comic Script Verification (craft pass)
 *
 * Runs the `pipeline-script-verify` stage over ONE issue's comic script to
 * catch craft breaks that would make the script fail to function as a comic
 * script (un-renderable panels, malformed page/panel structure, panel-to-panel
 * flow breaks, dialogue/art imbalance, within-issue continuity, page-turn
 * placement) — before the visual pipeline burns GPU on broken pages.
 *
 * Extraction-only, mirrors `verifyArc` (arcCore.js): returns the shaped issues
 * list; the caller (Series Autopilot's scriptVerify step) decides what to do
 * with them. Content is budgeted to the target model's context window the same
 * way editorialAnalysis does, so a big script isn't truncated harder than
 * necessary.
 */

import { runStagedLLM, resolveStageContext } from '../../lib/stageRunner.js';
import { usableInputTokens, estimateTokens, CHARS_PER_TOKEN } from '../../lib/contextBudget.js';
import { getIssue } from './issues.js';
import { getSeries } from './series.js';
import { shapeVerifyIssues } from './arcPlanner.js';

const STAGE = 'pipeline-script-verify';
const CONTENT_MAX = 48_000;
const OUTPUT_RESERVE_TOKENS = 2_000;

/**
 * Verify the comic script of one issue. Returns
 * `{ issues:[{severity,location,problem,suggestion}], raw, runId, providerId,
 * model }`, or `{ issues: [], skipped }` when there's no comic script to check.
 */
export async function verifyComicScript(issueId, { providerId, model } = {}) {
  const issue = await getIssue(issueId);
  const script = (issue.stages?.comicScript?.output || '').trim();
  if (!script) return { issues: [], skipped: 'no-comic-script' };

  const series = await getSeries(issue.seriesId).catch(() => null);

  // Scale the content cap to the target model's context window — never below
  // CONTENT_MAX (so we never truncate more than the historical floor), but a
  // big-context model gets the whole script. Mirrors editorialAnalysis.
  const { contextWindow } = await resolveStageContext(STAGE, { providerOverride: providerId, modelOverride: model });
  const overheadTokens = 1_200 + estimateTokens([series?.name, series?.logline, issue.title].filter(Boolean).join(' '));
  const budgetChars = usableInputTokens({
    contextWindow,
    overheadTokens,
    outputReserveTokens: OUTPUT_RESERVE_TOKENS,
  }) * CHARS_PER_TOKEN;
  const contentMax = Math.max(CONTENT_MAX, budgetChars);
  const content = script.length > contentMax
    ? `${script.slice(0, contentMax)}\n\n[script truncated for verification — ${script.length} chars total]`
    : script;

  const ctx = {
    series: { name: series?.name || 'Untitled series', logline: series?.logline || '' },
    issue: { number: issue.number ?? '', title: issue.title || '' },
    script: content,
  };

  const { content: parsed, runId, providerId: pid, model: m } = await runStagedLLM(STAGE, ctx, {
    returnsJson: true,
    providerOverride: providerId,
    modelOverride: model,
    source: 'pipeline-script-verify',
  });

  return { issues: shapeVerifyIssues(parsed?.issues), raw: parsed, runId, providerId: pid, model: m };
}
