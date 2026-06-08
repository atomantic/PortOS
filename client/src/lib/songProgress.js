// Song training progress — the pure core for the "memorize / learn / track"
// training mode (#1028, the capstone of the #1021 song-system umbrella).
//
// This module is deliberately PURE (no React, no Web Audio, no notation/DSP
// library): it slices a lead-sheet score into trainable SECTIONS, appends a
// graded take to a rolling per-scope accuracy HISTORY, and derives the
// memorization state (best %, rolling average, "learned" flag, weakest section)
// the training UI surfaces. Keeping the bookkeeping here is what makes the
// progress math unit-testable without a microphone.
//
// It composes the pieces already on `main` — it does NOT re-implement grading
// (that's `colorMatch.js` / `useColorMatch`) or parsing (`scoreNotation.js`).
// A "section" is one blank-line-separated block of the score body, which is how
// the seeded scores already group verses/choruses; training a section just
// feeds `useColorMatch` a score sliced to that block (header preserved), so the
// existing grading loop is reused unchanged.
//
// Persistence: the aggregate lives on the song under an optional `progress`
// field (sanitized + Zod-validated + migration-stamped server-side, same
// discipline as #1027's per-take fields). Absent on legacy songs; it only
// appears once the user records a training attempt.

// Scope id for "the whole song" — distinct from a section id so a whole-song
// run and a per-section run never collide in the history map. Sections key by
// their derived `id` (sec-1, sec-2, …); the whole song keys by this sentinel.
export const WHOLE_SONG_SCOPE = '__whole__';

// How many recent attempts to keep per scope. Bounded so a long practice
// streak can't grow the persisted record without limit; the rolling average
// and "best" are computed over this window. Mirrors a server-side MAX so the
// sanitizer and this client agree on the cap.
export const HISTORY_MAX = 50;

// Accuracy (% in tune) at or above which a scope is considered "learned" when
// it also has a stable streak. A vocal take wobbles, so the bar is the same
// 80% the color-match readout already calls "good" (green), not 100%.
export const LEARNED_PERCENT = 80;
// Consecutive at-or-above-threshold attempts required before a scope flips to
// learned — one lucky take shouldn't claim mastery; the singer has to repeat it.
export const LEARNED_STREAK = 3;

// Below this rolling-average %, a section is "weak" and worth surfacing for
// spaced-repetition practice. Sections at or above are considered solid.
export const WEAK_PERCENT = 60;

