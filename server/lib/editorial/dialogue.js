/**
 * Dialogue-craft deterministic primitives (#1307) for the editorial check
 * registry. Pure and dependency-free (no side-effecting imports) so it stays
 * unit-testable in isolation — mirrors ./proseTics.js and ./cliches.js.
 *
 * Two scanners back the two deterministic dialogue checks in checkRegistry.js:
 *   - findSaidBookisms()           → `dialogue.said-bookisms`     (ornate / non-speech tags)
 *   - findUnattributedDialogueRuns() → `dialogue.attribution-clarity` (untrackable speakers)
 *
 * Their LLM siblings (`dialogue.on-the-nose`, `dialogue.voice-distinctiveness`)
 * handle the judgment cases these pure scanners can't: subtext-free / "as you
 * know, Bob" dialogue, and per-character voice distinctiveness against canon.
 *
 * Quote handling: only DOUBLE quotes (straight " and curly “ ”) are treated as
 * dialogue delimiters. Single quotes are deliberately excluded — they collide
 * with apostrophes (it's, don't, ’em) and would wreck precision. Manuscripts in
 * the pipeline use double-quote dialogue, so this is a safe simplification.
 */

// Straight + curly double quotes. Used both as a character class body (DQUOTE)
// and to build "quoted span" / "non-quote run" regexes.
const DQUOTE = '"“”';
const DQUOTE_CLASS = `[${DQUOTE}]`;
const NON_DQUOTE = `[^${DQUOTE}]`;

// A "speaker" token that can sit beside a dialogue tag — a capitalized proper
// name or a personal pronoun. Used to anchor a tag verb to a real attribution
// (so "the dog growled" in narration doesn't read as a said-bookism).
const SPEAKER = "(?:[A-Z][\\w'’\\-]+|he|she|they|him|her|them|I|we|you|it)";

// Said-bookisms — ornate speech-tag verbs that should almost always collapse to
// "said" / "asked". Curated, lowercase, base form; the matcher inflects each to
// its -s / past-tense forms. A series can mute entries (allowWords) or extend
// the list (extraWords) for genre voice.
export const SAID_BOOKISMS = Object.freeze([
  'expostulate', 'ejaculate', 'opine', 'interject', 'enunciate', 'articulate',
  'proclaim', 'exclaim', 'vociferate', 'bellow', 'thunder', 'simper', 'chortle',
  'guffaw', 'snarl', 'growl', 'hiss', 'purr', 'quip', 'retort', 'riposte',
  'interpose', 'remonstrate', 'expound', 'asseverate', 'aver', 'posit',
  'postulate', 'elucidate', 'intone', 'drawl', 'bleat', 'splutter', 'sputter',
  'wheeze', 'rasp', 'croak', 'trill', 'warble', 'pontificate', 'declaim',
  'orate', 'soliloquize',
]);

// Non-speech actions misused as speech tags — you cannot smile / laugh / nod a
// line of dialogue. ("'Yes,' she smiled.") Base form; inflected by the matcher.
export const NON_SPEECH_TAGS = Object.freeze([
  'smile', 'grin', 'laugh', 'chuckle', 'nod', 'shrug', 'sigh', 'frown',
  'beam', 'wink', 'sob', 'snort', 'gesture', 'scowl', 'smirk', 'pout',
  'wince', 'gulp', 'shudder',
]);

