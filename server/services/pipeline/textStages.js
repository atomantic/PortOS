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

import { runStagedLLM, resolveStageContext } from '../../lib/stageRunner.js';
import { getSeries } from './series.js';
import { extractCanonFromProse, summarizeCanonExtraction } from '../universeCanon.js';
import { getIssue, listIssues, updateStage, assertStageUnlocked, TEXT_STAGE_IDS } from './issues.js';
import { getSeriesCanon } from './seriesCanon.js';
import { getUniverse } from '../universeBuilder.js';
import { compareIssuesByPosition, NO_LINKED_UNIVERSE_PLACEHOLDER } from './arcPlanner.js';
import { computeIssueTargets, assessSynopsisScope } from '../../lib/issueLength.js';
import { renderEntitiesSummary } from '../../lib/universePromptRenderers.js';
import { composeStyleNotes } from '../../lib/styleGuide.js';
import { renderTickingClock } from '../../lib/storyArc.js';
import { filterCanonForIssue } from '../../lib/storyBible.js';
import { usableInputTokens, trimContextToBudget, CHARS_PER_TOKEN } from '../../lib/contextBudget.js';

const STAGE_TO_TEMPLATE = Object.freeze({
  idea: 'pipeline-idea-expansion',
  prose: 'pipeline-prose',
  comicScript: 'pipeline-comic-script',
  teleplay: 'pipeline-teleplay',
});

// Stages whose template renders the compact `worldEntitiesSummary` roster and can
// therefore safely receive a SCOPED `series.characters` block (#1511) — the roster
// is the continuity safety net for the un-scoped cast. The idea stage is excluded:
// it generates the beat sheet straight from the seed (it needs the whole cast as a
// creative palette) and its template renders NO roster, so a scoped block there
// would drop characters with no fallback. New stages default to the full cast
// until explicitly added here.
const ROSTER_BACKED_STAGES = new Set(['prose', 'comicScript', 'teleplay']);

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

// Resolve an issue's position within its volume plus its immediate siblings —
// the shared ordering contract behind both the idea-stage neighbor context and
// the prose-stage cross-issue continuity. Loads WITHOUT run history: neighbor
// resolution only needs id / position / stage content, never the (potentially
// large) per-stage runHistory arrays. Returns raw issue records so each caller
// can shape them for its own template. An ungrouped issue (no season) or one
// that isn't found in its volume yields `idx: -1` and null siblings.
async function resolveVolumeNeighbors(series, issue) {
  const seasonId = issue.seasonId;
  if (!seasonId) return { volumeIssues: [], idx: -1, prior: null, next: null };
  const allIssues = await listIssues({ seriesId: series.id, withHistory: false });
  const volumeIssues = allIssues
    .filter((i) => i.seasonId === seasonId)
    .sort(compareIssuesByPosition);
  const idx = volumeIssues.findIndex((i) => i.id === issue.id);
  return {
    volumeIssues,
    idx,
    prior: idx > 0 ? volumeIssues[idx - 1] : null,
    next: idx >= 0 && idx < volumeIssues.length - 1 ? volumeIssues[idx + 1] : null,
  };
}

