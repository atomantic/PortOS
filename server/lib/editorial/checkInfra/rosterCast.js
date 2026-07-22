/**
 * Roster economy (#1292) + cast representation/balance (#1312) accounting over
 * canon names, aliases and the stitched manuscript (#2842 split of checkInfra.js).
 */

import { normalizeName } from './externals.js';

// ---------------------------------------------------------------------------
// Roster economy (#1292) — character-appearance accounting over the stitched
// manuscript. Reads canon names + aliases and counts the DISTINCT issues each
// named character is mentioned in (recurrence), which issue they first appear
// in, and the named cast present in the opening issue. Pure: the per-issue
// `ctx.sections` and `ctx.canon` are injected by the runner.
//
// The match is a deterministic word-bounded name scan. A character whose name
// is a common word (Hope, Grace, Reed) can over-match prose — which biases the
// check toward UNDER-flagging throwaways (safe) at the cost of possibly
// over-counting first-issue crowding. Classifying unmodeled proper nouns as
// characters needs an LLM pass and is tracked as its own check (see the issue).
// ---------------------------------------------------------------------------

// Escape a name so it rides inside a RegExp alternation literally — names carry
// regex-significant punctuation ("D'Argo", "Anne-Marie", "T.A.R.D.I.S.").
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A character's match tokens: its name plus every alias, trimmed + de-duped.
// Empty when the character has no usable name.
export function characterNameTokens(c) {
  const tokens = [];
  const push = (v) => { const t = typeof v === 'string' ? v.trim() : ''; if (t) tokens.push(t); };
  push(c?.name);
  for (const a of (Array.isArray(c?.aliases) ? c.aliases : [])) push(a);
  return [...new Set(tokens)];
}

// A case-insensitive, whole-token matcher for a character's tokens (built once
// per character and reused across every section so a long manuscript isn't
// re-compiling a regex per section), or null when there are no tokens.
export function characterMatcher(tokens) {
  if (!tokens.length) return null;
  // Longest-first so a token that's a prefix of another can't shadow it under
  // leftmost-match alternation (cosmetic for .test, but keeps intent clear).
  const alt = tokens.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  // Lookarounds, not \b: a token that begins or ends with punctuation ("Mr.",
  // "T.A.R.D.I.S.", "J.R.") has no word char at that edge, so a leading/trailing
  // \b would never match it in prose. (?<!\w)…(?!\w) enforces whole-token matching
  // at any edge while still rejecting substrings (Sam ≠ "Samuel").
  return new RegExp(`(?<!\\w)(?:${alt})(?!\\w)`, 'i');
}

// One row per NAMED canon character: { id, name, locked, appearedInIssues,
// firstIssueNumber }. `appearedInIssues` is the distinct issue numbers the
// character is mentioned in, in story order (sections are one-per-issue, ordered
// by arc position). Unnamed canon entries aren't a roster-economy concern.
export function buildRosterAppearances(ctx) {
  const chars = Array.isArray(ctx.canon?.characters) ? ctx.canon.characters : [];
  const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
  const rows = [];
  for (const c of chars) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    const matcher = characterMatcher(characterNameTokens(c));
    if (!matcher) continue;
    const appearedInIssues = [];
    // Capture the ACTUAL matched token (name OR alias) from the first issue the
    // character appears in, so a finding's anchorQuote lands on real prose — an
    // alias-only mention ("Bob" for canonical "Robert") must anchor on "Bob", not
    // the canonical name the editor would never find. `matcher` is non-global, so
    // exec starts at 0 on each section. Falls back to the name for unmatched rows.
    let anchorQuote = '';
    for (const s of sections) {
      const m = matcher.exec(s.content || '');
      if (!m) continue;
      appearedInIssues.push(s.number);
      if (!anchorQuote) anchorQuote = m[0];
    }
    rows.push({
      id: c.id || name,
      name,
      locked: c.locked === true,
      appearedInIssues,
      firstIssueNumber: appearedInIssues.length ? appearedInIssues[0] : null,
      anchorQuote: anchorQuote || name,
    });
  }
  return rows;
}

// Normalized keys of every canon character that actually APPEARS in the prose
// (named at least once across the manuscript sections) — the "appearing cast"
// both the screen-time skew and the silent-major distribution signals score
// against. Pure; reuses buildRosterAppearances' per-section matcher scan.
export function buildAppearingKeys(ctx) {
  return new Set(
    buildRosterAppearances(ctx)
      .filter((r) => r.appearedInIssues.length > 0)
      .map((r) => normalizeName(r.name))
  );
}

