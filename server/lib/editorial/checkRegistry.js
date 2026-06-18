/**
 * Editorial Check Registry (#1284) — the backbone of the extensible
 * editorial-review system (epic #1283).
 *
 * Mirrors `server/lib/navManifest.js` and `server/lib/apiRegistry.js`: a static
 * array of declarative entries with fail-fast guards at module load so a
 * malformed check blocks boot instead of silently breaking the runner. Each
 * entry declares its scope, kind, default severity, a Zod `configSchema`, an
 * optional `gate`, and a `run(ctx)` that returns findings shaped for the
 * existing `manuscriptReview` comment store.
 *
 * This module is intentionally PURE — it imports nothing with side effects
 * (only `zod` and the pure `estimateTokens` budgeter). LLM-kind checks receive
 * their model caller through `ctx.callStagedLLM`, and a manuscript-consuming LLM
 * check plans the manuscript into provider-sized chunks through
 * `ctx.planManuscriptChunks` — both injected by
 * `server/services/pipeline/editorial/checkRunner.js`, so the registry stays
 * side-effect-free and unit-testable in isolation.
 *
 * A finding returned by `run(ctx)` is a partial `manuscriptReview` comment:
 *   { severity?, category?, location?, problem (required), suggestion?,
 *     anchorQuote?, issueNumber? }
 * The runner stamps each finding's `checkId` (and `sourceRunId`) before seeding
 * the review, so checks never set those themselves.
 */

import { z } from 'zod';
import { estimateTokens } from '../contextBudget.js';

export const CHECK_SCOPES = Object.freeze(['series', 'issue', 'scene', 'noun']);
export const CHECK_KINDS = Object.freeze(['deterministic', 'llm']);
export const CHECK_SEVERITIES = Object.freeze(['high', 'medium', 'low']);
const SEVERITIES = CHECK_SEVERITIES;

// The inputs a check can read, declared per-check via `sources` (#1387). The
// staleness runner (server/services/pipeline/editorial/checkRunner.js) fingerprints
// EXACTLY a check's declared sources, so a finding only goes stale when content
// the check actually analyzed drifts — editing the style guide no longer marks a
// naming finding stale, and editing the ticking clock no longer marks every
// canon-only finding stale. Every token here must have a matching resolver in the
// runner's `SOURCE_RESOLVERS` (a load-time guard there fails fast if they drift).
//   - 'manuscript'              — the stitched manuscript corpus (implies needsManuscript)
//   - 'canon'                   — the universe/series canon (characters, relationships, objects)
//   - 'series.styleGuide'       — the series style guide (tense/POV/rating/reading level)
//   - 'series.arc.tickingClock' — the series arc's ticking clock
export const EDITORIAL_SOURCES = Object.freeze([
  'manuscript',
  'canon',
  'series.styleGuide',
  'series.arc.tickingClock',
]);

// Default per-run finding cap for user-defined checks (#1346) — mirrors the
// built-in LLM checks' `maxFindings` default so a long manuscript can't flood
// the review. Defined up here so the custom-check prompt builder and config
// schema (both below) share one source.
export const CUSTOM_CHECK_MAX_FINDINGS_DEFAULT = 12;

// The serializable config-field types a check can declare for its UI form.
// `configSchema` (a Zod schema) stays the validation authority on the server;
// `configFields` is the wire-safe *render* descriptor the Editorial Checks UI
// reads to build the per-check config form (the Zod schema can't cross the wire).
// Keep this in lockstep with the controls EditorialCheckCard's ConfigField
// renders — only advertise a type the UI can actually draw (no 'select' until
// the <select> control + an `options` contract land).
export const CHECK_FIELD_TYPES = Object.freeze(['number', 'boolean', 'text']);

// Stage name for the info-dumping LLM check. The prompt ships in
// data.reference/prompts/stages/ and its config in stage-config.json; both
// propagate to existing installs via setup-data.js (missing-file copy +
// JSON_MERGE_TARGETS stage merge), so no migration is needed for a NEW stage.
export const INFO_DUMPING_STAGE = 'pipeline-editorial-info-dumping';

// Stage names for the two object-attachment LLM checks (#1288). Like the
// info-dumping stage, each prompt ships in data.reference/prompts/stages/ and
// its config in stage-config.json; both propagate to fresh installs via
// setup-data.js and to existing installs via migration 094 (boot runs
// migrations but NOT setup-data, so the migration is required — see
// scripts/migrations/094-object-attachment-check-stages.js).
export const OBJECT_MOTIVATION_STAGE = 'pipeline-editorial-object-motivation';
export const OBJECT_BACKSTORY_STAGE = 'pipeline-editorial-object-backstory';

// Stage name for the style-guide conformance LLM check (#1303). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 096 (boot runs
// migrations but NOT setup-data, so the migration is required).
export const STYLE_CONFORMANCE_STAGE = 'pipeline-editorial-style-conformance';

// ---------------------------------------------------------------------------
// Deterministic helpers for the character-name dissimilarity check.
// ---------------------------------------------------------------------------

const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const vowelSkeleton = (s) => letters(s).replace(/[^aeiou]/g, '');

// The similarity signals two character names can share. Two names that trip
// enough of these are easy for a reader to confuse on the page.
function nameSimilaritySignals(a, b) {
  const la = letters(a);
  const lb = letters(b);
  if (!la || !lb) return [];
  const signals = [];
  if (la[0] === lb[0]) signals.push('same first letter');
  if (la.length === lb.length) signals.push('same length');
  const vsa = vowelSkeleton(a);
  if (vsa && vsa === vowelSkeleton(b)) signals.push('same vowel pattern');
  if (la.length >= 3 && lb.length >= 3 && la.slice(0, 3) === lb.slice(0, 3)) signals.push('same opening');
  if (la.endsWith(lb.slice(-2)) && la.slice(-2) === lb.slice(-2)) signals.push('same ending');
  return signals;
}

// ---------------------------------------------------------------------------
// Shared scaffolding for the relationship-link checks (#1287). All three walk
// `canon.characters × relationshipLinks`, so the id-bearing character list,
// the id→name lookup, and the link iteration live here once.
// ---------------------------------------------------------------------------

