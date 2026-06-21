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
const VERIFY_PAGE_RE = /^##\s+Page\s+([\dIVX]+)\b/i;
const VERIFY_PANEL_RE = /^(?:###\s+)?Panel\s+([\dIVX]+)\s*(?:\([^)]+\))?\s*:?\s*$/i;
const VERIFY_FIELD_RE = /^(?:\*\*)?(Description|Caption(?:\s+\d+)?|Dialogue|SFX)\s*:(?:\*\*)?\s*(.*)$/i;
const EMPTY_DIALOGUE_RE = /^[-*]?\s*([A-Z][A-Z0-9 '"&./()\-]*?):\s*(?:"\s*"|'\s*'|“\s*”|‘\s*’)\s*$/;
const EXCERPT_MAX = 140;

function excerpt(text, max = EXCERPT_MAX) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

function emptyDialogueIssue(speaker, pageNumber, panelNumber) {
  const who = speaker.trim();
  return {
    severity: 'high',
    location: `page ${pageNumber || '?'} / panel ${panelNumber || '?'}`,
    problem: `The dialogue entry is malformed: ${who} is given an empty quoted line, leaving the letterer with an empty balloon to place.`,
    suggestion: 'Delete the empty dialogue line or replace it with a specific nonverbal SFX if the character is meant to react silently.',
  };
}

function missingDescriptionIssue(pageNumber, panelNumber, firstUnlabeledLine) {
  const firstLine = excerpt(firstUnlabeledLine);
  return {
    severity: 'high',
    location: `page ${pageNumber || '?'} / panel ${panelNumber || '?'}`,
    problem: firstLine
      ? `The panel is missing the required "Description:" label before "${firstLine}". This can make the panel disappear from parsing or break production handoff.`
      : 'The panel is missing the required "Description:" field, so the artist/image pipeline has no labeled frame description to render.',
    suggestion: firstLine
      ? 'Add `Description:` before the panel description and keep Caption, Dialogue, and SFX as separate labeled fields.'
      : 'Add a concrete `Description:` field for the panel before Caption, Dialogue, or SFX.',
  };
}

function findEmptyDialogueIssues(script) {
  if (typeof script !== 'string' || !script.trim()) return [];
  const issues = [];
  let pageNumber = '';
  let panelNumber = '';
  let activeField = null;

  const checkDialogueText = (text) => {
    const t = (text || '').trim();
    if (!t) return;
    const match = t.match(EMPTY_DIALOGUE_RE);
    if (match) {
      issues.push(emptyDialogueIssue(match[1], pageNumber, panelNumber));
    }
  };

  for (const raw of script.split(/\r?\n/)) {
    const line = raw || '';
    const pageMatch = line.match(VERIFY_PAGE_RE);
    if (pageMatch) {
      pageNumber = pageMatch[1];
      panelNumber = '';
      activeField = null;
      continue;
    }
    const panelMatch = line.match(VERIFY_PANEL_RE);
    if (panelMatch) {
      panelNumber = panelMatch[1];
      activeField = null;
      continue;
    }
    const fieldMatch = line.match(VERIFY_FIELD_RE);
    if (fieldMatch) {
      const label = fieldMatch[1].toLowerCase().replace(/\s+\d+$/, '').trim();
      activeField = label;
      if (label === 'dialogue') checkDialogueText(fieldMatch[2]);
      continue;
    }
    if (activeField === 'dialogue') checkDialogueText(line);
  }

  return shapeVerifyIssues(issues);
}

function findMissingDescriptionIssues(script) {
  if (typeof script !== 'string' || !script.trim()) return [];
  const issues = [];
  let pageNumber = '';
  let panelNumber = '';
  let inPanel = false;
  let hasDescription = false;
  let firstUnlabeledLine = '';
  let activeField = null;

  const flushPanel = () => {
    if (!inPanel) return;
    if (!hasDescription) {
      issues.push(missingDescriptionIssue(pageNumber, panelNumber, firstUnlabeledLine));
    }
  };

  for (const raw of script.split(/\r?\n/)) {
    const line = raw || '';
    const pageMatch = line.match(VERIFY_PAGE_RE);
    if (pageMatch) {
      flushPanel();
      pageNumber = pageMatch[1];
      panelNumber = '';
      inPanel = false;
      hasDescription = false;
      firstUnlabeledLine = '';
      activeField = null;
      continue;
    }

    const panelMatch = line.match(VERIFY_PANEL_RE);
    if (panelMatch) {
      flushPanel();
      panelNumber = panelMatch[1];
      inPanel = true;
      hasDescription = false;
      firstUnlabeledLine = '';
      activeField = null;
      continue;
    }

    if (!inPanel) continue;

    const fieldMatch = line.match(VERIFY_FIELD_RE);
    if (fieldMatch) {
      const label = fieldMatch[1].toLowerCase().replace(/\s+\d+$/, '').trim();
      activeField = label;
      if (label === 'description') hasDescription = true;
      continue;
    }

    const t = line.trim();
    if (!t) continue;
    if (!hasDescription && !activeField && !firstUnlabeledLine) {
      firstUnlabeledLine = t;
    }
  }

  flushPanel();
  return shapeVerifyIssues(issues);
}

function findDeterministicIssues(script) {
  return mergeVerifyIssues(
    findMissingDescriptionIssues(script),
    findEmptyDialogueIssues(script),
  );
}

function issueKey(issue) {
  return `${issue.severity}|${issue.location}|${issue.problem}`;
}

function mergeVerifyIssues(first, second) {
  const out = [];
  const seen = new Set();
  for (const issue of [...(first || []), ...(second || [])]) {
    const key = issueKey(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/**
 * Verify the comic script of one issue. Returns
 * `{ issues:[{severity,location,problem,suggestion}], raw, runId, providerId,
 * model }`, or `{ issues: [], skipped }` when there's no comic script to check.
 */
export async function verifyComicScript(issueId, { providerId, model } = {}) {
  const issue = await getIssue(issueId);
  const script = (issue.stages?.comicScript?.output || '').trim();
  if (!script) return { issues: [], skipped: 'no-comic-script' };
  const deterministicIssues = findDeterministicIssues(script);

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

  return {
    issues: mergeVerifyIssues(deterministicIssues, shapeVerifyIssues(parsed?.issues)),
    raw: parsed,
    runId,
    providerId: pid,
    model: m,
  };
}

export const __testing = {
  findDeterministicIssues,
  findEmptyDialogueIssues,
  findMissingDescriptionIssues,
  mergeVerifyIssues,
};
