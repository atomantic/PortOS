/**
 * Pipeline — Canon descriptive-integrity readiness.
 *
 * Before the visual pipeline renders comic pages / storyboards, the canon
 * entities (characters / places / objects) that actually get DRAWN must be
 * adequately described — an artist can't render "Kai" from a name alone. This
 * is the production-readiness counterpart to the Nouns stage's per-noun gap
 * flagging: it gates *visual sign-off*, not authoring.
 *
 * The check matches canon against the VISUAL SOURCE text (the comic script's
 * panel descriptions for comics, the teleplay for TV) — NOT the prose. That
 * distinction matters: a character merely name-dropped in narration but never
 * shown in a panel (an off-page character) is never rendered, so a missing
 * description for it is a manuscript-quality note (surfaced on the Nouns page),
 * not a visual production blocker. Only nouns that appear where they'd be drawn
 * gate rendering.
 *
 * Deterministic — presence + length grading, no LLM. (The concurrent
 * "describe from prose" feature BACKFILLS descriptions with an LLM; this
 * VALIDATES that they exist before production. They're complementary.)
 */

import { getIssue, listIssues } from './issues.js';
import { getSeries } from './series.js';
import { getSeriesCanon } from './seriesCanon.js';
import { matchCharactersInText, matchPlacesInText, matchObjectsInText } from '../../lib/scenePrompt.js';

// Below this many characters a description is "thin" — present but too sparse to
// reliably render from. Advisory only; `none` (no description at all) is the
// blocking grade.
export const CANON_THIN_CHARS = 40;

// Per-kind: where the canon list lives, how to find references in text, and how
// to read the entity's renderable description (mirrors NounsStage's `descFor`).
const KINDS = [
  {
    kind: 'character',
    listKey: 'characters',
    match: matchCharactersInText,
    descOf: (e) => e.physicalDescription || e.description || '',
  },
  {
    kind: 'place',
    listKey: 'places',
    match: matchPlacesInText,
    descOf: (e) => [e.description, e.palette, e.recurringDetails].filter(Boolean).join('. '),
  },
  {
    kind: 'object',
    listKey: 'objects',
    match: matchObjectsInText,
    descOf: (e) => e.description || e.significance || '',
  },
];

export function gradeCanonDescription(descOf, entry, thinChars = CANON_THIN_CHARS) {
  const desc = (descOf(entry) || '').trim();
  if (!desc) return 'none';
  if (desc.length < thinChars) return 'thin';
  return 'sufficient';
}

/**
 * PURE: grade every canon noun that appears in `text`. Returns
 * `{ referenced, none[], thin[], ready }`. `none`/`thin` entries carry
 * `{ id, name, kind, locked }`. No I/O — caller supplies the text + canon.
 */
export function gradeReferencedNouns(text, canon, thinChars = CANON_THIN_CHARS) {
  const none = [];
  const thin = [];
  let referenced = 0;
  if (text && text.trim()) {
    for (const { kind, listKey, match, descOf } of KINDS) {
      const list = Array.isArray(canon?.[listKey]) ? canon[listKey] : [];
      for (const entry of match(text, list)) {
        referenced += 1;
        const grade = gradeCanonDescription(descOf, entry, thinChars);
        if (grade === 'none') none.push({ id: entry.id, name: entry.name, kind, locked: entry.locked === true });
        else if (grade === 'thin') thin.push({ id: entry.id, name: entry.name, kind, locked: entry.locked === true });
      }
    }
  }
  return { referenced, none, thin, ready: none.length === 0 };
}

// The text where nouns are actually depicted, by target format. Comic targets
// draw from the comic-script panel descriptions; TV from the teleplay. Fall
// back to prose only when the visual source is empty so a not-yet-adapted issue
// can still be sanity-checked.
function visualSourceText(issue, series) {
  const fmt = series?.targetFormat || 'comic+tv';
  const comic = issue.stages?.comicScript?.output || '';
  const tele = issue.stages?.teleplay?.output || '';
  const prose = issue.stages?.prose?.output || '';
  if (fmt === 'tv') return tele || prose;
  return comic || tele || prose;
}

/**
 * Canon readiness for one issue. Pass `canon`/`series` to avoid re-reads when
 * checking many issues. Returns
 * `{ issueId, number, title, referenced, none[], thin[], ready }`.
 */
export async function checkIssueCanonReadiness(issueId, { canon = null, series = null, thinChars = CANON_THIN_CHARS } = {}) {
  const issue = await getIssue(issueId);
  const ser = series || await getSeries(issue.seriesId).catch(() => null);
  const c = canon || (ser ? await getSeriesCanon(ser).catch(() => null) : null) || { characters: [], places: [], objects: [] };
  const text = visualSourceText(issue, ser);
  const { referenced, none, thin, ready } = gradeReferencedNouns(text, c, thinChars);
  return { issueId, number: issue.number, title: issue.title, referenced, none, thin, ready };
}

/**
 * Canon readiness across a whole series. Returns the per-issue reports plus a
 * series-level roll-up: `ready` (no issue has an undescribed drawn noun),
 * `blockingIssues[]`, and the de-duplicated `undescribed[]` noun list.
 */
export async function checkSeriesCanonReadiness(seriesId, { thinChars = CANON_THIN_CHARS } = {}) {
  const series = await getSeries(seriesId);
  const canon = await getSeriesCanon(series).catch(() => ({ characters: [], places: [], objects: [] }));
  const issues = await listIssues({ seriesId });
  const perIssue = [];
  for (const issue of issues) {
    perIssue.push(await checkIssueCanonReadiness(issue.id, { canon, series, thinChars }));
  }
  const blocking = perIssue.filter((r) => !r.ready);
  const noneById = new Map();
  for (const r of perIssue) {
    for (const n of r.none) if (!noneById.has(n.id)) noneById.set(n.id, n);
  }
  return {
    seriesId,
    ready: blocking.length === 0,
    issues: perIssue,
    blockingIssues: blocking.map((r) => ({ issueId: r.issueId, number: r.number, title: r.title, none: r.none })),
    undescribed: [...noneById.values()],
  };
}