// Plain, invisible speech tags — the ones a writer SHOULD use. Presence of any
// of these (or an action beat) is what makes a dialogue line "attributed" for
// the attribution-clarity scan. Stored as surface forms (matched case-insens.).
const PLAIN_SPEECH_TAGS = Object.freeze([
  'said', 'says', 'say', 'asked', 'asks', 'ask', 'replied', 'replies',
  'whispered', 'whispers', 'shouted', 'shouts', 'muttered', 'mutters',
  'murmured', 'murmurs', 'answered', 'answers', 'called', 'calls', 'cried',
  'cries', 'yelled', 'yells', 'snapped', 'snaps', 'breathed', 'breathes',
  'added', 'adds', 'continued', 'continues', 'stated', 'states', 'demanded',
  'demands', 'told', 'tells', 'spoke', 'speaks',
]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWord(p) {
  return typeof p === 'string' ? p.trim().toLowerCase() : '';
}

// Regular inflections of a base verb for tag matching: base, +s, and the past
// tense (+ed, drop-e +d, or doubled-final-consonant +ed). Returns lowercased,
// de-duped surface forms. Mirrors the inflection rules in proseTics.inflect().
function inflectVerb(base) {
  const b = base.toLowerCase();
  const forms = new Set([b, `${b}s`]);
  if (b.endsWith('e')) {
    forms.add(`${b}d`);
  } else {
    forms.add(`${b}ed`);
    // Short CVC base doubles its final consonant: nod → nodded. The `qu…` arm
    // catches words where the `u` is part of a `qu` onset rather than the vowel
    // (quip → quipped), which the plain CVC test would miss (it reads `u` as a vowel).
    if (/[^aeiou][aeiou][^aeiouwxy]$/.test(b) || /qu[aeiou][^aeiouwxy]$/.test(b)) {
      forms.add(`${b}${b.slice(-1)}ed`);
    }
  }
  return [...forms];
}

// Map every inflected surface form of a verb list back to its base, honoring an
// allow-list (muted bases) and extra additions. Returns { forms[], formToBase }.
function buildVerbForms(seed, opts = {}) {
  const allow = new Set((Array.isArray(opts.allowWords) ? opts.allowWords : []).map(normalizeWord).filter(Boolean));
  const extra = (Array.isArray(opts.extraWords) ? opts.extraWords : []).map(normalizeWord).filter(Boolean);
  const formToBase = new Map();
  const seen = new Set();
  for (const w of [...seed, ...extra]) {
    const norm = normalizeWord(w);
    if (!norm || seen.has(norm) || allow.has(norm)) continue;
    seen.add(norm);
    for (const f of inflectVerb(norm)) if (!formToBase.has(f)) formToBase.set(f, norm);
  }
  return { forms: [...formToBase.keys()], formToBase };
}

// Build the two dialogue-tag regexes for a set of inflected verb forms:
//   after-quote:  "…," she opined   /   "…," opined Marlon
//   before-quote: She opined, "…"
// The verb must sit immediately beside a double-quote span and a speaker, so a
// bare narrated verb ("the dog growled") never matches. Returns null when the
// effective form list is empty.
function buildTagMatchers(forms) {
  if (!forms.length) return null;
  // Longest-first so "expostulated" wins over a shorter prefix under alternation.
  const alt = forms.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const VERB = `(${alt})`;
  // After a closing quote: capture the terminal punctuation that sits INSIDE the
  // quote (`," ` vs `." `) so the caller can tell a real tag from an action beat.
  // Group 1 = that punctuation (may be empty); group 2 = the verb. Standard prose
  // ends a quote with a comma when a tag follows ("…," she said) and a period
  // when the dialogue is a complete sentence and the next clause is a separate
  // action beat ("…." She smiled.) — a period-terminated quote is NOT a tag.
  const after = new RegExp(`([,.!?])?${DQUOTE_CLASS}\\s+(?:${SPEAKER}\\s+)?${VERB}\\b`, 'gi');
  // Before an opening quote: speaker → verb → optional comma/colon → quote. This
  // ordering is unambiguously a tag, so no punctuation gate is needed. Group 1 = verb.
  const before = new RegExp(`\\b${SPEAKER}\\s+${VERB}\\s*[,:]?\\s*${DQUOTE_CLASS}`, 'gi');
  return { after, before };
}

// Given a tag's `kind` and the punctuation that terminated the preceding quote,
// decide whether it reads as a real dialogue tag (worth flagging) vs an action
// beat that merely follows a complete line of dialogue (legitimate — leave it):
//   - non-speech ("she smiled"): a misuse ONLY when comma-attached like a speech
//     tag ("Of course," she smiled). After a period/!/? the quote is a complete
//     sentence and "She smiled." is a separate, correct action beat.
//   - bookism ("she opined"): an ornate SPEECH verb is a valid (if ugly) tag after
//     a comma/?/! or a tag-continuing quote with no terminal mark — but not after a
//     period, where the following clause is a new sentence, not a tag.
function punctAllowsTag(kind, punct) {
  if (kind === 'non-speech') return punct === ',';
  return punct !== '.';
}

/**
 * Find said-bookism and non-speech dialogue tags in `text`. Only verbs sitting
 * immediately beside a double-quote span (a real dialogue tag) are returned, so
 * narrated uses of the same verb ("the engine growled") are not flagged.
 *
 * @param {string} text
 * @param {{ allowWords?: string[], extraWords?: string[] }} [opts]
 *   allowWords — bases to mute (house-style / genre voice).
 *   extraWords — extra bookism bases to flag (treated as 'bookism' kind).
 * @returns {Array<{ verb: string, kind: 'bookism'|'non-speech', index: number, anchor: string }>}
 *   in position order, deduped by (verb-base @ index) so the two regexes don't
 *   double-report the same tag.
 */
export function findSaidBookisms(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const bookisms = buildVerbForms(SAID_BOOKISMS, opts);
  // Non-speech tags share the allow-list but ignore extraWords (those extend the
  // bookism list, semantically), so build them with only the allow-list applied.
  const nonSpeech = buildVerbForms(NON_SPEECH_TAGS, { allowWords: opts.allowWords });
  const kindByForm = new Map();
  for (const [form, base] of bookisms.formToBase) kindByForm.set(form, { base, kind: 'bookism' });
  // Non-speech wins only where a form isn't already a bookism (no overlap today).
  for (const [form, base] of nonSpeech.formToBase) if (!kindByForm.has(form)) kindByForm.set(form, { base, kind: 'non-speech' });

  const allForms = [...kindByForm.keys()];
  const matchers = buildTagMatchers(allForms);
  if (!matchers) return [];

  const out = [];
  const seen = new Set();
  // The `after` matcher captures the quote's terminal punctuation in group 1 and
  // the verb in group 2 (so a tag can be told from an action beat); the `before`
  // matcher captures only the verb in group 1 (its word order is unambiguously a
  // tag). Iterate them with their per-matcher group layout.
  const passes = [
    { re: matchers.after, verbGroup: 2, punctGroup: 1 },
    { re: matchers.before, verbGroup: 1, punctGroup: null },
  ];
  for (const { re, verbGroup, punctGroup } of passes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const matched = m[verbGroup];
      const form = matched.toLowerCase();
      const info = kindByForm.get(form);
      if (!info) continue;
      // For the after-quote pass, gate on the in-quote terminal punctuation so an
      // action beat following a complete sentence ("…." She smiled.) isn't flagged
      // as a misused tag. The before-quote pass has no punctuation to weigh.
      if (punctGroup !== null) {
        if (!punctAllowsTag(info.kind, m[punctGroup] || '')) continue;
        // A real after-quote tag verb is lowercase — a clause continuation
        // ("…," she opined / "…," opined Marlon). A CAPITALIZED word after the
        // quote is the subject of a NEW sentence (narration), e.g.
        // `"Run!" Thunder rolled overhead.` — not a tag. Skip it.
        if (matched[0] !== matched[0].toLowerCase()) continue;
      }
      const key = `${info.base}@${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ verb: info.base, kind: info.kind, index: m.index, anchor: m[0].trim() });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// A single regex matching any plain-speech-tag word (whole-word, case-insens.),
// used to decide whether a dialogue paragraph carries attribution.
const PLAIN_TAG_RE = new RegExp(`\\b(?:${PLAIN_SPEECH_TAGS.join('|')})\\b`, 'i');
// All bookism + non-speech inflected forms also count as attribution (an ornate
// tag is still a tag — it's the said-bookism check's job to flag it, not the
// attribution check's job to call it unattributed). Built once at module load.
const ORNATE_TAG_RE = (() => {
  const { forms } = buildVerbForms([...SAID_BOOKISMS, ...NON_SPEECH_TAGS]);
  return forms.length ? new RegExp(`\\b(?:${forms.map(escapeRegExp).join('|')})\\b`, 'i') : null;
})();
const QUOTED_SPAN_RE = new RegExp(`${DQUOTE_CLASS}${NON_DQUOTE}*${DQUOTE_CLASS}`, 'g');

// A paragraph is a "dialogue line" when it contains a complete quoted span.
const hasQuotedSpan = (para) => {
  QUOTED_SPAN_RE.lastIndex = 0;
  return QUOTED_SPAN_RE.test(para);
};

// A dialogue paragraph is "attributed" when it carries a speech tag (plain or
// ornate) OR an action beat — substantial non-quoted prose that grounds who is
// speaking. Both signals are measured on the NON-QUOTED remainder: a tag word
// that appears INSIDE the dialogue ("I said no.") is spoken text, not
// attribution, so the tag regexes must run on the narration around the quote,
// not the whole paragraph.
function isAttributed(para, beatChars) {
  const beat = para.replace(QUOTED_SPAN_RE, ' ').replace(/\s+/g, ' ').trim();
  if (PLAIN_TAG_RE.test(beat) || (ORNATE_TAG_RE && ORNATE_TAG_RE.test(beat))) return true;
  return beat.length >= beatChars;
}

/**
 * Find runs of consecutive unattributed dialogue paragraphs — a stretch of
 * back-and-forth where no tag or action beat re-anchors the speaker, so the
 * reader loses track of who is talking. Paragraphs are split on blank/newline
 * boundaries; only dialogue paragraphs (those with a quoted span) participate,
 * and a non-dialogue paragraph (pure narration) breaks a run.
 *
 * @param {string} text
 * @param {{ minRun?: number, beatChars?: number }} [opts]
 *   minRun — consecutive unattributed dialogue lines before a run is flagged
 *            (default 6 — two speakers alternating stay trackable for a few
 *            exchanges; a longer untagged run is where tracking genuinely fails).
 *   beatChars — non-quoted chars that count a paragraph as carrying an action
 *               beat (default 16).
 * @returns {Array<{ count: number, index: number, anchor: string }>}
 *   one entry per run; `index` is the offset of the run's first line, `anchor`
 *   is that first line (trimmed, capped) so the editor can jump to the run start.
 */
export function findUnattributedDialogueRuns(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const minRun = Math.max(2, Number.isInteger(opts.minRun) ? opts.minRun : 6);
  const beatChars = Number.isInteger(opts.beatChars) ? opts.beatChars : 16;

  // Split into paragraphs, tracking each paragraph's absolute start offset.
  const paras = [];
  const re = /[^\n]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) paras.push({ text: m[0], index: m.index });
  }

  const out = [];
  let runStart = -1; // offset of the first line in the current unattributed run
  let runFirst = ''; // that first line's text
  let runCount = 0;
  const flush = () => {
    if (runCount >= minRun && runStart >= 0) {
      out.push({ count: runCount, index: runStart, anchor: runFirst.trim().slice(0, 200) });
    }
    runStart = -1;
    runFirst = '';
    runCount = 0;
  };
  for (const p of paras) {
    if (!hasQuotedSpan(p.text)) {
      // Pure narration breaks any in-progress dialogue run.
      flush();
      continue;
    }
    if (isAttributed(p.text, beatChars)) {
      // An attributed dialogue line re-anchors the speaker — the run resets, but
      // this line itself is fine (not part of an UNattributed run).
      flush();
      continue;
    }
    // Unattributed dialogue line — extend (or start) the current run.
    if (runCount === 0) { runStart = p.index; runFirst = p.text; }
    runCount += 1;
  }
  flush();
  return out;
}

/**
 * Attribute spoken dialogue paragraphs to the cast for a coarse dialogue-share
 * signal (cast representation & balance, #1312). For each dialogue paragraph
 * (one carrying a quoted span) the speaker is inferred from the NON-quoted beat
 * around the quote — exactly the surface the attribution-clarity scan reads — so
 * a name spoken INSIDE the dialogue ("I saw Bram") doesn't mis-attribute the
 * line. A paragraph is credited to the FIRST owner whose token matches the beat;
 * paragraphs whose speaker can't be resolved (no name/alias in the beat) are
 * counted as `unattributed` rather than guessed, per the absent-vs-empty rule.
 *
 * Deliberately coarse: it measures *who is credited with speaking lines*, not a
 * precise turn-by-turn transcript. That's the right grain for a balance ratio
 * (does one character dominate the dialogue?), and it stays pure + dependency-
 * free — the caller supplies the per-owner matchers it already builds for canon.
 *
 * @param {string} text
 * @param {Array<{ key: string, matcher: RegExp }>} owners
 *   one entry per character; `matcher` is a non-global whole-token regex (e.g.
 *   the one checkRegistry's characterMatcher builds). Longest-token-first order
 *   is the caller's responsibility (it governs which owner wins a beat that
 *   names two characters — first match wins).
 * @returns {{ byOwner: Map<string, number>, total: number, attributed: number, unattributed: number }}
 *   byOwner — dialogue-paragraph count per matched owner key (only owners with ≥1
 *   line appear); total — all dialogue paragraphs; attributed/unattributed split.
 */
export function attributeDialogueByOwner(text, owners) {
  const byOwner = new Map();
  const result = { byOwner, total: 0, attributed: 0, unattributed: 0 };
  if (typeof text !== 'string' || !text) return result;
  const list = (Array.isArray(owners) ? owners : []).filter(
    (o) => o && typeof o.key === 'string' && o.matcher instanceof RegExp
  );

  const re = /[^\n]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const para = m[0];
    if (!para.trim() || !hasQuotedSpan(para)) continue;
    result.total += 1;
    // The beat is the narration around the quote — the only place a tag/name
    // legitimately attributes the speaker (a name inside the quote is spoken text).
    const beat = para.replace(QUOTED_SPAN_RE, ' ').replace(/\s+/g, ' ').trim();
    let owner = null;
    if (beat) {
      // Credit the owner whose name appears EARLIEST in the beat — the speaker.
      // In "…," Aria told Bram. the leftmost name (Aria) is the speaker; picking
      // by list (canon) order instead would make attribution depend on canon
      // ordering and credit a beat that merely mentions a second character to
      // the wrong owner. Ties (same index — impossible for distinct names, but
      // guarded) keep first-listed.
      let bestIndex = Infinity;
      for (const o of list) {
        o.matcher.lastIndex = 0; // non-global, but reset defensively
        const m2 = o.matcher.exec(beat);
        if (m2 && m2.index < bestIndex) { bestIndex = m2.index; owner = o.key; }
      }
    }
    if (owner) {
      result.attributed += 1;
      byOwner.set(owner, (byOwner.get(owner) || 0) + 1);
    } else {
      result.unattributed += 1;
    }
  }
  return result;
}