// Split a lead-sheet score into a header block (clef/key/time/tempo) and the
// body lines, returning the body grouped into blank-line-separated BLOCKS. Each
// block is the natural verse/chorus grouping the seeded scores already use.
// Pure string work — no parser dependency, so a block that fails to parse still
// slices cleanly (the grading hook tolerates parse errors per-measure).
const splitScoreBlocks = (score) => {
  const lines = String(score || '').replace(/\r\n?/g, '\n').split('\n');
  const header = [];
  const bodyLines = [];
  let inBody = false;
  for (const line of lines) {
    // Header lines are `key: value` before the first measure line. Once we hit
    // a music line (starts with `|`) we're in the body for the rest of the file.
    if (!inBody && /^\s*\|/.test(line)) inBody = true;
    if (inBody) bodyLines.push(line);
    else if (/^\s*[A-Za-z]+\s*:/.test(line)) header.push(line.trim());
    // blank lines in the header region are ignored (header has no blanks).
  }
  // Group body lines into blocks separated by one-or-more blank lines.
  const blocks = [];
  let current = [];
  for (const line of bodyLines) {
    if (line.trim() === '') {
      if (current.length) { blocks.push(current); current = []; }
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  return { header: header.join('\n'), blocks };
};

// Count the measures in a block (number of `|`-delimited cells with content).
// Used only to label a section so the user can tell them apart; a block with no
// bars still gets a label.
const countMeasures = (blockLines) => {
  let count = 0;
  for (const line of blockLines) {
    // Each `| … |` measure adds one; split on `|` and count non-empty cells.
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    count += cells.length;
  }
  return count;
};

// Derive the trainable sections of a score: one per blank-line-separated block,
// each carrying a stable id (by position), a human label, the sliced score text
// (header + just that block, so it renders/grades on its own), and the running
// measure offset. Returns [] when the score has no music body. When a song
// carries lyric `sections[]`, their labels are matched positionally so a
// training section reads "Verse 1" instead of "Section 1" — best-effort, purely
// cosmetic (the id stays positional so history keys are stable across renames).
export const deriveTrainingSections = (score, lyricSections = []) => {
  const { header, blocks } = splitScoreBlocks(score);
  if (!blocks.length) return [];
  let measureOffset = 0;
  return blocks.map((blockLines, i) => {
    const measures = countMeasures(blockLines);
    const lyricLabel = lyricSections[i]?.label;
    const section = {
      id: `sec-${i + 1}`,
      index: i,
      label: lyricLabel || `Section ${i + 1}`,
      measures,
      startMeasure: measureOffset,
      // Header + this block only — a self-contained score the grading hook can
      // build a timeline from in isolation.
      score: header ? `${header}\n\n${blockLines.join('\n')}` : blockLines.join('\n'),
    };
    measureOffset += measures;
    return section;
  });
};

// A finite number clamped to [0,100], or 0 — used to coerce a graded percent
// before it lands in the history.
const clampPercent = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
};

// One history entry per attempt: the take's percent-in-tune, how many notes
// were graded, and when. Bounded + minimal so the persisted record stays small.
const makeAttempt = (summary, at) => ({
  percentInTune: clampPercent(summary?.percentInTune),
  graded: typeof summary?.graded === 'number' && summary.graded >= 0 ? Math.round(summary.graded) : 0,
  at: typeof at === 'string' ? at : new Date().toISOString(),
});

// Append a graded attempt to a scope's history, returning the NEXT progress
// object (never mutates the input — reactive-update friendly). `scope` is a
// section id or WHOLE_SONG_SCOPE. The history is the source of truth; the
// derived stats (best/avg/learned) are recomputed by `scopeStats` on read so a
// threshold change can't leave a stale persisted flag. A take that graded zero
// notes (the singer stopped before any note, or sang into silence) is ignored —
// it carries no signal and would drag the average down spuriously.
export const recordAttempt = (progress, scope, summary, at) => {
  const attempt = makeAttempt(summary, at);
  const base = progress && typeof progress === 'object' ? progress : {};
  const history = base.history && typeof base.history === 'object' ? base.history : {};
  if (attempt.graded <= 0) return { ...base, history };
  const prior = Array.isArray(history[scope]) ? history[scope] : [];
  // Newest last; keep only the most recent HISTORY_MAX so the record is bounded.
  const next = [...prior, attempt].slice(-HISTORY_MAX);
  return { ...base, history: { ...history, [scope]: next } };
};

// Derive the stats for one scope from its attempt history: attempt count, best
// %, rolling average % (over the kept window), the current at-or-above-threshold
// streak (counted from the most recent attempt backwards), and the learned flag
// (streak ≥ LEARNED_STREAK). Pure — recomputed on every read so the displayed
// state always reflects the current thresholds, never a stale stored boolean.
export const scopeStats = (progress, scope) => {
  const history = progress?.history?.[scope];
  const attempts = Array.isArray(history) ? history : [];
  if (!attempts.length) {
    return { attempts: 0, best: 0, average: 0, last: 0, streak: 0, learned: false };
  }
  const percents = attempts.map((a) => clampPercent(a?.percentInTune));
  const best = Math.max(...percents);
  const average = Math.round(percents.reduce((s, p) => s + p, 0) / percents.length);
  const last = percents[percents.length - 1];
  let streak = 0;
  for (let i = percents.length - 1; i >= 0; i -= 1) {
    if (percents[i] >= LEARNED_PERCENT) streak += 1;
    else break;
  }
  return { attempts: attempts.length, best, average, last, streak, learned: streak >= LEARNED_STREAK };
};

// Whole-song stats — a thin alias so callers don't pass the sentinel by hand.
export const wholeSongStats = (progress) => scopeStats(progress, WHOLE_SONG_SCOPE);

// Rank the sections weakest-first for spaced-repetition surfacing: a section is
// scored by its rolling average (lower = weaker), with never-attempted sections
// treated as the weakest of all (so the user is nudged to the parts they've
// skipped). Returns the section descriptors annotated with their stats, sorted
// ascending by average (un-attempted first, then lowest average). Only sections
// BELOW WEAK_PERCENT (or never attempted) are returned — solid sections drop
// off the list so it stays a focused practice queue. `sections` comes from
// deriveTrainingSections. Pure + side-effect-free.
export const weakestSections = (progress, sections) => {
  return (sections || [])
    .map((s) => ({ ...s, stats: scopeStats(progress, s.id) }))
    .filter((s) => s.stats.attempts === 0 || s.stats.average < WEAK_PERCENT)
    .sort((a, b) => {
      // Never-attempted (attempts 0) sort before attempted; among attempted,
      // lower average first.
      if (a.stats.attempts === 0 && b.stats.attempts !== 0) return -1;
      if (b.stats.attempts === 0 && a.stats.attempts !== 0) return 1;
      return a.stats.average - b.stats.average;
    });
};

// Overall memorization completion 0–100: the share of sections that are
// `learned`, plus a partial credit for the whole-song scope being learned.
// Simple and legible — the training view shows it as a single progress bar.
// Returns 0 when there are no sections to learn.
export const memorizationPercent = (progress, sections) => {
  const list = sections || [];
  if (!list.length) return 0;
  const learnedCount = list.filter((s) => scopeStats(progress, s.id).learned).length;
  return Math.round((learnedCount / list.length) * 100);
};

// Progressive lyric/note hiding: as a scope's rolling average climbs, hide more
// of the on-screen crutches so the singer is pushed toward memory. Returns a
// hint level the UI maps to how much to obscure: `show` (everything visible),
// `dim` (lyrics dimmed, still legible), `hide` (lyrics hidden, notes only),
// `blind` (notes hidden too — sing from memory). Driven off the rolling average
// so a single good take doesn't yank the crutch away mid-practice.
export const HIDE_LEVELS = ['show', 'dim', 'hide', 'blind'];
export const hideLevelFor = (average) => {
  const avg = clampPercent(average);
  if (avg >= 95) return 'blind';
  if (avg >= LEARNED_PERCENT) return 'hide';
  if (avg >= WEAK_PERCENT) return 'dim';
  return 'show';
};
