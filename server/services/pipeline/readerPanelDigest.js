/**
 * Pipeline — Reader-panel arc digest builder (#2170, CWQE Phase 6).
 *
 * A reader panel of four personas shouldn't be handed the raw 75k-word
 * manuscript — it reads a condensed, content-hash-pinned digest. Per issue the
 * digest carries a short summary, a ~150-word opening + closing excerpt, and the
 * top few dialogue lines, reusing `reverseOutline.js` scene segmentation (scene
 * `summary`s) where available and falling back to the drafted text otherwise.
 *
 * The pure assembly helpers (`buildIssueDigest`, `renderDigestText`, excerpt /
 * dialogue extraction) are exported for unit testing; `buildDigestForSeries`
 * wires the I/O (issues + scenes + series record).
 */

import { createHash } from 'crypto';
import { pickAnalyzableContent } from './editorialAnalysis.js';
import { getSceneSegmentation } from './reverseOutline.js';
import { listIssues } from './issues.js';
import { getSeries } from './series.js';

const OPENING_WORDS = 150;
const CLOSING_WORDS = 150;
const SUMMARY_SENTENCES = 3;
const DIALOGUE_LINES = 3;
const SUMMARY_MAX = 600;

const nowIso = () => new Date().toISOString();

// Collapse whitespace so word/sentence slicing isn't skewed by markdown blank
// lines. Strips markdown heading/emphasis markers that would leak into excerpts.
function normalizeText(text) {
  return String(text || '')
    .replace(/[*_`#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function firstWords(text, n = OPENING_WORDS) {
  const words = normalizeText(text).split(' ').filter(Boolean);
  if (words.length <= n) return words.join(' ');
  return `${words.slice(0, n).join(' ')}…`;
}

export function lastWords(text, n = CLOSING_WORDS) {
  const words = normalizeText(text).split(' ').filter(Boolean);
  if (words.length <= n) return words.join(' ');
  return `…${words.slice(words.length - n).join(' ')}`;
}

export function firstSentences(text, n = SUMMARY_SENTENCES) {
  const clean = normalizeText(text);
  if (!clean) return '';
  const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
  return sentences.slice(0, n).join(' ').trim().slice(0, SUMMARY_MAX);
}

/**
 * Pull the strongest dialogue lines out of drafted prose/script text — a simple
 * pure heuristic (double-quoted spans of a sensible length), deduped and capped.
 * Comic/teleplay dialogue that isn't quoted just yields fewer lines; the panel
 * still gets summary + excerpts.
 */
export function extractDialogueLines(text, n = DIALOGUE_LINES) {
  const clean = String(text || '').replace(/[“”]/g, '"').replace(/\s+/g, ' ');
  const matches = clean.match(/"([^"]{8,160})"/g) || [];
  const out = [];
  const seen = new Set();
  for (const m of matches) {
    const line = m.slice(1, -1).trim();
    const key = line.toLowerCase();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= n) break;
  }
  return out;
}

// A 3-sentence summary, preferring the reverse-outline scene summaries for the
// issue (already condensed, editor-authored) and falling back to the opening of
// the drafted text.
function summarize(scenes, text) {
  const sceneSummaries = scenes
    .map((s) => (typeof s?.summary === 'string' ? s.summary.trim() : ''))
    .filter(Boolean);
  if (sceneSummaries.length) {
    return sceneSummaries.slice(0, SUMMARY_SENTENCES).join(' ').slice(0, SUMMARY_MAX);
  }
  return firstSentences(text, SUMMARY_SENTENCES);
}

/**
 * Build one issue's digest from its drafted text + the scenes segmented for it.
 * Pure — callers supply the text and the (already issue-filtered) scenes.
 */
export function buildIssueDigest({ number, title, text, scenes = [] }) {
  const body = String(text || '');
  return {
    number: Number.isInteger(number) ? number : null,
    title: title || `Issue ${number ?? ''}`.trim(),
    summary: summarize(scenes, body),
    opening: firstWords(body, OPENING_WORDS),
    closing: lastWords(body, CLOSING_WORDS),
    dialogue: extractDialogueLines(body, DIALOGUE_LINES),
    sceneCount: scenes.length,
  };
}

// Render the structured digest into the compact markdown a persona prompt reads.
export function renderDigestText(digest) {
  const parts = [];
  for (const iss of digest.issues || []) {
    const lines = [`### Issue #${iss.number}: ${iss.title}`];
    if (iss.summary) lines.push(`Summary: ${iss.summary}`);
    if (iss.opening) lines.push(`Opening: ${iss.opening}`);
    if (iss.closing) lines.push(`Closing: ${iss.closing}`);
    if (iss.dialogue?.length) lines.push(`Notable dialogue:\n${iss.dialogue.map((d) => `- “${d}”`).join('\n')}`);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

const digestContentHash = (issues) =>
  createHash('sha256')
    .update(issues.map((i) => `${i.number}:${i.text || ''}`).sort().join('\n'))
    .digest('hex');

/**
 * Build the full series digest the panel reads. Only issues with drafted
 * reader-facing content are included. Returns the structured digest plus a
 * `sourceContentHash` pinning the analyzed drafts (so a later edit flips the
 * stored panel to stale) and the `issueNumbers` present (the citation allow-list
 * for disagreement mining).
 */
export async function buildDigestForSeries(seriesId, { issues: issuesArg, series: seriesArg } = {}) {
  const issues = Array.isArray(issuesArg) ? issuesArg : await listIssues({ seriesId });
  const series = seriesArg !== undefined ? seriesArg : await getSeries(seriesId).catch(() => null);
  const segmentation = await getSceneSegmentation(seriesId).catch(() => ({ scenes: [] }));
  const scenesByNumber = new Map();
  for (const scene of segmentation.scenes || []) {
    const num = scene?.issueNumber;
    if (!Number.isInteger(num)) continue;
    if (!scenesByNumber.has(num)) scenesByNumber.set(num, []);
    scenesByNumber.get(num).push(scene);
  }

  const ordered = [...issues].sort(
    (a, b) => (a.arcPosition ?? 9999) - (b.arcPosition ?? 9999) || (a.number || 0) - (b.number || 0)
  );

  const withContent = [];
  for (const issue of ordered) {
    const picked = pickAnalyzableContent(issue);
    if (!picked) continue;
    withContent.push({ number: issue.number, title: issue.title, text: picked.text });
  }

  const digests = withContent.map((iss) =>
    buildIssueDigest({ number: iss.number, title: iss.title, text: iss.text, scenes: scenesByNumber.get(iss.number) || [] })
  );

  return {
    seriesId,
    seriesName: series?.name || 'Untitled series',
    logline: series?.logline || '',
    issueCount: digests.length,
    issueNumbers: withContent.map((i) => i.number).filter(Number.isInteger),
    issues: digests,
    sourceContentHash: digestContentHash(withContent),
    generatedAt: nowIso(),
  };
}

export const __testing = { normalizeText, summarize, digestContentHash };