// Mirrors the writer's working frame when drafting beats: whole-series arc
// + parent volume + immediate-neighbor issues. Other text stages (prose,
// comicScript, teleplay) don't need it — they derive from beats which
// already encode it.
async function buildIdeaContextAugment(series, issue, seedOverride = '') {
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

  // Scope-discipline signal: a terse synopsis on a long length profile tempts
  // the beat sheet to pad by absorbing the next issue's events (#1513). The
  // template gates a "do not pad past scope" warning on this flag. Assess the
  // seed actually being expanded — an explicit seedInput override is what the
  // template renders into {{seed}}, so the signal must track it, not the
  // (possibly stale) stored synopsis.
  const { paddingRisk } = assessSynopsisScope(
    seedOverride || issue.stages?.idea?.input || '',
    computeIssueTargets(issue),
  );

  if (!season) {
    return {
      arc: arcBlock,
      tickingClock,
      paddingRisk,
      volume: null,
      arcRole: issue.arcRole || null,
      positionInVolume: null,
      priorIssue: null,
      nextIssue: null,
      priorVolume: null,
    };
  }

  const { volumeIssues, idx, prior, next } = await resolveVolumeNeighbors(series, issue);
  const priorIssue = shapeNeighborForIdeaPrompt(prior);
  const nextIssue = shapeNeighborForIdeaPrompt(next);
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
    paddingRisk,
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

// Target size of the previous issue's prose tail (in chars) before token
// budgeting. ~2000 chars ≈ the last few paragraphs — enough for the model to
// pick up the closing beat + voice at the seam, matching autonovel's
// last-~2000-char injection. The budgeter trims below this on a small window.
const PRIOR_PROSE_TAIL_CHARS = 2_000;
// Fraction of the resolved usable input budget the two continuity blocks may
// consume in total, split across the prior-prose tail and the next-issue beats.
// Continuity is a NICE-TO-HAVE relative to the bible + source material, so it
// yields first on a tight window rather than crowding out the actual beats.
const CONTINUITY_BUDGET_FRACTION = 0.25;
// When both blocks are present, the prior-prose tail keeps priority (voice-at-
// the-seam is the higher-value signal); the next-issue beats reclaim whatever
// the trimmed tail leaves unused.
const PRIOR_TAIL_SHARE = 0.6;

/**
 * Extract the last `maxChars` of an issue's prose, cut on a paragraph boundary
 * when one falls in the last third of the slice so the tail reads as a coherent
 * passage rather than mid-sentence. Returns '' for absent/blank prose so the
 * template's `{{#priorIssueProseTail}}` section simply doesn't render (no fake
 * continuity — issue task #3).
 */
function extractProseTail(text, maxChars = PRIOR_PROSE_TAIL_CHARS) {
  const s = String(text ?? '').trim();
  const cap = Math.max(0, Math.floor(maxChars));
  if (!s || cap === 0) return '';
  if (s.length <= cap) return s;
  const slice = s.slice(s.length - cap);
  // Prefer starting at a paragraph break so the tail opens cleanly — but only
  // if that break isn't so late it throws away most of the budget.
  const nl = slice.indexOf('\n\n');
  const body = nl >= 0 && nl < cap * 0.33 ? slice.slice(nl + 2) : slice;
  return body.trim();
}

/**
 * Head of the next issue's beat sheet (idea stage) — its opening beats, so this
 * issue can END so it hands off to them. Prefers the expanded beats
 * (`idea.output`), falls back to the synopsis (`idea.input`); '' when neither
 * exists so the block doesn't render.
 */
function extractNextIssueBeats(iss) {
  if (!iss) return '';
  return (iss.stages?.idea?.output || '').trim() || (iss.stages?.idea?.input || '').trim();
}

/**
 * Cross-issue prose continuity (#2177 / CWQE Phase 12). Only the `prose` stage
 * uses it: inject the PREVIOUS issue's actual closing prose (last ~2000 chars)
 * and the NEXT issue's opening beats so chapter boundaries flow and the voice
 * carries across units — the gap autonovel closed by feeding the prior chapter's
 * tail + next chapter's outline head into every draft.
 *
 * Both blocks are token-budgeted via `contextBudget.js` so a small-context model
 * degrades by trimming, not erroring. When the prior issue's prose doesn't exist
 * yet (non-linear / parallel generation, or this is the first issue of the
 * volume) the block simply doesn't render — no fabricated continuity.
 *
 * Same neighbor resolution as `buildIdeaContextAugment`: sort the volume's issues
 * by canonical position and take the immediate siblings. An ungrouped issue (no
 * season) has no resolvable neighbors, so it returns empty blocks.
 */
async function buildProseContextAugment(series, issue, options = {}) {
  const empty = { priorIssueProseTail: '', nextIssueBeats: '', hasNeighborContinuity: false };

  const { prior, next } = await resolveVolumeNeighbors(series, issue);
  const priorProse = prior ? stageContentOf(prior.stages?.prose) : '';
  const rawBeats = extractNextIssueBeats(next);
  if (!priorProse && !rawBeats) return empty;

  // Token-budget both blocks so they degrade by trimming on a small window
  // rather than blowing the prompt. Resolve the prose stage's planning window
  // (best-effort — a runtime provider fallback isn't reflected, matching every
  // other budgeting caller) and reserve a fraction of the usable input for
  // continuity. usableInputTokens already substitutes a conservative floor for a
  // null/zero window, so no extra fallback is needed here.
  const { contextWindow } = await resolveStageContext('pipeline-prose', {
    providerOverride: options.providerId,
    providerDefault: options.providerIdDefault,
    modelOverride: options.model,
    modelDefault: options.modelIdDefault,
  }).catch(() => ({ contextWindow: null }));
  const usableTokens = usableInputTokens({ contextWindow });
  const continuityChars = Math.max(0, Math.floor(usableTokens * CONTINUITY_BUDGET_FRACTION)) * CHARS_PER_TOKEN;

  // Prose tail keeps priority; next beats reclaim whatever the tail doesn't use.
  // The tail must be trimmed from its HEAD (keep the actual CLOSING of the prior
  // issue — the seam the template tells the model to flow from), so size it via
  // extractProseTail (which keeps the end) rather than trimContextToBudget (which
  // keeps the head and would discard the literal final lines on a small window).
  // Never grow past PRIOR_PROSE_TAIL_CHARS just because the window is large.
  const tailBudget = rawBeats ? Math.floor(continuityChars * PRIOR_TAIL_SHARE) : continuityChars;
  const priorIssueProseTail = priorProse
    ? extractProseTail(priorProse, Math.min(PRIOR_PROSE_TAIL_CHARS, tailBudget))
    : '';
  const beatsBudget = continuityChars - priorIssueProseTail.length;
  const nextIssueBeats = rawBeats ? trimContextToBudget(rawBeats, Math.max(0, beatsBudget)) : '';

  return {
    priorIssueProseTail,
    nextIssueBeats,
    hasNeighborContinuity: !!(priorIssueProseTail || nextIssueBeats),
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

// Word-boundary, case-insensitive containment test (same Unicode-aware boundary
// the bible matcher in scenePrompt.js uses — lookarounds over `[\p{L}\p{N}_]` so
// accented first names like "José" still match). Local copy so the first-name
// supplement below doesn't have to widen the shared matcher (`canonReadiness`
// also calls it).
const wordInText = (needle, haystack) => {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(haystack);
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

// Proper-noun variant of `wordInText` (#1529): the match counts only when an
// occurrence appears with an UPPERCASE first letter — so "Will entered" / "WILL"
// match, but mid-sentence "the team will regroup" does not. We scan all
// word-boundary occurrences case-insensitively (the `i` flag), then accept only if
// at least one has a capitalized initial. A sentence-initial capital ("Will the
// team…") still matches — that's the safe over-inclusion direction.
const properNounInText = (needle, haystack) => {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
  for (const m of String(haystack || '').matchAll(re)) {
    const ch = m[0][0];
    // An uppercase cased letter: `ch === toUpperCase` AND `ch !== toLowerCase`
    // (rules out digits/symbols, whose upper- and lower-case forms are equal).
    if (ch && ch === ch.toUpperCase() && ch !== ch.toLowerCase()) return true;
  }
  return false;
};

// Reliable "this issue names them" signal with a proper-noun guard for single-word
// names (#1529). `matchCharactersInText` is case-insensitive — correct for visual
// stages and shared with `canonReadiness`, so we refine LOCALLY rather than widen it.
// A character whose FULL NAME is a single common English word ("Will"/"May"/"Grace")
// otherwise matches incidentally on ordinary prose ("the team will regroup"), and one
// incidental hit can scope a prompt down to that lone character. So here a single-word
// NAME must appear in its CAPITALIZED form to count; multi-word names and ALL aliases
// keep the case-insensitive word-boundary match (a multi-word phrase or a nickname is
// essentially never an incidental common-word collision).
const matchReliableNames = (scopeText, allCharacters) => {
  if (!scopeText || !Array.isArray(allCharacters)) return [];
  const matched = [];
  for (const c of allCharacters) {
    const name = String(c?.name || '').trim();
    const nameHit = name && !/\s/.test(name)
      ? properNounInText(name, scopeText)   // single-word name → proper-noun guard
      : wordInText(name, scopeText);        // multi-word name → as-is
    const aliasHit = (c?.aliases || []).some((a) => wordInText(a, scopeText));
    if (nameHit || aliasHit) matched.push(c);
  }
  return matched;
};

/**
 * Scope the full-record character bible to the cast relevant to THIS issue (#1511).
 *
 * Injecting every canon character's full record into every issue's prose and
 * comic-script prompt is the token-bloat this addresses: a 68-character bible is
 * ~52K tokens re-sent on every issue × every stage, when most issues feature a
 * handful of the cast. We keep full records for: (a) the series PRINCIPALS (always
 * — the lead/recurring core is in play every issue), plus (b) any character the
 * issue's own source text names. The always-present compact `worldEntitiesSummary`
 * roster carries the rest of the cast for continuity refs.
 *
 * Two confidence tiers keep an incidental match from defeating the safety nets:
 *   - RELIABLE signals — the series principals (an unconditional FLOOR, so an
 *     incidental match can never SUPPRESS the leads) and full-name/alias matches.
 *   - WEAK signal — the first-name supplement, which errs toward inclusion (a
 *     common-word token like "will" in "the team will regroup" can spuriously
 *     match "Will Stone"). It only ADDS to an already-reliable scope; it never
 *     counts as the signal that suppresses the whole-cast fallback.
 *
 * So when there is NO reliable signal (no principals tagged AND no full-name
 * match — e.g. an untagged early-bible cast), the result is the whole cast, even
 * if a first-name token happened to match: better to ship the full bible than to
 * let "will" scope the prompt down to "Will Stone" and drop everyone else. The
 * block is therefore never empty.
 *
 * Precision guard (#1529): a character whose own name IS a common word (a cast
 * member literally named "Will"/"May"/"Grace") would otherwise match incidentally
 * via the case-insensitive full-name matcher and count as reliable — scoping the
 * issue down to that one character. The reliable-signal matcher (`matchReliableNames`)
 * therefore requires a SINGLE-WORD name to appear in its capitalized form, so "the
 * team will regroup" no longer counts as naming a character called "Will", while
 * "Will entered" still does. Multi-word names and aliases keep the case-insensitive
 * match. Residual: a sentence-initial capital ("Will the team…") still matches, but
 * that's the safe over-inclusion direction (the character keeps its full record) —
 * and even a true miss is non-lossy, since the uncapped `worldEntitiesSummary` roster
 * still carries every un-scoped character's one-line continuity entry.
 */
export function scopeCharactersForIssue(allCharacters, scopeText) {
  if (!Array.isArray(allCharacters) || allCharacters.length === 0) return [];
  const byKey = new Map();
  // (a) Principals floor — always in play, never suppressible by an incidental match.
  for (const c of allCharacters) {
    if (PRINCIPAL_ROLE_RE.test(c?.role || '')) byKey.set(c.id || c.name, c);
  }
  // (b) Full-name / alias matches — a reliable "this issue names them" signal,
  // with a proper-noun guard so a single-word common-name ("Will"/"Grace") doesn't
  // scope on an incidental lowercase hit (#1529).
  for (const c of matchReliableNames(scopeText, allCharacters)) byKey.set(c.id || c.name, c);
  // Principals + full-name matches are the trustworthy signal. A first-name-only
  // match is NOT, on its own, enough to suppress the whole-cast fallback below.
  const hasReliableSignal = byKey.size > 0;
  // (c) First-name supplement — additive only ("Mira" → "Mira Reyes").
  if (scopeText) {
    for (const c of allCharacters) {
      const key = c.id || c.name;
      if (!byKey.has(key) && wordInText(firstNameToken(c), scopeText)) byKey.set(key, c);
    }
  }
  // Reliable signal → the scoped set (incl. any first-name additions). No reliable
  // signal → the whole cast (which already contains any incidental first-name hit).
  return hasReliableSignal ? [...byKey.values()] : allCharacters;
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
  // Reveal-gated canon / spoiler scoping (#2178). Filter the writer-facing canon
  // to this issue's reveal horizon BEFORE it's scoped or rostered: a canon fact
  // gated to a later issue is dropped (or reduced to its spoiler-free
  // `surfaceDescriptor`) so the drafting prompt can't leak a reveal early. Both
  // the full-record character block AND the compact world roster are filtered —
  // they read the same universe arrays, so filtering one is not enough. Absent
  // gate fields = always visible (full backward compat). The judge (#2167) and
  // editorial checks bypass this and receive the FULL canon.
  const revealCanon = filterCanonForIssue(canon, issue.number);
  const revealWorld = world ? { ...world, ...filterCanonForIssue(world, issue.number) } : world;
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
  // Scope the heavyweight full-record character block to the cast this issue
  // actually involves (#1511) — full records for the principals plus characters
  // named in the issue's source text. Only the roster-backed stages are scoped
  // (see ROSTER_BACKED_STAGES); the idea stage keeps the full cast.
  const scopedCharacters = ROSTER_BACKED_STAGES.has(stageId)
    ? scopeCharactersForIssue(revealCanon.characters, buildIssueScopeText(issue, sourceMaterials, seedInput))
    : revealCanon.characters;
  // Compact one-line-per-kind synopsis of the linked universe's canon. Lets
  // per-issue text prompts reference named entities without paying the full
  // canon-block token cost. The roster carries the REST of the cast — everyone
  // NOT rendered as a full record in `series.characters` — plus places/objects,
  // so a scoped-out character is still represented for naming/continuity and is
  // never duplicated (excludeCharacterNames drops the scoped set). Characters are
  // uncapped here (`maxPerKind: { characters: Infinity }`) because the roster is
  // the ONLY place the non-scoped cast appears: the default top-8 cap would make
  // a large-cast series silently drop mid-bible characters from the prompt.
  const scopedCharacterNames = new Set(
    scopedCharacters.map((c) => (c?.name || '').trim().toLowerCase()).filter(Boolean),
  );
  const worldEntitiesSummary = revealWorld
    ? (renderEntitiesSummary(revealWorld, {
      maxPerKind: { characters: Infinity },
      excludeCharacterNames: scopedCharacterNames,
    }) || '(none)')
    : NO_LINKED_UNIVERSE_PLACEHOLDER;
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
    Object.assign(ctx, await buildIdeaContextAugment(series, issue, options.seedInput));
    if (ctx.paddingRisk) {
      console.log(`⚠️ Pipeline idea — issue=${issueId.slice(0, 8)} terse synopsis vs ${ctx.lengthTargets?.profile} profile: scope-discipline guard engaged`);
    }
  } else if (stageId === 'prose') {
    // Cross-issue prose continuity (#2177): the previous issue's closing prose
    // tail + the next issue's opening beats, token-budgeted. Covers every full
    // prose (re)generation path — manual route, autoRunner, and Series Autopilot
    // — because they all funnel through generateStage.
    Object.assign(ctx, await buildProseContextAugment(series, issue, options));
    if (ctx.hasNeighborContinuity) {
      console.log(`🔗 Pipeline prose — issue=${issueId.slice(0, 8)} continuity: priorTail=${ctx.priorIssueProseTail.length}c nextBeats=${ctx.nextIssueBeats.length}c`);
    }
  }

  // Catch only at this boundary so the stage record persists the failure
  // before the error bubbles to the caller — without this, an LLM throw
  // would leave the stage stuck in `generating` forever.
  let result;
  try {
    result = await runStagedLLM(template, ctx, {
      providerOverride: options.providerId,
      // Soft run-level default (Series Autopilot, #1514): unlike providerId it
      // loses to a per-stage pin and soft-falls-through to active when
      // unavailable. Route callers pass providerId (hard); autopilot passes
      // providerIdDefault (soft).
      providerDefault: options.providerIdDefault,
      modelOverride: options.model,
      // Soft run-level model default (Series Autopilot, #1558): loses to a
      // per-stage `model` pin, mirroring providerIdDefault. Route callers pass
      // model (hard); autopilot passes modelIdDefault (soft).
      modelDefault: options.modelIdDefault,
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
    // Canon extraction follows whichever provider drove this prose stage — the
    // manual route's hard `providerId` OR Series Autopilot's run provider
    // (#1514 moved the autopilot from `providerId` to `providerIdDefault`, so
    // fall back to it here; without this the just-generated prose would extract
    // on the global active provider instead of the run's provider). The
    // extractor takes a hard `providerOverride` (it has no stage pins of its own
    // to honor), and a throw on an unavailable provider is non-fatal — caught
    // below into a failed-extraction marker. Record only the provider actually
    // forwarded (not a series.llm fallback) so the banner can't misreport which
    // provider failed. Empty string = "used the default/active provider".
    const extractProvider = options.providerId ?? options.providerIdDefault;
    // Mirror the provider fallback for the model dimension (#1558): the hard
    // route model wins, else the autopilot's soft run model — so the just-
    // generated prose extracts canon on the run's model, not the active
    // provider's default. extractCanonFromProse takes a hard modelOverride (it
    // has no stage pins of its own).
    const extractModel = options.model ?? options.modelIdDefault;
    const provider = extractProvider || '';
    const model = extractModel || '';
    const marker = await extractCanonFromProse(series.universeId, {
      corpus: output,
      providerOverride: extractProvider,
      modelOverride: extractModel,
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
export const __testing = { buildStageContext, buildIdeaContextAugment, buildProseContextAugment, resolveVolumeNeighbors, extractProseTail, extractNextIssueBeats, shapeNeighborForIdeaPrompt, resolveSourceStageIds, scopeCharactersForIssue, buildIssueScopeText, STAGE_TO_TEMPLATE, STAGE_LABELS, DEFAULT_FORWARD_SOURCE };