// Id-bearing characters + an id→name lookup (falling back to the id when a
// character is unnamed). The three checks index off this same pair.
function relationshipCanon(ctx) {
  const chars = (ctx.canon?.characters || []).filter((c) => c && c.id);
  return { chars, nameById: new Map(chars.map((c) => [c.id, c.name || c.id])) };
}

// Yields every relationship link that points somewhere, as { c, link, targetId }.
function* eachRelationshipLink(chars) {
  for (const c of chars) {
    for (const link of (Array.isArray(c.relationshipLinks) ? c.relationshipLinks : [])) {
      if (link?.targetCharacterId) yield { c, link, targetId: link.targetCharacterId };
    }
  }
}

// ---------------------------------------------------------------------------
// Shared scaffolding for the object-attachment checks (#1288). All three walk
// `canon.objects × attachments`, resolving each attachment's `characterId`
// against the cast, so the id-bearing object/character lists, the id→character
// lookup, and the attachment iteration live here once.
// ---------------------------------------------------------------------------

function attachmentCanon(ctx) {
  const objects = (ctx.canon?.objects || []).filter((o) => o && o.id);
  const chars = (ctx.canon?.characters || []).filter((c) => c && c.id);
  return {
    objects,
    chars,
    nameById: new Map(chars.map((c) => [c.id, c.name || c.id])),
    charById: new Map(chars.map((c) => [c.id, c])),
  };
}

// Yields every attachment that points at a character, as { o, att }.
function* eachAttachment(objects) {
  for (const o of objects) {
    for (const att of (Array.isArray(o.attachments) ? o.attachments : [])) {
      if (att?.characterId) yield { o, att };
    }
  }
}

// A human-readable summary of every object + who's attached to it, fed to the
// unmotivated-interaction LLM so it knows which objects already carry an
// established stake (and which don't) before judging a prose interaction.
function describeObjectAttachments(ctx) {
  const { objects, nameById } = attachmentCanon(ctx);
  const lines = [];
  for (const o of objects) {
    const atts = Array.isArray(o.attachments) ? o.attachments : [];
    const sig = (o.significance || '').trim();
    const attText = atts.length
      ? atts.map((a) => {
        const who = nameById.get(a.characterId) || a.characterId;
        const emotion = a.emotion ? ` (${a.emotion})` : '';
        const why = a.significance ? ` — ${a.significance}` : '';
        return `${who}${emotion}${why}`;
      }).join('; ')
      : 'nobody';
    lines.push(`- ${o.name || o.id}${sig ? ` — significance: ${sig}` : ''}\n  attached to: ${attText}`);
  }
  return lines.join('\n') || '(no objects in canon)';
}

