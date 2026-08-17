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

/**
 * PURE: the canon text this check actually grades, as a stable projection for
 * input hashing (#4111). Reads the SAME `descOf` accessors the grading uses, so
 * a caller pinning "the canon this verdict was computed from" can never drift
 * from what readiness reads. Entries are sorted by id/name so an unrelated
 * re-order (a sync import, a drag-reorder) doesn't look like an edit.
 */
export function canonDescriptionInputs(canon) {
  return Object.fromEntries(KINDS.map(({ kind, listKey, descOf }) => [
    kind,
    (Array.isArray(canon?.[listKey]) ? canon[listKey] : [])
      .map((e) => ({
        id: e?.id || '',
        name: e?.name || '',
        locked: e?.locked === true,
        description: descOf(e || {}) || '',
      }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name)),
  ]));
}

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
// Group 2 captures the parenthetical modifier (if any) so we can tell an
// on-panel delivery (WHISPERED, CONT'D) from an off-panel one.
const PANEL_LABEL_LINE = /^\s*([A-Z][A-Z0-9 .'’_-]{0,30})(\s*\([^)]*\))?:\s*\S/;
// Labels that are not characters (their "speaker" must not count as drawn).
const NON_SPEAKER_LABELS = new Set(['CAPTION', 'SFX', 'SOUND', 'NARRATION', 'NARRATOR', 'TITLE', 'NOTE', 'LETTERING', 'TEXT']);
// A dialogue modifier marking the speaker as NOT in frame — off-panel /
// off-screen / voice-over. Such a speaker is heard, not drawn, so it must not
// count as a rendered character.
const OFF_PANEL_MODIFIER = /\b(?:off[\s-]?panel|off[\s-]?screen|o\.?\s*p\.?|o\.?\s*s\.?|v\.?\s*o\.?|voice[\s-]?over)\b/i;

// Resolve a raw "NAME (MODIFIER)" speaker token to the drawn character name, or
// null when the modifier marks them off-panel/voice-over (heard, not drawn).
const drawnSpeakerName = (label, modifier) => {
  if (OFF_PANEL_MODIFIER.test(modifier || '')) return null;
  const name = (label || '').trim();
  return name || null;
};

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
        if (!NON_SPEAKER_LABELS.has(label.toUpperCase())) {
          const name = drawnSpeakerName(label, m[2]); // null if off-panel/V.O.
          if (name) speakers.push(name);
        }
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
        // Split a `KAI (WHISPERED)` / `KAI (OFF-PANEL)` speaker into name +
        // modifier so the name matches canon and an off-panel speaker (heard,
        // not drawn) is dropped — same rule as the description-line path.
        const parts = (d.character || '').match(/^(.*?)(\s*\([^)]*\))?\s*$/);
        const name = parts && drawnSpeakerName(parts[1], parts[2]);
        if (name) speakers.push(name);
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

const requiredVisualStages = (targetFormat) => {
  if (targetFormat === 'comic') return ['comicScript'];
  if (targetFormat === 'tv') return ['teleplay'];
  return ['comicScript', 'teleplay'];
};

const resolveVisualStages = (targetFormat, sourceStages) => {
  if (!Array.isArray(sourceStages) || sourceStages.length === 0) {
    return requiredVisualStages(targetFormat);
  }
  const scoped = [...new Set(sourceStages.filter((stageId) => stageId === 'comicScript' || stageId === 'teleplay'))];
  return scoped.length > 0 ? scoped : requiredVisualStages(targetFormat);
};

function mergeGrades(grades) {
  const none = new Map();
  const thin = new Map();
  let referenced = 0;
  for (const grade of grades) {
    referenced += grade.referenced;
    for (const entry of grade.none) {
      const key = `${entry.kind}:${entry.id || entry.name}`;
      none.set(key, entry);
      thin.delete(key);
    }
    for (const entry of grade.thin) {
      const key = `${entry.kind}:${entry.id || entry.name}`;
      if (!none.has(key)) thin.set(key, entry);
    }
  }
  return { referenced, none: [...none.values()], thin: [...thin.values()], ready: none.size === 0 };
}

/**
 * Canon readiness for one issue. Pass `canon`/`series` to avoid re-reads when
 * checking many issues. Returns
 * `{ issueId, number, title, referenced, none[], thin[], ready }`.
 *
 * Comic sources grade against the DRAWABLE text only (panel descriptions +
 * dialogue speakers) so an off-page character named only in dialogue body
 * isn't a false blocker. TV sources grade the teleplay. A prose draft or empty
 * outline is not a visual source and therefore cannot produce a vacuous
 * `ready:true`; hybrid series require both parallel-format scripts unless a
 * caller explicitly scopes `sourceStages` to the format it is about to render.
 */
export async function checkIssueCanonReadiness(issueId, {
  canon = null,
  series = null,
  thinChars = CANON_THIN_CHARS,
  sourceStages = null,
} = {}) {
  const issue = await getIssue(issueId);
  const ser = series || await getSeries(issue.seriesId).catch(() => null);
  const c = canon || (ser ? await getSeriesCanon(ser).catch(() => null) : null) || { characters: [], places: [], objects: [] };
  const fmt = ser?.targetFormat || 'comic+tv';
  const visualStages = resolveVisualStages(fmt, sourceStages);
  const sourceText = Object.fromEntries(visualStages.map((stageId) => [
    stageId,
    (issue.stages?.[stageId]?.output || '').trim(),
  ]));
  const missingSourceStages = visualStages.filter((stageId) => !sourceText[stageId]);
  const grades = visualStages.flatMap((stageId) => {
    const text = sourceText[stageId];
    if (!text) return [];
    return [stageId === 'comicScript'
      ? gradeComicReferencedNouns(text, c, thinChars)
      : gradeReferencedNouns(text, c, thinChars)];
  });
  const graded = mergeGrades(grades);
  const ready = missingSourceStages.length === 0 && graded.ready;
  return {
    issueId,
    number: issue.number,
    title: issue.title,
    referenced: graded.referenced,
    none: graded.none,
    thin: graded.thin,
    ready,
    sourceStages: visualStages,
    missingSourceStages,
    blockingReason: missingSourceStages.length > 0
      ? 'missing-visual-source'
      : (graded.ready ? null : 'undescribed-canon'),
  };
}

/**
 * Canon readiness across a whole series. Returns the per-issue reports plus a
 * series-level roll-up: `ready` (no issue has an undescribed drawn noun),
 * `blockingIssues[]`, and the de-duplicated `undescribed[]` noun list.
 */
export async function checkSeriesCanonReadiness(seriesId, { thinChars = CANON_THIN_CHARS, sourceStages = null } = {}) {
  const series = await getSeries(seriesId);
  const canon = await getSeriesCanon(series).catch(() => ({ characters: [], places: [], objects: [] }));
  const issues = await listIssues({ seriesId });
  const perIssue = [];
  for (const issue of issues) {
    perIssue.push(await checkIssueCanonReadiness(issue.id, {
      canon, series, thinChars, sourceStages,
    }));
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
    blockingIssues: blocking.map((r) => ({
      issueId: r.issueId,
      number: r.number,
      title: r.title,
      none: r.none,
      missingSourceStages: r.missingSourceStages,
      blockingReason: r.blockingReason,
    })),
    undescribed: [...noneById.values()],
  };
}