// ---------------------------------------------------------------------------
// Cast representation & balance (#1312) — three coarse, computable casting
// signals over the canon + reverse-outline + stitched manuscript:
//   1) Bechdel co-presence — does ANY scene put two+ non-male characters
//      together (the structural precondition for two women talking)? Computed
//      from the reverse-outline's per-scene charactersPresent against
//      pronoun-inferred gender. A coarse signal, not the full Bechdel test
//      (we can't read whether the conversation is about a man deterministically).
//   2) Dialogue share — does one character dominate the spoken lines? Counts
//      attributed dialogue paragraphs per character (attributeDialogueByOwner)
//      and flags a lopsided distribution (top speaker over a configurable share).
//   3) Screen-time balance — when gender is inferable, flag a strongly skewed
//      appearing cast (e.g. a near-all-male roster) as a representation nudge.
//
// All three are advisory (low/medium): representation is an authorial choice and
// these are signals, not correctness errors. Gender is inferred ONLY from the
// canon `pronouns` field — absent/ambiguous pronouns yield 'unknown', and the
// gender-dependent signals stay silent rather than guess (absent ≠ a category).
// ---------------------------------------------------------------------------

// Infer a coarse gender bucket from a character's canon `pronouns` string. Only
// the unambiguous subject/object pronoun sets map; anything else (neopronouns,
// "any", blank, a sentence) is 'unknown' so a gender-dependent signal can opt
// out rather than miscategorize. Returns 'female' | 'male' | 'nonbinary' | 'unknown'.
function inferGender(pronouns) {
  const p = typeof pronouns === 'string' ? pronouns.toLowerCase() : '';
  if (!p) return 'unknown';
  const has = (re) => re.test(p);
  const she = has(/\bshe\b/) || has(/\bher\b/) || has(/\bhers\b/);
  const he = has(/\bhe\b/) || has(/\bhim\b/) || has(/\bhis\b/);
  const they = has(/\bthey\b/) || has(/\bthem\b/) || has(/\btheir\b/);
  // A clean single set wins; a mixed string ("she/they") is ambiguous → unknown,
  // except she+they / he+they which still read as a definite female/male identity
  // with a secondary set. Both she AND he present is genuinely ambiguous.
  if (she && he) return 'unknown';
  if (she) return 'female';
  if (he) return 'male';
  if (they) return 'nonbinary';
  return 'unknown';
}

// Coarse role-tier inference from a canon character's free-text `role` field, for
// the per-character dialogue-distribution signal (#1594). Only unambiguous keyword
// sets map to a tier; anything else (blank, a description, a role that mixes a
// major AND a minor word like "minor antagonist") is 'unknown' so the distribution
// signal opts out rather than guess — the same absent-vs-empty discipline
// inferGender() uses. Deliberately omits genuinely-ambiguous words ("supporting",
// "secondary", "recurring") that sit between lead and walk-on. Returns
// 'major' | 'minor' | 'unknown'. The two keyword sets live at module scope (vs
// inferGender's inline pronoun checks) so the regexes are compiled once, not on
// every per-character call.
const MAJOR_ROLE_RE = /\b(protagonist|deuteragonist|antagonist|villain|hero|heroine|lead|main|primary|central|principal)\b/;
const MINOR_ROLE_RE = /\b(minor|background|cameo|walk-?on|bit[- ]?part|extra|incidental|tertiary)\b/;
function inferRoleTier(role) {
  const r = typeof role === 'string' ? role.toLowerCase() : '';
  if (!r) return 'unknown';
  const major = MAJOR_ROLE_RE.test(r);
  const minor = MINOR_ROLE_RE.test(r);
  if (major && minor) return 'unknown'; // contradictory ("minor antagonist") → opt out
  if (major) return 'major';
  if (minor) return 'minor';
  return 'unknown';
}

// Normalized name → { char, gender, key } for every named canon character, plus
// the per-owner whole-token matcher reused for dialogue attribution. Built once
// per run so the dialogue scan and the co-presence scan share one identity map.
export function buildCastIdentities(ctx) {
  const chars = Array.isArray(ctx.canon?.characters) ? ctx.canon.characters : [];
  const identities = [];
  for (const c of chars) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    const key = normalizeName(name);
    if (!key) continue;
    const matcher = characterMatcher(characterNameTokens(c));
    identities.push({
      key,
      name,
      gender: inferGender(c.pronouns),
      roleTier: inferRoleTier(c.role),
      matcher,
    });
  }
  return identities;
}

// Resolve a scene's charactersPresent names to canon identity keys (so a scene
// that lists "Bob" maps to canonical "Robert"). A present name that matches no
// canon character is dropped — the co-presence signal is canon-relative.
export function sceneCastKeys(scene, identityByKey, identities) {
  const present = Array.isArray(scene?.charactersPresent) ? scene.charactersPresent : [];
  const keys = new Set();
  for (const raw of present) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const direct = identityByKey.get(normalizeName(raw));
    if (direct) { keys.add(direct.key); continue; }
    // Fall back to a token match (the present-name might be an alias surface form).
    const hit = identities.find((id) => id.matcher && id.matcher.test(raw));
    if (hit) keys.add(hit.key);
  }
  return keys;
}