// The attachment rows whose `origin` can be checked against the attached
// character's `background` — both must be present, and the character must
// still exist (a dangling characterId is the UI/sanitizer's concern, not this
// check's). Shared by the backstory-consistency check's `gate` (cheap presence
// test) and its `run` (the actual prompt rows) so they never disagree.
function attachmentBackstoryRows(ctx) {
  const { objects, charById } = attachmentCanon(ctx);
  const rows = [];
  for (const { o, att } of eachAttachment(objects)) {
    const origin = (att.origin || '').trim();
    if (!origin) continue;
    const char = charById.get(att.characterId);
    if (!char) continue;
    const background = (char.background || '').trim();
    if (!background) continue;
    rows.push({
      object: o.name || o.id,
      character: char.name || char.id,
      emotion: (att.emotion || '').trim(),
      origin,
      background,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Shared LLM-check helpers. Every `kind: 'llm'` check normalizes the model's
// raw findings into the manuscriptReview comment shape, and a manuscript-
// consuming check additionally feeds the whole corpus to the model in
// provider-sized chunks (so a long series isn't truncated on a small/local
// provider) and merges the per-chunk findings. These collapse those repeated
// blocks so the field validation + chunk-merge live once.
// ---------------------------------------------------------------------------

// Fixed per-call prompt overhead (template scaffolding + JSON-shape
// instructions) reserved on top of any check-specific static vars, so the
// chunk budget leaves room for the prompt the manuscript rides inside.
export const EDITORIAL_PROMPT_OVERHEAD_TOKENS = 1_500;

// First-wins dedup key for an editorial finding, used to merge results across
// manuscript chunks. Mirrors completenessPass.findingKey: a finding identical on
// (issue, category, anchor, problem) is kept once even if two chunks surface it.
export const editorialFindingKey = (f) => [
  f.issueNumber ?? '',
  f.category ?? '',
  (f.anchorQuote || '').trim().toLowerCase().slice(0, 120),
  (f.problem || '').trim().toLowerCase().slice(0, 120),
].join('|');

// Merge per-chunk finding lists first-wins, capped at `max`. The cap bounds the
// WHOLE run (not each chunk) so a long, many-chunk manuscript can't flood the
// review — preserving `maxFindings`'s original single-call meaning.
export function mergeChunkFindings(lists, max = Infinity) {
  const merged = new Map();
  for (const list of (Array.isArray(lists) ? lists : [])) {
    for (const f of (Array.isArray(list) ? list : [])) {
      const k = editorialFindingKey(f);
      if (!merged.has(k)) merged.set(k, f);
    }
  }
  return [...merged.values()].slice(0, Math.max(0, max));
}

// Shared body for a manuscript-consuming LLM check. Plans the manuscript into
// provider-sized chunks for `stage` (via the runner-injected
// `ctx.planManuscriptChunks`), runs the model on each chunk, and merges the
// findings first-wins (capped at the check's `maxFindings`). `buildVars(chunk)`
// returns the stage vars — only the manuscript var changes per chunk. These
// checks are all manuscript-scoped, so findings keep a model-supplied issue
// number (`withIssueNumber: true`).
//
// `overheadTokens` MUST account for every non-manuscript prompt var the check
// re-sends on each chunk (the objects summary, the style-guide expectations,
// etc.) on top of EDITORIAL_PROMPT_OVERHEAD_TOKENS — those vars ride alongside
// the chunked manuscript, so under-counting them lets a chunk overrun the
// provider window.
async function runManuscriptLlmCheck(ctx, { stage, category, overheadTokens = 0, buildVars }) {
  const max = ctx.config?.maxFindings ?? 12;
  const chunks = await ctx.planManuscriptChunks(stage, { overheadTokens });
  const perChunk = [];
  for (const manuscript of chunks) {
    // Stop launching further chunk calls once the run is cancelled — the runner
    // only checks the signal around the whole check, so without this a multi-
    // chunk check keeps paying for LLM calls whose results will be discarded.
    if (ctx.signal?.aborted) break;
    const { content } = await ctx.callStagedLLM(stage, buildVars(manuscript), { returnsJson: true, source: stage });
    perChunk.push(mapLlmFindings(content?.findings, {
      severityDefault: ctx.severityDefault,
      category,
      max,
      withIssueNumber: true,
    }));
  }
  return mergeChunkFindings(perChunk, max);
}

// Normalize raw LLM findings into partial manuscriptReview comments: validate
// severity against the allow-list (fall back to the check default), force the
// check's `category`, coerce each string field, cap the count, and drop any
// finding with no `problem`. `withIssueNumber` keeps a model-supplied issue
// number (manuscript-scoped checks) vs. forcing null (canon-scoped checks).
function mapLlmFindings(raw, { severityDefault, category, max, withIssueNumber }) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, max).map((f) => ({
    severity: SEVERITIES.includes(f?.severity) ? f.severity : severityDefault,
    category,
    location: typeof f?.location === 'string' ? f.location : '',
    problem: typeof f?.problem === 'string' ? f.problem : '',
    suggestion: typeof f?.suggestion === 'string' ? f.suggestion : '',
    anchorQuote: typeof f?.anchorQuote === 'string' ? f.anchorQuote : '',
    issueNumber: withIssueNumber && Number.isInteger(f?.issueNumber) ? f.issueNumber : null,
  })).filter((f) => f.problem);
}

// ---------------------------------------------------------------------------
// User-defined (custom) LLM checks (#1346). A custom check has no shipped stage
// template — its prompt body is authored from the UI. The fixed JSON output
// contract is enforced HERE (not by the user), so an author only describes WHAT
// to look for; the response is parsed by the same `mapLlmFindings` the built-in
// stage prompts feed. Kept pure: the model caller (`ctx.callInlineLLM`) and the
// chunk planner (`ctx.planManuscriptChunks`) are injected by the runner.
// ---------------------------------------------------------------------------

// Free-form tag persisted on the run record so /runs can filter custom-check
// calls apart from the named-stage editorial checks.
export const CUSTOM_CHECK_RUN_SOURCE = 'pipeline-editorial-custom';

// Wrap a user's authored instructions in the fixed findings JSON contract. Pure
// and deterministic so it's unit-testable and so `runManuscriptLlmCheckInline`
// can render it once with an empty manuscript to measure per-call overhead.
export function buildCustomCheckPrompt({ instructions, manuscript, maxFindings = CUSTOM_CHECK_MAX_FINDINGS_DEFAULT }) {
  const cap = Number.isInteger(maxFindings) && maxFindings > 0 ? maxFindings : CUSTOM_CHECK_MAX_FINDINGS_DEFAULT;
  return [
    'You are an editorial reviewer analyzing a draft manuscript for one specific issue.',
    '',
    '# What to look for',
    String(instructions || '').trim(),
    '',
    '# Manuscript',
    String(manuscript || ''),
    '',
    '# How to respond',
    `Return ONLY a JSON object of the form {"findings": [...]} with at most ${cap} findings.`,
    'Each finding is an object with these fields:',
    '- "severity": one of "high", "medium", "low"',
    '- "location": a short human-readable pointer to where the problem is (e.g. a chapter or section name)',
    '- "problem": one sentence stating what is wrong (REQUIRED — omit the finding if you cannot name a concrete problem)',
    '- "suggestion": one sentence on how to fix it',
    '- "anchorQuote": a short verbatim quote from the manuscript at the problem location',
    '- "issueNumber": the issue/chapter number the problem is in, or null',
    'If nothing matches, return {"findings": []}. Do not include any prose outside the JSON object.',
  ].join('\n');
}

// Inline-prompt sibling of `runManuscriptLlmCheck` for custom checks: same
// provider-sized chunking + first-wins merge, but the prompt is the authored
// instructions wrapped by `buildCustomCheckPrompt` instead of a named stage.
// `ctx.planManuscriptChunks(null, …)` resolves the active/overridden provider's
// window (a custom check has no stage to pin), and `ctx.callInlineLLM` runs the
// built prompt. Findings keep a model-supplied issue number (manuscript-scoped).
async function runManuscriptLlmCheckInline(ctx, { category, instructions }) {
  const max = ctx.config?.maxFindings ?? CUSTOM_CHECK_MAX_FINDINGS_DEFAULT;
  // Fixed per-call overhead = the contract wrapper + the instructions (only the
  // manuscript var changes per chunk). Measure it by rendering the prompt with an
  // empty manuscript so the chunk budget accounts for everything riding along.
  const overheadTokens = EDITORIAL_PROMPT_OVERHEAD_TOKENS
    + estimateTokens(buildCustomCheckPrompt({ instructions, manuscript: '', maxFindings: max }));
  const chunks = await ctx.planManuscriptChunks(null, { overheadTokens });
  const perChunk = [];
  for (const manuscript of chunks) {
    if (ctx.signal?.aborted) break;
    const prompt = buildCustomCheckPrompt({ instructions, manuscript, maxFindings: max });
    const { content } = await ctx.callInlineLLM(prompt, { returnsJson: true, source: CUSTOM_CHECK_RUN_SOURCE });
    perChunk.push(mapLlmFindings(content?.findings, {
      severityDefault: ctx.severityDefault,
      category,
      max,
      withIssueNumber: true,
    }));
  }
  return mergeChunkFindings(perChunk, max);
}

// ---------------------------------------------------------------------------
// Deterministic helpers for the style-guide reading-level check (#1303). A
// self-contained Flesch–Kincaid grade-level estimate so the registry stays pure
// (no import out to the styleGuide lib). The heuristic is approximate — it only
// needs to catch "the prose reads several grades off the configured target".
// ---------------------------------------------------------------------------

// Hoisted out of countSyllables so the per-word loop over a full manuscript
// doesn't recompile them on every call.
const NON_ALPHA_RE = /[^a-z]/g;
const VOWEL_GROUP_RE = /[aeiouy]+/g;
const SENTENCE_END_RE = /[.!?]+/g;
const WORD_RE = /\b[a-zA-Z]+\b/g;

function countSyllables(word) {
  const w = String(word).toLowerCase().replace(NON_ALPHA_RE, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  // Drop a trailing silent 'e', then count vowel groups (each run of vowels is
  // ~one syllable). Floor at 1 — every real word has at least one.
  const groups = w.replace(/e$/, '').match(VOWEL_GROUP_RE);
  return Math.max(1, groups ? groups.length : 1);
}

// Flesch–Kincaid grade level for a manuscript corpus. Returns null when there
// are no words to measure (caller skips rather than flagging a phantom grade).
function readingGradeLevel(text) {
  const clean = String(text || '');
  const sentences = (clean.match(SENTENCE_END_RE) || []).length || 1;
  const words = clean.match(WORD_RE) || [];
  if (words.length === 0) return null;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
}

// Compact bullet list of the conformance-relevant style-guide expectations, fed
// to the conformance LLM so it knows exactly what to measure the prose against.
// Inlined (not imported from styleGuide.js) to keep this registry pure. Returns
// '' when no conformance-relevant field is set (the check's gate also tests this).
function styleGuideExpectations(sg) {
  if (!sg || typeof sg !== 'object') return '';
  const lines = [];
  if (sg.tense) lines.push(`- Tense: ${sg.tense}`);
  if (sg.povPerson) lines.push(`- Point-of-view person: ${sg.povPerson}`);
  if (sg.targetAudience) lines.push(`- Target audience: ${sg.targetAudience}`);
  if (sg.contentRating && sg.contentRating !== 'custom') lines.push(`- Content rating ceiling: ${sg.contentRating}`);
  if (sg.profanity) lines.push(`- Profanity allowed: ${sg.profanity}`);
  return lines.join('\n');
}

// True when the style guide carries at least one field the conformance LLM can
// measure prose against. Shared by the check's gate and run so they agree.
const hasConformanceFields = (sg) => styleGuideExpectations(sg).length > 0;

// ---------------------------------------------------------------------------
// Registry entries.
// ---------------------------------------------------------------------------

export const EDITORIAL_CHECKS = [
  {
    id: 'naming.dissimilar-names',
    sources: ['canon'],
    label: 'Character name dissimilarity',
    description:
      'Flags pairs of character names a reader could confuse — sharing a first letter, length, vowel pattern, opening, or ending.',
    scope: 'series',
    kind: 'deterministic',
    category: 'naming',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // How many similarity signals two names must share before they're flagged.
      minSharedSignals: z.number().int().min(1).max(5).default(2),
    }),
    configFields: [
      {
        key: 'minSharedSignals',
        label: 'Minimum shared signals to flag',
        type: 'number',
        min: 1,
        max: 5,
        step: 1,
        help: 'How many similarity signals (first letter, length, vowel pattern, opening, ending) two names must share before they are flagged.',
      },
    ],
    run: (ctx) => {
      const min = ctx.config?.minSharedSignals ?? 2;
      const names = (ctx.canon?.characters || [])
        .map((c) => (typeof c?.name === 'string' ? c.name.trim() : ''))
        .filter(Boolean);
      const findings = [];
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) {
          if (names[i].toLowerCase() === names[j].toLowerCase()) continue;
          const signals = nameSimilaritySignals(names[i], names[j]);
          if (signals.length < min) continue;
          findings.push({
            severity: ctx.severityDefault,
            category: 'naming',
            location: `Characters: ${names[i]} / ${names[j]}`,
            problem: `Character names "${names[i]}" and "${names[j]}" are easy to confuse (${signals.join(', ')}).`,
            suggestion: 'Rename one of these characters so readers can tell them apart at a glance.',
            anchorQuote: names[i],
            issueNumber: null,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'relationships.reciprocity',
    sources: ['canon'],
    label: 'Relationship reciprocity',
    description:
      'Flags one-sided structured relationship links — character A links to B, but B has no link back to A.',
    scope: 'series',
    kind: 'deterministic',
    category: 'continuity',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({}),
    run: (ctx) => {
      const { chars, nameById } = relationshipCanon(ctx);
      // For O(1) "does B link back to A?" lookups, index every link as a
      // "<source>→<target>" pair key.
      const linkPairs = new Set();
      for (const { c, targetId } of eachRelationshipLink(chars)) linkPairs.add(`${c.id}→${targetId}`);
      const findings = [];
      for (const { c, link, targetId } of eachRelationshipLink(chars)) {
        // A dangling target (B doesn't exist) is the dangling-target check's
        // job; reciprocity only speaks to links between two real characters.
        if (!nameById.has(targetId)) continue;
        if (linkPairs.has(`${targetId}→${c.id}`)) continue;
        const aName = nameById.get(c.id);
        const bName = nameById.get(targetId);
        findings.push({
          severity: ctx.severityDefault,
          category: 'continuity',
          location: `Characters: ${aName} → ${bName}`,
          problem: `"${aName}" has a ${link.type || 'custom'} link to "${bName}", but "${bName}" has no link back to "${aName}".`,
          suggestion: `Add a reciprocal relationship link from "${bName}" to "${aName}" (or remove the one-sided link if it's intentional).`,
          anchorQuote: aName,
          issueNumber: null,
        });
      }
      return findings;
    },
  },
  {
    id: 'relationships.dangling-target',
    sources: ['canon'],
    label: 'Relationship dangling target',
    description:
      'Flags structured relationship links that point at a character id no longer present in the canon (deleted or renamed away).',
    scope: 'series',
    kind: 'deterministic',
    category: 'continuity',
    severityDefault: 'medium',
    defaultEnabled: true,
    configSchema: z.object({}),
    run: (ctx) => {
      const { chars, nameById } = relationshipCanon(ctx);
      const findings = [];
      for (const { c, link, targetId } of eachRelationshipLink(chars)) {
        if (nameById.has(targetId)) continue;
        const aName = nameById.get(c.id);
        findings.push({
          severity: ctx.severityDefault,
          category: 'continuity',
          location: `Character: ${aName}`,
          problem: `"${aName}" has a ${link.type || 'custom'} relationship link pointing at a character id (${targetId}) that no longer exists in the canon.`,
          suggestion: 'Re-point the link at an existing character, or delete the stale link.',
          anchorQuote: aName,
          issueNumber: null,
        });
      }
      return findings;
    },
  },
  {
    id: 'relationships.opposition-reversal',
    sources: ['canon'],
    label: 'Opposition role-reversal payoff',
    description:
      'Advisory — surfaces every tagged opposing-force pair (hunter/prey, winner/loser…) so you can confirm whether the reader ever sees the roles reverse, or deliberately not.',
    scope: 'series',
    kind: 'deterministic',
    category: 'arc',
    severityDefault: 'low',
    defaultEnabled: false,
    configSchema: z.object({}),
    run: (ctx) => {
      const { chars, nameById } = relationshipCanon(ctx);
      const findings = [];
      // Dedupe by the unordered character pair + axis so a reciprocally-tagged
      // opposition (A→B and B→A on the SAME axis) surfaces once — but two
      // DIFFERENT axes on the same pair (hunter/prey AND winner/loser) each
      // surface, since they're distinct payoffs the reader tracks separately.
      const seenPairs = new Set();
      for (const { c, link, targetId } of eachRelationshipLink(chars)) {
        if (!link.opposition?.axis || !nameById.has(targetId)) continue;
        const pairKey = `${[c.id, targetId].sort().join('|')}|${link.opposition.axis}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        const aName = nameById.get(c.id);
        const bName = nameById.get(targetId);
        const { axis, thisRole, targetRole } = link.opposition;
        const roles = thisRole && targetRole ? ` (${aName}: ${thisRole}, ${bName}: ${targetRole})` : '';
        findings.push({
          severity: ctx.severityDefault,
          category: 'arc',
          location: `Characters: ${aName} / ${bName}`,
          problem: `Opposing-force pair tagged on "${aName}" / "${bName}" — axis "${axis}"${roles}.`,
          suggestion: 'Confirm the reader sees these roles reverse at some point in the arc (or that holding them fixed is the intended payoff).',
          anchorQuote: aName,
          issueNumber: null,
        });
      }
      return findings;
    },
  },
  {
    id: 'arc.ticking-clock-hygiene',
    sources: ['series.arc.tickingClock'],
    label: 'Ticking-clock hygiene',
    description:
      'Advisory — checks the series ticking clock/countdown is fully specified: named, with stakes, a plant→due span, and reminder beats so the reader does not forget it through the long middle.',
    scope: 'series',
    kind: 'deterministic',
    category: 'arc',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // How many reminder beats an enabled clock should carry. 0 disables the
      // reminder-count check while keeping the named/stakes/span checks.
      minReminders: z.number().int().min(0).max(20).default(1),
    }),
    configFields: [
      {
        key: 'minReminders',
        label: 'Minimum reminder beats',
        type: 'number',
        min: 0,
        max: 20,
        step: 1,
        help: 'How many reminder beats an enabled ticking clock should have so the reader does not forget it through the long middle.',
      },
    ],
    // Only audit a clock the author turned on — a disabled/absent clock means
    // "this story has no countdown", which is a valid choice, not a problem.
    gate: (ctx) => ctx.series?.arc?.tickingClock?.enabled === true,
    run: (ctx) => {
      const clock = ctx.series?.arc?.tickingClock;
      if (!clock || clock.enabled !== true) return [];
      const minReminders = ctx.config?.minReminders ?? 1;
      const label = clock.label || 'the ticking clock';
      const location = `Series arc: ${clock.label || 'ticking clock'}`;
      const findings = [];
      const flag = (problem, suggestion) => findings.push({
        severity: ctx.severityDefault,
        category: 'arc',
        location,
        problem,
        suggestion,
        anchorQuote: clock.label || '',
        issueNumber: null,
      });
      if (!clock.label) {
        flag(
          'The ticking clock is enabled but unnamed — the reader needs a concrete thing to count down to.',
          'Give the countdown a specific label (e.g. "The storm makes landfall").',
        );
      }
      if (!clock.stakes) {
        flag(
          `The ticking clock "${label}" has no stakes — it is unclear what the reader fears if it runs out.`,
          'State what happens when the clock hits zero so the countdown carries dread.',
        );
      }
      if (clock.plantedAtArcPosition == null) {
        flag(
          `The ticking clock "${label}" has no plant position — the reader never learns the countdown has started.`,
          'Set where the reader first learns of the countdown (plantedAtArcPosition).',
        );
      }
      if (clock.dueAtArcPosition == null) {
        flag(
          `The ticking clock "${label}" has no due position — there is no moment it lands.`,
          'Set where the countdown pays off (dueAtArcPosition).',
        );
      }
      // Plant and due share the arc-position coordinate space, so they're
      // directly comparable; a due at/before the plant leaves no span for
      // tension to build. (Reminders use issue numbers, a different axis, so
      // they're intentionally NOT compared against the plant/due span here.)
      if (
        clock.plantedAtArcPosition != null
        && clock.dueAtArcPosition != null
        && clock.dueAtArcPosition <= clock.plantedAtArcPosition
      ) {
        flag(
          `The ticking clock "${label}" is due (arc position ${clock.dueAtArcPosition}) at or before it is planted (${clock.plantedAtArcPosition}) — there is no span for tension to build.`,
          'Set the due position after the plant position.',
        );
      }
      const reminders = Array.isArray(clock.reminders) ? clock.reminders : [];
      if (reminders.length < minReminders) {
        flag(
          `The ticking clock "${label}" has ${reminders.length} reminder beat(s) (expected at least ${minReminders}) — without periodic reminders the reader forgets it through the long middle.`,
          'Add reminder beats between the plant and due to keep the countdown alive in the reader’s mind.',
        );
      }
      return findings;
    },
  },
  {
    id: 'objects.unattached-significant',
    sources: ['canon'],
    label: 'Unattached significant object',
    description:
      'Flags objects with written significance but no character attachment — the object clearly matters to the story, yet nobody in the cast is on record caring about it.',
    scope: 'series',
    kind: 'deterministic',
    category: 'continuity',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({}),
    run: (ctx) => {
      const { objects, nameById } = attachmentCanon(ctx);
      const findings = [];
      for (const o of objects) {
        // Only a LIVE attachment (one whose characterId still resolves to a
        // cast member) counts as "someone cares" — an object whose sole
        // attachment dangles at a deleted character is effectively unattached
        // (the UI shows it as "(missing)"), so it should still be flagged.
        const attachments = Array.isArray(o.attachments) ? o.attachments : [];
        const hasLiveAttachment = attachments.some((a) => a?.characterId && nameById.has(a.characterId));
        const significance = (o.significance || '').trim();
        if (hasLiveAttachment || !significance) continue;
        const name = o.name || o.id;
        findings.push({
          severity: ctx.severityDefault,
          category: 'continuity',
          location: `Object: ${name}`,
          problem: `"${name}" has written significance but no character is attached to it — what does this object mean to anyone in the cast?`,
          suggestion: 'Add an attachment linking this object to the character whose backstory or emotional stake it carries (or clear its significance if it is purely set dressing).',
          anchorQuote: name,
          issueNumber: null,
        });
      }
      return findings;
    },
  },
  {
    id: 'objects.unmotivated-interaction',
    sources: ['manuscript', 'canon'],
    label: 'Unmotivated object interaction',
    description:
      'LLM scan — flags moments where a character interacts meaningfully with an object the prose (and the canon attachments) have given them no reason to care about.',
    scope: 'issue',
    kind: 'llm',
    category: 'continuity',
    severityDefault: 'low',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a long manuscript can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so a long manuscript can not flood the review.',
      },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const objects = describeObjectAttachments(ctx);
      return runManuscriptLlmCheck(ctx, {
        stage: OBJECT_MOTIVATION_STAGE,
        category: 'continuity',
        // The objects-attachment summary is fixed per-call overhead.
        overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS + estimateTokens(objects),
        buildVars: (manuscript) => ({ manuscript, objects }),
      });
    },
  },
  {
    id: 'objects.backstory-consistency',
    sources: ['canon'],
    label: 'Attachment backstory consistency',
    description:
      "LLM check — flags object attachments whose origin story contradicts the attached character's established background.",
    scope: 'noun',
    kind: 'llm',
    category: 'continuity',
    severityDefault: 'medium',
    defaultEnabled: true,
    // Canon-only (no manuscript): compares each attachment's `origin` against the
    // attached character's `background`, both of which live on the canon.
    configSchema: z.object({
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so a large cast can not flood the review.',
      },
    ],
    // Skip the LLM call entirely when no attachment has both an origin AND an
    // attached character with a background to contradict.
    gate: (ctx) => attachmentBackstoryRows(ctx).length > 0,
    run: async (ctx) => {
      const rows = attachmentBackstoryRows(ctx);
      if (!rows.length) return [];
      const attachments = rows.map((r, i) =>
        `${i + 1}. Object "${r.object}" — ${r.character}'s attachment${r.emotion ? ` (${r.emotion})` : ''}\n`
        + `   Origin (how ${r.character} came to have it): ${r.origin}\n`
        + `   ${r.character}'s established background: ${r.background}`,
      ).join('\n\n');
      const { content } = await ctx.callStagedLLM(
        OBJECT_BACKSTORY_STAGE,
        { attachments },
        { returnsJson: true, source: OBJECT_BACKSTORY_STAGE },
      );
      return mapLlmFindings(content?.findings, {
        severityDefault: ctx.severityDefault,
        category: 'continuity',
        max: ctx.config?.maxFindings ?? 12,
        withIssueNumber: false,
      });
    },
  },
  {
    id: 'prose.info-dumping',
    sources: ['manuscript'],
    label: 'Info-dumping / "as you know, Bob" exposition',
    description:
      'Flags passages that dump backstory or world rules through unnatural exposition — characters telling each other what they both already know.',
    scope: 'issue',
    kind: 'llm',
    category: 'exposition',
    severityDefault: 'medium',
    defaultEnabled: true,
    // Reads the stitched manuscript corpus — so the runner only pays the
    // section-collection I/O when a manuscript-consuming check is enabled.
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a long manuscript can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so a long manuscript can not flood the review.',
      },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => runManuscriptLlmCheck(ctx, {
      stage: INFO_DUMPING_STAGE,
      category: 'exposition',
      overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS,
      buildVars: (manuscript) => ({ manuscript }),
    }),
  },
  {
    id: 'style.reading-level',
    sources: ['manuscript', 'series.styleGuide'],
    label: 'Reading-level conformance',
    description:
      "Measures the drafted manuscript's reading grade level (Flesch–Kincaid) and flags it when it drifts beyond a tolerance from the series style guide's target reading level.",
    scope: 'series',
    kind: 'deterministic',
    category: 'style',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript to measure the actual grade level.
    needsManuscript: true,
    configSchema: z.object({
      // How many grade levels the measured reading level may drift from the
      // target before it's flagged.
      tolerance: z.number().int().min(0).max(6).default(2),
    }),
    configFields: [
      {
        key: 'tolerance',
        label: 'Reading-level tolerance (grades)',
        type: 'number',
        min: 0,
        max: 6,
        step: 1,
        help: 'How many grade levels the measured reading level may differ from the style-guide target before it is flagged.',
      },
    ],
    // Only run when the style guide sets a target AND there's prose to measure.
    gate: (ctx) => Number.isFinite(ctx.series?.styleGuide?.readingLevel)
      && (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => {
      const target = ctx.series?.styleGuide?.readingLevel;
      if (!Number.isFinite(target)) return [];
      const grade = readingGradeLevel(ctx.manuscript);
      if (grade == null) return [];
      const tolerance = ctx.config?.tolerance ?? 2;
      const rounded = Math.round(grade * 10) / 10;
      const delta = rounded - target;
      if (Math.abs(delta) <= tolerance) return [];
      const tooHard = delta > 0;
      const off = Math.round(Math.abs(delta) * 10) / 10;
      return [{
        severity: ctx.severityDefault,
        category: 'style',
        location: 'Series manuscript (whole-corpus reading level)',
        problem: `The drafted manuscript reads at about a grade-${rounded} level, ${tooHard ? 'above' : 'below'} the style-guide target of grade ${target} (off by ${off} grade${off === 1 ? '' : 's'}).`,
        suggestion: tooHard
          ? 'Shorten sentences and prefer plainer words to bring the reading level down toward the target.'
          : 'Vary sentence length and vocabulary to raise the reading level toward the target.',
        anchorQuote: '',
        issueNumber: null,
      }];
    },
  },
  {
    id: 'style.conformance',
    sources: ['manuscript', 'series.styleGuide'],
    label: 'Style-guide conformance (tense / POV / rating)',
    description:
      "LLM scan — flags passages where the prose drifts from the series style guide's tense, point-of-view person, or content rating (profanity/violence/sexual content beyond the configured ceiling).",
    scope: 'issue',
    kind: 'llm',
    category: 'style',
    severityDefault: 'medium',
    defaultEnabled: true,
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a long manuscript can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    configFields: [
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so a long manuscript can not flood the review.',
      },
    ],
    // Skip unless there's prose AND the style guide declares at least one
    // conformance-relevant field (tense / POV / rating / profanity / audience).
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0
      && hasConformanceFields(ctx.series?.styleGuide),
    run: (ctx) => {
      const expectations = styleGuideExpectations(ctx.series?.styleGuide);
      if (!expectations) return [];
      return runManuscriptLlmCheck(ctx, {
        stage: STYLE_CONFORMANCE_STAGE,
        category: 'style',
        // The style-guide expectations are fixed per-call overhead.
        overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS + estimateTokens(expectations),
        buildVars: (manuscript) => ({ manuscript, styleGuide: expectations }),
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Fail-fast guards (mirror navManifest.js). Runs at module load on the real
// registry so a bad entry blocks server boot instead of silently breaking the
// runner; exported so the invariant tests can exercise the throw paths the
// valid built-in array can't reach.
// ---------------------------------------------------------------------------

export function assertValidChecks(checks) {
  const seen = new Set();
  for (const check of checks) {
    if (!check.id || !check.label || !check.scope || !check.kind || !check.category) {
      throw new Error(`checkRegistry: malformed entry ${JSON.stringify(check)}`);
    }
    if (!CHECK_SCOPES.includes(check.scope)) {
      throw new Error(`checkRegistry: invalid scope "${check.scope}" for ${check.id} (must be one of ${CHECK_SCOPES.join(', ')})`);
    }
    if (!CHECK_KINDS.includes(check.kind)) {
      throw new Error(`checkRegistry: invalid kind "${check.kind}" for ${check.id} (must be one of ${CHECK_KINDS.join(', ')})`);
    }
    if (!SEVERITIES.includes(check.severityDefault)) {
      throw new Error(`checkRegistry: invalid severityDefault "${check.severityDefault}" for ${check.id}`);
    }
    if (typeof check.run !== 'function') {
      throw new Error(`checkRegistry: ${check.id} is missing a run() function`);
    }
    if (!check.configSchema || typeof check.configSchema.safeParse !== 'function') {
      throw new Error(`checkRegistry: ${check.id} is missing a Zod configSchema`);
    }
    // `sources` declares the inputs the check reads so the runner can fingerprint
    // exactly those for staleness (#1387). Required + non-empty + known tokens.
    // A 'manuscript' source implies `needsManuscript` (the runner gates the
    // corpus-collection I/O on that flag) — keeping the two consistent prevents a
    // check that fingerprints the manuscript but never triggers its collection.
    if (!Array.isArray(check.sources) || check.sources.length === 0) {
      throw new Error(`checkRegistry: ${check.id} must declare a non-empty sources array (one of ${EDITORIAL_SOURCES.join(', ')})`);
    }
    for (const source of check.sources) {
      if (!EDITORIAL_SOURCES.includes(source)) {
        throw new Error(`checkRegistry: ${check.id} declares unknown source "${source}" (must be one of ${EDITORIAL_SOURCES.join(', ')})`);
      }
    }
    if (check.sources.includes('manuscript') && !check.needsManuscript) {
      throw new Error(`checkRegistry: ${check.id} reads the 'manuscript' source but is not marked needsManuscript`);
    }
    // configFields is optional, but when present each entry must be a renderable
    // descriptor (key + label + known type) so the UI never has to guess a
    // field's control. The Zod configSchema remains the validation authority —
    // configFields only drives the form, so we don't cross-check key coverage.
    if (check.configFields !== undefined) {
      if (!Array.isArray(check.configFields)) {
        throw new Error(`checkRegistry: ${check.id} configFields must be an array`);
      }
      for (const field of check.configFields) {
        if (!field || !field.key || !field.label || !CHECK_FIELD_TYPES.includes(field.type)) {
          throw new Error(`checkRegistry: ${check.id} has a malformed configField ${JSON.stringify(field)} (need key, label, type ∈ ${CHECK_FIELD_TYPES.join('/')})`);
        }
      }
    }
    if (seen.has(check.id)) throw new Error(`checkRegistry: duplicate id ${check.id}`);
    seen.add(check.id);
  }
}

assertValidChecks(EDITORIAL_CHECKS);

// ---------------------------------------------------------------------------
// Lookup + state resolution helpers.
// ---------------------------------------------------------------------------

const CHECK_BY_ID = new Map(EDITORIAL_CHECKS.map((c) => [c.id, c]));

export const getCheck = (id) => CHECK_BY_ID.get(id) || null;

export const listChecks = () => EDITORIAL_CHECKS.slice();

// Validate (and default-fill) a persisted per-check config blob through the
// check's Zod schema. Falls back to the schema's defaults when the stored blob
// is absent or invalid, so a hand-edited settings.json can't make a check throw
// (re-parsing `{}` materializes the schema defaults).
export function resolveCheckConfig(check, storedConfig) {
  const parsed = check.configSchema.safeParse(storedConfig ?? {});
  return parsed.success ? parsed.data : (check.configSchema.safeParse({}).data ?? {});
}

// Read the persisted per-check map from settings, tolerant of a hand-edited /
// older-peer file. Exported so the route reads the slice through the same guard.
export const readChecksSlice = (settings) => {
  const slice = settings?.pipelineEditorialChecks?.checks;
  return slice && typeof slice === 'object' && !Array.isArray(slice) ? slice : {};
};

/**
 * Merge the static registry with persisted per-check state from settings.
 * Returns one row per registered check:
 *   { id, label, description, scope, kind, category, severityDefault,
 *     enabled, config, configFields }
 * `enabled` falls back to the check's `defaultEnabled`; `config` is validated
 * through the check's schema (with defaults); `configFields` is the wire-safe
 * render descriptor the UI builds its config form from (empty array when the
 * check declares none).
 */
export function resolveCheckState(settings) {
  const stored = readChecksSlice(settings);
  // Built-ins + the user's synthesized custom checks (#1346) — a custom check
  // resolves identically; `isCustom` (and the authored `prompt`) mark it so the
  // UI can offer edit/delete and prefill the author form.
  return getAllChecks(settings).map((check) => {
    const row = stored[check.id] || {};
    const enabled = typeof row.enabled === 'boolean' ? row.enabled : check.defaultEnabled !== false;
    return {
      id: check.id,
      label: check.label,
      description: check.description,
      scope: check.scope,
      kind: check.kind,
      category: check.category,
      severityDefault: check.severityDefault,
      enabled,
      config: resolveCheckConfig(check, row.config),
      configFields: Array.isArray(check.configFields) ? check.configFields : [],
      isCustom: !!check.isCustom,
      ...(check.isCustom ? { prompt: check.prompt } : {}),
    };
  });
}

/**
 * The resolved-state rows for the checks that should run: enabled, narrowed to
 * `subsetIds` when provided. Shared by `getEnabledChecks` (execution) and the
 * runner's dry-run plan (preview), so the enable/subset filter lives once.
 */
export function getEnabledCheckRows(settings, subsetIds = null) {
  const subset = Array.isArray(subsetIds) && subsetIds.length ? new Set(subsetIds) : null;
  return resolveCheckState(settings).filter((row) => row.enabled && (!subset || subset.has(row.id)));
}

/**
 * The checks that should actually run for a given settings + optional subset.
 * Returns `{ check, config }` pairs (the live registry entry + its resolved
 * config) for every enabled check, narrowed to `subsetIds` when provided.
 */
export function getEnabledChecks(settings, subsetIds = null) {
  // Resolve against built-ins + custom checks (getCheck only knows built-ins).
  const byId = new Map(getAllChecks(settings).map((c) => [c.id, c]));
  return getEnabledCheckRows(settings, subsetIds)
    .map((row) => ({ check: byId.get(row.id), config: row.config }))
    .filter((x) => x.check);
}

// ---------------------------------------------------------------------------
// User-defined checks (#1346) — definition storage + synthesis.
//
// A custom check's DEFINITION lives in settings
// (`pipelineEditorialChecks.customChecks`), while its enable/config override
// reuses the SAME `checks[id]` slice the built-ins use — so the existing
// toggle/config PATCH path works unchanged. `buildCustomCheck` synthesizes a
// definition into the exact shape the registry/runner consume, so a custom check
// flows through resolveCheckState / getEnabledChecks / the runner like a built-in.
// ---------------------------------------------------------------------------

export const CUSTOM_CHECK_ID_PREFIX = 'custom.';
export const isCustomCheckId = (id) => typeof id === 'string' && id.startsWith(CUSTOM_CHECK_ID_PREFIX);

// One tunable (the per-run cap), mirroring the built-in LLM checks so the
// existing config form renders for custom checks with no special-casing.
const customCheckConfigSchema = z.object({
  maxFindings: z.number().int().min(1).max(50).default(CUSTOM_CHECK_MAX_FINDINGS_DEFAULT),
});
const CUSTOM_CHECK_CONFIG_FIELDS = Object.freeze([
  {
    key: 'maxFindings',
    label: 'Max findings per run',
    type: 'number',
    min: 1,
    max: 50,
    step: 1,
    help: 'Cap findings so a long manuscript can not flood the review.',
  },
]);

// True when a stored definition has the minimum viable shape. Defensive against
// a hand-edited settings.json or an older/newer peer — an invalid def is skipped
// (never throws), so one bad row can't break the whole catalog.
export function isValidCustomCheckDef(def) {
  return !!def
    && typeof def === 'object'
    && isCustomCheckId(def.id)
    && typeof def.label === 'string' && def.label.trim().length > 0
    && typeof def.prompt === 'string' && def.prompt.trim().length > 0
    && CHECK_SCOPES.includes(def.scope)
    && CHECK_SEVERITIES.includes(def.severityDefault);
}

// Synthesize a runnable check from a stored definition (or null when malformed).
// The result matches the built-in shape so the runner/resolver treat it the
// same; `isCustom` + `prompt` mark it for the UI. Custom checks are always
// manuscript-consuming LLM checks (the useful editorial case), gated on prose.
export function buildCustomCheck(def) {
  if (!isValidCustomCheckDef(def)) return null;
  const instructions = def.prompt;
  const category = typeof def.category === 'string' && def.category.trim() ? def.category.trim() : 'custom';
  return {
    id: def.id,
    label: def.label.trim(),
    description: typeof def.description === 'string' ? def.description.trim() : '',
    scope: def.scope,
    kind: 'llm',
    category,
    severityDefault: def.severityDefault,
    defaultEnabled: true,
    needsManuscript: true,
    // Custom checks read only the stitched manuscript (the inline prompt is fed
    // the corpus, nothing else), so their findings stale on a prose edit alone (#1387).
    sources: ['manuscript'],
    isCustom: true,
    prompt: instructions,
    configSchema: customCheckConfigSchema,
    configFields: CUSTOM_CHECK_CONFIG_FIELDS,
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => runManuscriptLlmCheckInline(ctx, { category, instructions }),
  };
}

// The stored custom-check definitions, tolerant of a hand-edited / older-peer
// file (returns [] when absent or not an array).
export const readCustomCheckDefs = (settings) => {
  const defs = settings?.pipelineEditorialChecks?.customChecks;
  return Array.isArray(defs) ? defs : [];
};

// Synthesized custom checks for the current settings (invalid defs skipped).
export const buildCustomChecks = (settings) =>
  readCustomCheckDefs(settings).map(buildCustomCheck).filter(Boolean);

// All checks (built-in + custom) for the current settings.
export const getAllChecks = (settings) => [...EDITORIAL_CHECKS, ...buildCustomChecks(settings)];

// Settings-aware lookup spanning built-ins + custom checks. `getCheck` only
// knows built-ins, so the route + staleness path use this to resolve a custom id.
export function getCheckById(settings, id) {
  return CHECK_BY_ID.get(id) || buildCustomChecks(settings).find((c) => c.id === id) || null;
}
