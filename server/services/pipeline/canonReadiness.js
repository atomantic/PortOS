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
import { parseComicScript } from '../../lib/comicScriptParser.js';
import {
  matchCharactersInText, matchPlacesInText, matchObjectsInText,
  matchSceneCharacters, buildCharByKey,
} from '../../lib/scenePrompt.js';

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

// Grade pre-matched entries per kind into none/thin buckets.
function gradeMatched({ characters = [], places = [], objects = [] }, thinChars) {
  const none = [];
  const thin = [];
  let referenced = 0;
  const descOfKind = { character: KINDS[0].descOf, place: KINDS[1].descOf, object: KINDS[2].descOf };
  const push = (entry, kind) => {
    referenced += 1;
    const grade = gradeCanonDescription(descOfKind[kind], entry, thinChars);
    if (grade === 'none') none.push({ id: entry.id, name: entry.name, kind, locked: entry.locked === true });
    else if (grade === 'thin') thin.push({ id: entry.id, name: entry.name, kind, locked: entry.locked === true });
  };
  for (const c of characters) push(c, 'character');
  for (const p of places) push(p, 'place');
  for (const o of objects) push(o, 'object');
  return { referenced, none, thin, ready: none.length === 0 };
}

/**
 * PURE: grade every canon noun that appears in free `text`. Used for the TV /
 * fallback path (whole teleplay/prose). For comics use
 * `gradeComicReferencedNouns`, which matches only the drawable panel text.
 */
export function gradeReferencedNouns(text, canon, thinChars = CANON_THIN_CHARS) {
  if (!text || !text.trim()) return { referenced: 0, none: [], thin: [], ready: true };
  return gradeMatched({
    characters: matchCharactersInText(text, canon?.characters || []),
    places: matchPlacesInText(text, canon?.places || []),
    objects: matchObjectsInText(text, canon?.objects || []),
  }, thinChars);
}

// A panel-body line like `MAGGIE: Kai called.` or `CAPTION: Years later.` —
// captures the leading ALL-CAPS label and the body. parseComicScript folds
// these into the panel `description` rather than a structured dialogue[], so we
// classify them here: the body is spoken/caption text (NOT drawn), the label is
// a potential speaker.
const PANEL_LABEL_LINE = /^\s*([A-Z][A-Z0-9 .'’_-]{0,30})(?:\s*\([^)]*\))?:\s*\S/;
// Labels that are not characters (their "speaker" must not count as drawn).
const NON_SPEAKER_LABELS = new Set(['CAPTION', 'SFX', 'SOUND', 'NARRATION', 'NARRATOR', 'TITLE', 'NOTE', 'LETTERING', 'TEXT']);

/**
 * PURE: grade canon nouns that appear where they'd actually be DRAWN in a comic.
 * Splits each panel's text into visual ACTION lines vs `LABEL:` dialogue/caption
 * lines: characters/places/objects are matched against the action lines only,
 * plus characters who SPEAK (a dialogue label or a structured dialogue speaker).
 * So a character merely named inside someone's dialogue body ("Kai called") is
 * NOT treated as a drawn reference, while a character shown in a panel or
 * speaking a line is.
 */
export function gradeComicReferencedNouns(comicScript, canon, thinChars = CANON_THIN_CHARS) {
  const { pages } = parseComicScript(comicScript || '');
  const actionLines = [];
  const speakers = [];
  const consume = (text) => {
    for (const line of String(text || '').split('\n')) {
      const m = line.match(PANEL_LABEL_LINE);
      if (m) {
        const label = m[1].trim();
        if (!NON_SPEAKER_LABELS.has(label.toUpperCase())) speakers.push(label);
        // the body of a dialogue/caption line is spoken/overlaid text, not drawn
      } else {
        actionLines.push(line);
      }
    }
  };
  for (const pg of Array.isArray(pages) ? pages : []) {
    for (const pa of Array.isArray(pg.panels) ? pg.panels : []) {
      consume(pa.description);
      for (const d of Array.isArray(pa.dialogue) ? pa.dialogue : []) {
        if (d.character) speakers.push(d.character);
      }
    }
  }
  const haystack = actionLines.join('\n');
  const chars = canon?.characters || [];
  // Characters drawn = named in panel action ∪ speaking a line.
  const drawn = new Map();
  for (const c of matchCharactersInText(haystack, chars)) drawn.set(c.id || c.name, c);
  for (const c of matchSceneCharacters(speakers, buildCharByKey(chars))) drawn.set(c.id || c.name, c);
  return gradeMatched({
    characters: [...drawn.values()],
    places: matchPlacesInText(haystack, canon?.places || []),
    objects: matchObjectsInText(haystack, canon?.objects || []),
  }, thinChars);
}

// Fallback free-text source when there's no parseable comic script: TV draws
// from the teleplay, anything else from teleplay-or-prose. (Comic targets with
// a comic script go through gradeComicReferencedNouns, not this.)
function fallbackSourceText(issue) {
  return issue.stages?.teleplay?.output || issue.stages?.prose?.output || '';
}

/**
 * Canon readiness for one issue. Pass `canon`/`series` to avoid re-reads when
 * checking many issues. Returns
 * `{ issueId, number, title, referenced, none[], thin[], ready }`.
 *
 * Comic targets with a comic script grade against the DRAWABLE text only (panel
 * descriptions + dialogue speakers) so an off-page character named only in
 * narration/dialogue body isn't a false blocker; everything else grades the
 * teleplay/prose.
 */
export async function checkIssueCanonReadiness(issueId, { canon = null, series = null, thinChars = CANON_THIN_CHARS } = {}) {
  const issue = await getIssue(issueId);
  const ser = series || await getSeries(issue.seriesId).catch(() => null);
  const c = canon || (ser ? await getSeriesCanon(ser).catch(() => null) : null) || { characters: [], places: [], objects: [] };
  const fmt = ser?.targetFormat || 'comic+tv';
  const comic = (issue.stages?.comicScript?.output || '').trim();
  const graded = (fmt !== 'tv' && comic)
    ? gradeComicReferencedNouns(comic, c, thinChars)
    : gradeReferencedNouns(fallbackSourceText(issue), c, thinChars);
  return { issueId, number: issue.number, title: issue.title, referenced: graded.referenced, none: graded.none, thin: graded.thin, ready: graded.ready };
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
