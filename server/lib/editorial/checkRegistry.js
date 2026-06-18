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
import { analyzeNamePair, findFirstLetterClusters, normalizeName } from './nameSimilarity.js';

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
//   - 'reverseOutline'          — the cached reverse-outline scene segmentation (#1286);
//                                 scenes carry components/povCharacter/charactersPresent.
//                                 The runner fetches it (gated on this source) and injects
//                                 `ctx.reverseOutline` (the scenes array).
//   - 'series.arc.readerMap'    — the series arc's authored reader-map (#1299): the
//                                 writer-logged hooks (questions planted) and payoffs
//                                 (their resolutions). The Chekhov check reconciles its
//                                 detected setups/payoffs against these authored ones.
export const EDITORIAL_SOURCES = Object.freeze([
  'manuscript',
  'canon',
  'series.styleGuide',
  'series.arc.tickingClock',
  'series.arc.readerMap',
  'reverseOutline',
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

// Stage name for the protagonist-interiority LLM check (#1294). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 099 (boot runs
// migrations but NOT setup-data, so the migration is required).
export const INTERIORITY_STAGE = 'pipeline-editorial-interiority';

// Stage name for the Chekhov's-guns setup/payoff LLM check (#1299). Ships in
// data.reference/prompts/stages/ + stage-config.json (fresh installs via
// setup-data.js) and migrates to existing installs via migration 100 (boot runs
// migrations but NOT setup-data, so the migration is required).
export const CHEKHOV_STAGE = 'pipeline-editorial-chekhov';

// Render the authored reader-map hooks/payoffs (#1299) into a compact text block
// the Chekhov check passes alongside the manuscript so the model reconciles its
// DETECTED setups/payoffs against what the writer has already LOGGED — e.g. an
// authored hook with no detected payoff, or a detected payoff the writer never
// logged. Pure + deterministic so it's unit-testable and so its token cost can be
// counted into the per-chunk overhead. Returns '' when nothing is authored (the
// prompt's `{{#authoredSetups}}` section then renders nothing).
export function authoredSetupPayoffSummary(readerMap) {
  const hooks = Array.isArray(readerMap?.hooks) ? readerMap.hooks : [];
  const payoffs = Array.isArray(readerMap?.payoffs) ? readerMap.payoffs : [];
  const line = (e) => {
    const label = typeof e?.label === 'string' ? e.label.trim() : '';
    const note = typeof e?.note === 'string' ? e.note.trim() : '';
    const text = label && note ? `${label} — ${note}` : (label || note);
    if (!text) return '';
    // A coarse expected-location hint so the model can reason about WHERE an
    // authored hook should have paid off (reconciliation signal, #1299).
    const pos = Number.isFinite(e?.atArcPosition) ? ` (arc position ${e.atArcPosition})` : '';
    return `- ${text}${pos}`;
  };
  const hookLines = hooks.map(line).filter(Boolean);
  const payoffLines = payoffs.map(line).filter(Boolean);
  if (!hookLines.length && !payoffLines.length) return '';
  const parts = [];
  if (hookLines.length) parts.push(`Authored hooks (questions the writer planted):\n${hookLines.join('\n')}`);
  if (payoffLines.length) parts.push(`Authored payoffs (resolutions the writer logged):\n${payoffLines.join('\n')}`);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Character-name dissimilarity (#1291) reads cast names + aliases and respects
// locked entries. The pure similarity primitives live in ./nameSimilarity.js;
// the helpers below turn the canon into the flat name list the check walks.
// ---------------------------------------------------------------------------

// SEVERITIES is ordered high→…→low (index 0 = most severe). Escalate `base` up
// by `steps` ranks, clamped at the top — a strong collision (near-identical
// spelling, dense first-letter cluster) outranks the check's low floor.
function escalateSeverity(base, steps) {
  const i = SEVERITIES.indexOf(base);
  const idx = i === -1 ? SEVERITIES.length - 1 : i;
  return SEVERITIES[Math.max(0, idx - Math.max(0, steps))];
}

// The flat list of confusable name tokens for a cast: each character's `name`
// plus every alias, tagged with the owning character (id-or-index), whether that
// character is locked, and whether the token is an alias. Two tokens owned by the
// same character never pair (a name vs. its own alias isn't a reader collision).
function castNameTokens(ctx) {
  const chars = Array.isArray(ctx.canon?.characters) ? ctx.canon.characters : [];
  const tokens = [];
  chars.forEach((c, idx) => {
    if (!c || typeof c !== 'object') return;
    const owner = c.id || `idx-${idx}`;
    const locked = c.locked === true;
    const primary = typeof c.name === 'string' ? c.name.trim() : '';
    if (primary) tokens.push({ token: primary, owner, ownerName: primary, locked, isAlias: false });
    const aliases = Array.isArray(c.aliases) ? c.aliases : [];
    for (const a of aliases) {
      const alias = typeof a === 'string' ? a.trim() : '';
      if (alias) tokens.push({ token: alias, owner, ownerName: primary || alias, locked, isAlias: true });
    }
  });
  return tokens;
}

// A name token's display label — an alias is annotated with its owning character
// so the finding text and the rename suggestion always name the source.
const tokenLabel = (t) => (t.isAlias ? `${t.token} (alias of ${t.ownerName})` : t.token);

// How to phrase the rename suggestion given which of the two characters are
// locked — always steer the author toward renaming an UNLOCKED one (#1291).
function renameSuggestion(a, b) {
  if (a.locked && b.locked) {
    return `Both ${a.ownerName} and ${b.ownerName} are locked — unlock one to rename it so readers can tell them apart.`;
  }
  if (a.locked) return `Rename ${b.ownerName} (${a.ownerName} is locked) so it reads less like "${tokenLabel(a)}".`;
  if (b.locked) return `Rename ${a.ownerName} (${b.ownerName} is locked) so it reads less like "${tokenLabel(b)}".`;
  return `Rename one of ${a.ownerName} / ${b.ownerName} so readers can tell them apart at a glance.`;
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

// Cross-chunk continuity digest (#1383). When a manuscript is too long for the
// provider window it is reviewed chunk-by-chunk; a check whose problems span
// chapters (an object set up early and paid off late; tense/POV established in
// chapter 1 judged against chapter 3) can't see that with a per-chunk view.
// These constants bound the rolling digest of prior-chunk findings fed to later
// chunks so it stays small enough to ride in the chunk's spare budget.
export const EDITORIAL_PRIOR_DIGEST_MAX = 40;
// Only the findings BODY is capped — the fixed header and the trailing `---`
// delimiter are always added AFTER the cap (the next manuscript chunk is
// concatenated right after the digest, so the delimiter MUST survive or the
// manuscript bleeds into the "already recorded" list).
export const EDITORIAL_PRIOR_DIGEST_BODY_CHARS = 2_000;
const EDITORIAL_PRIOR_DIGEST_HEADER = '# Editorial findings already recorded for EARLIER parts of this manuscript\n'
  + 'Do not repeat these. Flag only NEW problems in the text below, plus any cross-chapter '
  + 'continuity these earlier findings reveal (e.g. an object set up earlier, or a tense/POV '
  + 'choice established in an earlier chapter).\n\n';
const EDITORIAL_PRIOR_DIGEST_SEPARATOR = '\n\n---\n\n';
// Whole-digest char ceiling = fixed wrapper + capped body. The digest is only
// prepended to a chunk when it fits in that chunk's spare budget (see
// runChunkedManuscriptCheck), so it never grows a chunk past the provider window.
export const EDITORIAL_PRIOR_DIGEST_CHARS =
  EDITORIAL_PRIOR_DIGEST_HEADER.length + EDITORIAL_PRIOR_DIGEST_BODY_CHARS + EDITORIAL_PRIOR_DIGEST_SEPARATOR.length;

// One-block digest of findings already recorded for earlier chunks, prepended
// INSIDE the next chunk's manuscript var so no prompt template changes (mirrors
// completenessPass.priorFindingsDigest). Pure + capped for unit-testing. Returns
// '' when there are no prior findings so the first chunk is untouched.
//
// Scope note: this carries prior FINDINGS, not clean prior setup (same as the
// completeness pass). It removes the duplicate/contradiction blind spot — a
// later chunk won't re-flag something an earlier chunk already flagged — but it
// can't tell a later chunk that an earlier chunk *cleanly* established an object's
// motivation or a tense. Carrying clean cross-chunk context would need a
// per-chunk content summary (extra LLM calls); tracked as a follow-up in #1403.
export function editorialPriorFindingsDigest(findings) {
  if (!Array.isArray(findings) || !findings.length) return '';
  const lines = findings.slice(0, EDITORIAL_PRIOR_DIGEST_MAX).map((f) => {
    const where = Number.isInteger(f.issueNumber) ? `Issue ${f.issueNumber}` : (f.location || 'general');
    return `- [${where}] ${f.category}: ${f.problem}`;
  });
  const more = findings.length > EDITORIAL_PRIOR_DIGEST_MAX
    ? `\n(+${findings.length - EDITORIAL_PRIOR_DIGEST_MAX} more earlier findings)` : '';
  // Cap the body only — the header and the trailing `---` separator are appended
  // afterwards so they always survive (see EDITORIAL_PRIOR_DIGEST_BODY_CHARS).
  const body = `${lines.join('\n')}${more}`.slice(0, EDITORIAL_PRIOR_DIGEST_BODY_CHARS);
  return `${EDITORIAL_PRIOR_DIGEST_HEADER}${body}${EDITORIAL_PRIOR_DIGEST_SEPARATOR}`;
}

// Cross-chunk CLEAN-SETUP digest (#1403). The findings digest above carries prior
// problems forward, but it cannot tell a later chunk that an earlier chunk
// *cleanly* established context (an object's motivation, a tense/POV/rating) —
// clean setup produces no finding, so a payoff in a later chunk can be mis-flagged
// "missing setup". This digest threads a short rolling summary of established
// setup alongside the findings digest, generated by one extra summarization LLM
// call per chunk (see `runManuscriptLlmCheck`'s `crossChunkSetup` path).
//
// (When the reverse-outline (#1349) or continuity-bible (#1305) artifacts land,
// either could supply this cross-chunk context more cheaply than a per-chunk
// summary call — they already condense the manuscript. Until then this is the
// self-contained source.)
//
// Free-form run tag so /runs can filter the setup-summary calls apart from the
// named-stage editorial checks and custom-check calls.
export const EDITORIAL_SETUP_DIGEST_SOURCE = 'pipeline-editorial-setup-digest';
// Body cap for the rolling setup summary (a touch smaller than the findings
// digest — it is condensed prose, not a bounded findings list). Header + trailing
// `---` are appended AFTER the cap so the delimiter always survives truncation
// (the next manuscript chunk concatenates right after, same contract as the
// findings digest).
export const EDITORIAL_SETUP_DIGEST_BODY_CHARS = 1_500;
const EDITORIAL_SETUP_DIGEST_HEADER =
  '# Setup already established in EARLIER parts of this manuscript (clean context — these are NOT problems)\n'
  + 'Use this when judging the text below: do NOT flag a payoff as missing setup, or a tense/POV/rating as a '
  + 'drift, if it was already established here.\n\n';
const EDITORIAL_SETUP_DIGEST_SEPARATOR = '\n\n---\n\n';
// Whole-digest char ceiling = fixed wrapper + capped body. Like the findings
// digest, the setup digest is prepended only when it fits the chunk's spare
// budget, so it never grows a chunk past the provider window.
export const EDITORIAL_SETUP_DIGEST_CHARS =
  EDITORIAL_SETUP_DIGEST_HEADER.length + EDITORIAL_SETUP_DIGEST_BODY_CHARS + EDITORIAL_SETUP_DIGEST_SEPARATOR.length;

// Wrap an accumulated "setup so far" summary in the fixed header + trailing `---`
// so it rides INSIDE the next chunk's manuscript var (no prompt template change,
// mirrors editorialPriorFindingsDigest). Returns '' for an empty/non-string
// summary so the first chunk (no prior setup yet) is untouched.
export function editorialSetupDigest(summary) {
  if (typeof summary !== 'string' || !summary.trim()) return '';
  const body = summary.trim().slice(0, EDITORIAL_SETUP_DIGEST_BODY_CHARS);
  return `${EDITORIAL_SETUP_DIGEST_HEADER}${body}${EDITORIAL_SETUP_DIGEST_SEPARATOR}`;
}

// Build the inline summarization prompt that maintains the rolling "setup so far"
// summary. Pure + deterministic so it's unit-testable and so the caller can pin a
// per-check `focus` (the objects check tracks item motivations; the style check
// tracks tense/POV/rating). Asks for terse merged setup text only — no JSON, no
// commentary — since the result rides verbatim into the next chunk's digest.
export function buildSetupDigestPrompt({ focus, priorSummary, manuscript }) {
  const trackDefault = 'Items/objects introduced and any motivation or significance established for them; '
    + 'the narrative tense, point-of-view person, and content rating in force.';
  return [
    'You are tracking established narrative SETUP across a long manuscript reviewed in parts.',
    'Maintain a SHORT running summary of the setup so far — only the facts a later part needs to judge payoffs and continuity.',
    '',
    '# What to track',
    String(focus || '').trim() || trackDefault,
    '',
    '# Setup recorded so far (from earlier parts)',
    String(priorSummary || '').trim() || '(none yet)',
    '',
    '# New manuscript part',
    String(manuscript || ''),
    '',
    '# How to respond',
    'Return an updated running summary that MERGES the prior setup with any new setup established in this part.',
    'Be terse: short bullet lines, no preamble, no commentary — only the established facts, dropping nothing important from the prior summary.',
    'Respond with the summary text only: no JSON, no section headers, no explanation.',
  ].join('\n');
}

// Shared chunk loop for the manuscript-consuming LLM checks: run `callChunk` on
// each provider-sized chunk, normalize + merge findings first-wins (capped at
// `max` across the whole run). When `crossChunkDigest` is set, each chunk after
// the first is prefixed with a digest of the findings gathered so far so the
// model keeps cross-chapter continuity in view; the digest rides INSIDE the
// chunk text passed to `callChunk`, so the per-check prompt template is
// unchanged. Merges incrementally (vs collect-then-merge) so the digest is O(1)
// to derive from the running map.
//
// The digest YIELDS to manuscript coverage: it is prepended only when it fits in
// the chunk's spare budget (`usableChars - chunk length`, exposed by the runner's
// chunker). So it never displaces manuscript text and never grows a chunk past
// the provider window — a chunk packed up to the budget simply runs without a
// digest rather than dropping its tail. When the chunker doesn't report a budget
// (a fits-in-one-call provider, or a test stub), there is unbounded headroom.
//
// `summarizeChunk` (#1403) opts in the CLEAN-SETUP digest: when provided, after
// each non-final chunk it is called `(priorSummary, chunkText) => nextSummary` to
// roll forward a short "setup so far" summary, and that summary's `editorialSetupDigest`
// is prepended (alongside the findings digest, after it in the budget) to later
// chunks — also yielding to spare room. It is a no-op for a single-chunk run (no
// later chunk consumes a summary), so the common fits-in-one-call provider pays
// nothing.
async function runChunkedManuscriptCheck(ctx, { chunks, category, max, callChunk, crossChunkDigest = false, summarizeChunk = null }) {
  const usableChars = Number.isFinite(chunks?.usableChars) ? chunks.usableChars : Infinity;
  const merged = new Map();
  // The presence of `summarizeChunk` (set only when the check opts into the
  // clean-setup digest AND an inline LLM caller is available) is itself the gate —
  // no separate flag, so the null-checks below can't drift from it.
  let setupSummary = '';
  for (let i = 0; i < chunks.length; i++) {
    const manuscript = chunks[i];
    // Stop launching further chunk calls once the run is cancelled — the runner
    // only checks the signal around the whole check, so without this a multi-
    // chunk check keeps paying for LLM calls whose results will be discarded.
    if (ctx.signal?.aborted) break;
    let text = manuscript;
    if (crossChunkDigest && merged.size) {
      const digest = editorialPriorFindingsDigest([...merged.values()]);
      // Only prepend when the digest fits the chunk's spare room — never trim the
      // manuscript (would drop review coverage) or overflow the window.
      if (digest && digest.length <= usableChars - text.length) text = `${digest}${manuscript}`;
    }
    if (summarizeChunk && setupSummary) {
      const setup = editorialSetupDigest(setupSummary);
      // Fits into whatever spare room remains AFTER the findings digest — manuscript
      // coverage and the findings digest both win over the setup digest if budget is tight.
      if (setup && setup.length <= usableChars - text.length) text = `${setup}${text}`;
    }
    // `isFinal` lets a check distinguish the last part of a chunked manuscript
    // from earlier ones (#1299): a whole-corpus judgment like "this setup is
    // never paid off" can only be made once the final part is in view, so the
    // Chekhov check defers its "planted, never fired" findings to it. A
    // single-chunk run is its own final part, so the common (provider-fits-the-
    // book) case judges against the whole text. Existing checks ignore the arg.
    const content = await callChunk(text, { isFinal: i === chunks.length - 1 });
    for (const f of mapLlmFindings(content?.findings, {
      severityDefault: ctx.severityDefault,
      category,
      max,
      withIssueNumber: true,
    })) {
      const k = editorialFindingKey(f);
      if (!merged.has(k)) merged.set(k, f);
    }
    // Roll the setup summary forward for the NEXT chunk — skip after the last chunk
    // (nothing consumes it) and on cancellation (its result would be discarded).
    // Summarize the RAW chunk, never the digest-prefixed text. A summarizer failure
    // must not abort the check — keep the prior summary and continue.
    if (summarizeChunk && i < chunks.length - 1 && !ctx.signal?.aborted) {
      const next = await summarizeChunk(setupSummary, manuscript).catch(() => setupSummary);
      // Cap the STORED summary, not just the rendered digest: a verbose/echoing
      // summarizer response is fed back into the next summarization prompt as the
      // prior summary, so an uncapped string would compound and could overflow the
      // provider context. Trimming here bounds both the next prompt and the digest.
      if (typeof next === 'string' && next.trim()) {
        setupSummary = next.trim().slice(0, EDITORIAL_SETUP_DIGEST_BODY_CHARS);
      }
    }
  }
  return [...merged.values()].slice(0, Math.max(0, max));
}

// Shared body for a manuscript-consuming LLM check. Plans the manuscript into
// provider-sized chunks for `stage` (via the runner-injected
// `ctx.planManuscriptChunks`), runs the model on each chunk, and merges the
// findings first-wins (capped at the check's `maxFindings`). `buildVars(chunk, meta)`
// returns the stage vars — only the manuscript var changes per chunk; `meta.isFinal`
// is true on the last (or only) chunk so a check can gate whole-corpus judgments to
// it (the Chekhov "planted, never fired" pass). Existing checks ignore `meta`. These
// checks are all manuscript-scoped, so findings keep a model-supplied issue
// number (`withIssueNumber: true`).
//
// `overheadTokens` MUST account for every non-manuscript prompt var the check
// re-sends on each chunk (the objects summary, the style-guide expectations,
// etc.) on top of EDITORIAL_PROMPT_OVERHEAD_TOKENS — those vars ride alongside
// the chunked manuscript, so under-counting them lets a chunk overrun the
// provider window.
async function runManuscriptLlmCheck(ctx, { stage, category, overheadTokens = 0, buildVars, crossChunkDigest = false, crossChunkSetup = false, setupFocus = '' }) {
  const max = ctx.config?.maxFindings ?? 12;
  // Chunks are planned at the full usable budget; the digest is fitted into each
  // later chunk's spare room inside runChunkedManuscriptCheck (it yields to the
  // manuscript), so no budget is reserved or carved out here.
  const chunks = await ctx.planManuscriptChunks(stage, { overheadTokens });
  // Clean-setup digest (#1403): roll a short "setup so far" summary forward via an
  // inline summarization call. Only wired when the check opts in AND the runner
  // injected the stage-scoped inline caller — absent it (unit tests of the
  // findings-digest path), the check degrades to findings-only with no extra calls.
  // The call is STAGE-SCOPED (not plain callInlineLLM) so the summary runs on the
  // same provider the stage is pinned to — never leaking manuscript text to the
  // active/cloud provider when the check's stage targets a private/local one.
  const summarizeChunk = crossChunkSetup && typeof ctx.callStageScopedInlineLLM === 'function'
    ? async (priorSummary, manuscript) => {
        const prompt = buildSetupDigestPrompt({ focus: setupFocus, priorSummary, manuscript });
        const { content } = await ctx.callStageScopedInlineLLM(stage, prompt, { source: EDITORIAL_SETUP_DIGEST_SOURCE });
        return typeof content === 'string' ? content : '';
      }
    : null;
  return runChunkedManuscriptCheck(ctx, {
    chunks,
    category,
    max,
    crossChunkDigest,
    summarizeChunk,
    callChunk: async (manuscript, meta) => {
      const { content } = await ctx.callStagedLLM(stage, buildVars(manuscript, meta), { returnsJson: true, source: stage });
      return content;
    },
  });
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
  return runChunkedManuscriptCheck(ctx, {
    chunks,
    category,
    max,
    // Custom checks are localized to the authored instruction — no cross-chunk
    // digest (the built-in continuity/style checks opt in explicitly).
    callChunk: async (manuscript) => {
      const prompt = buildCustomCheckPrompt({ instructions, manuscript, maxFindings: max });
      const { content } = await ctx.callInlineLLM(prompt, { returnsJson: true, source: CUSTOM_CHECK_RUN_SOURCE });
      return content;
    },
  });
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
function characterNameTokens(c) {
  const tokens = [];
  const push = (v) => { const t = typeof v === 'string' ? v.trim() : ''; if (t) tokens.push(t); };
  push(c?.name);
  for (const a of (Array.isArray(c?.aliases) ? c.aliases : [])) push(a);
  return [...new Set(tokens)];
}

// A case-insensitive, whole-token matcher for a character's tokens (built once
// per character and reused across every section so a long manuscript isn't
// re-compiling a regex per section), or null when there are no tokens.
function characterMatcher(tokens) {
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
function buildRosterAppearances(ctx) {
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

// ---------------------------------------------------------------------------
// Scene component balance (#1296) — reads the cached reverse-outline (#1286)
// scene segmentation, where each scene carries a `components` boolean signal
// { narrative, action, dialogue }. The editorial rule: a scene should mix at
// least 2 of the 3; a single-mode scene (a narration wall, talking heads with
// no action, pure action with no interiority or voice) reads flat and is flagged.
//
// A scene with NO component flagged (all three false) is treated as
// "unclassified" (an older outline, or a scene the segmenter didn't tag), not
// "zero components" — it is skipped rather than flagged as a false positive,
// per the absent-vs-empty rule.
// ---------------------------------------------------------------------------

const SCENE_COMPONENT_KEYS = ['narrative', 'action', 'dialogue'];

// The present/missing component lists for a scene's `components` signal.
function sceneComponentMix(components) {
  const c = components && typeof components === 'object' ? components : {};
  const present = SCENE_COMPONENT_KEYS.filter((k) => c[k] === true);
  const missing = SCENE_COMPONENT_KEYS.filter((k) => c[k] !== true);
  return { present, missing };
}

// A scene's display label for finding text/location — its heading, falling back
// to the summary, then a sequence-based label. Type-guarded because the reverse
// outline rides peer sync (#1348): a hand-edited / older-peer scene could carry a
// non-string heading, and a bare `.trim()` on it would throw and abort the check.
const sceneLabel = (s) => {
  const heading = typeof s?.heading === 'string' ? s.heading.trim() : '';
  const summary = typeof s?.summary === 'string' ? s.summary.trim() : '';
  const seq = typeof s?.sequence === 'number' ? s.sequence + 1 : '?';
  return heading || summary || `scene ${seq}`;
};

// ---------------------------------------------------------------------------
// Registry entries.
// ---------------------------------------------------------------------------

export const EDITORIAL_CHECKS = [
  {
    id: 'naming.dissimilar-names',
    sources: ['canon'],
    label: 'Character name dissimilarity',
    description:
      'Flags character names a reader could confuse — sharing a first letter, length, vowel pattern, opening, ending, near-identical spelling (edit distance) or phonetic key — plus first-letter crowding across the cast. Reads aliases and respects locked characters.',
    scope: 'series',
    kind: 'deterministic',
    category: 'naming',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // How many similarity signals two names must share before they're flagged
      // (near-identical spelling and a phonetic match also flag on their own).
      minSharedSignals: z.number().int().min(1).max(7).default(2),
      // Flag name pairs within this Levenshtein edit distance regardless of the
      // shared-signal count. 0 disables the edit-distance signal entirely.
      minEditDistance: z.number().int().min(0).max(3).default(1),
      // Toggle the individual signals that tend to be noisy on large casts.
      flagSameLength: z.boolean().default(true),
      vowelSkeletonCollision: z.boolean().default(true),
      usePhonetic: z.boolean().default(true),
      // Flag first-letter crowding when a single starting letter is shared by at
      // least 3 names AND at least this fraction of the cast (0 disables).
      maxShareFirstLetterRatio: z.number().min(0).max(1).default(0.4),
    }),
    configFields: [
      {
        key: 'minSharedSignals',
        label: 'Minimum shared signals to flag',
        type: 'number',
        min: 1,
        max: 7,
        step: 1,
        help: 'How many similarity signals (first letter, length, vowel pattern, opening, ending, near-identical spelling, phonetic key) two names must share before they are flagged.',
      },
      {
        key: 'minEditDistance',
        label: 'Flag within edit distance',
        type: 'number',
        min: 0,
        max: 3,
        step: 1,
        help: 'Always flag name pairs within this many single-character edits (e.g. Alina / Alana = 1). 0 turns the edit-distance signal off.',
      },
      {
        key: 'flagSameLength',
        label: 'Treat equal length as a signal',
        type: 'boolean',
        help: 'Count two names of the same length as one similarity signal (noisy on large casts — turn off to ignore).',
      },
      {
        key: 'vowelSkeletonCollision',
        label: 'Treat shared vowel pattern as a signal',
        type: 'boolean',
        help: 'Count names with the same ordered vowels (Blake / Jane → a-e) as one similarity signal.',
      },
      {
        key: 'usePhonetic',
        label: 'Treat phonetic match as a signal',
        type: 'boolean',
        help: 'Count names that sound alike (same Soundex key, e.g. Smith / Smyth) as a similarity signal.',
      },
      {
        key: 'maxShareFirstLetterRatio',
        label: 'First-letter crowding ratio',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        help: 'Flag a starting letter shared by ≥3 names when they make up at least this fraction of the cast. 0 disables the crowding check.',
      },
    ],
    run: (ctx) => {
      const cfg = ctx.config || {};
      const min = cfg.minSharedSignals ?? 2;
      const signalOpts = {
        minEditDistance: cfg.minEditDistance ?? 1,
        flagSameLength: cfg.flagSameLength !== false,
        vowelSkeletonCollision: cfg.vowelSkeletonCollision !== false,
        usePhonetic: cfg.usePhonetic !== false,
      };
      const tokens = castNameTokens(ctx);
      const findings = [];

      // Pairwise confusability over name + alias tokens (skip same-owner pairs).
      for (let i = 0; i < tokens.length; i += 1) {
        for (let j = i + 1; j < tokens.length; j += 1) {
          const a = tokens[i];
          const b = tokens[j];
          if (a.owner === b.owner) continue;
          // Exact normalized collision — two DIFFERENT characters whose names
          // (or an alias) reduce to the same letters once case/punctuation are
          // stripped ("Anne-Marie" / "Anne Marie", or an alias matching another's
          // name). This is the strongest confusion case, so flag it at top severity
          // regardless of the shared-signal threshold (analyzeNamePair treats equal
          // forms as inert, so it's handled here where owner identity is known).
          const na = normalizeName(a.token);
          if (na && na === normalizeName(b.token)) {
            findings.push({
              severity: escalateSeverity(ctx.severityDefault, 2),
              category: 'naming',
              location: `Characters: ${a.ownerName} / ${b.ownerName}`,
              problem: `Character names "${tokenLabel(a)}" and "${tokenLabel(b)}" are identical once case and punctuation are ignored — readers cannot tell them apart.`,
              suggestion: renameSuggestion(a, b),
              anchorQuote: a.token,
              issueNumber: null,
            });
            continue;
          }
          // Single pass yields the signals AND the severity metrics (edit distance,
          // phonetic match) so neither is recomputed below.
          const { signals, distance, phoneticMatch } = analyzeNamePair(a.token, b.token, signalOpts);
          // A near-typo (within the enabled edit-distance threshold) ALWAYS flags —
          // the minEditDistance knob is documented as "Always flag", so it bypasses
          // the shared-signal gate. Otherwise the user-controlled shared-signal
          // count is the gate (phonetic match is a counted signal, not a bypass —
          // Soundex is coarse, so always-flagging it would be noisy).
          const withinEdit = signalOpts.minEditDistance > 0 && distance <= signalOpts.minEditDistance;
          if (!withinEdit && signals.length < min) continue;
          // Severity scales with how confusable the pair really is, above the
          // check's low floor: a near-identical pair (edit distance ≤1, edit-distance
          // enabled) escalates 2; a wider near-typo, a phonetic match, or 4+ signals
          // is strong (escalate 1).
          const nearIdentical = signalOpts.minEditDistance > 0 && distance <= 1;
          const steps = nearIdentical ? 2 : (withinEdit || phoneticMatch || signals.length >= 4 ? 1 : 0);
          findings.push({
            severity: escalateSeverity(ctx.severityDefault, steps),
            category: 'naming',
            location: `Characters: ${a.ownerName} / ${b.ownerName}`,
            problem: `Character names "${tokenLabel(a)}" and "${tokenLabel(b)}" are easy to confuse (${signals.join(', ')}).`,
            suggestion: renameSuggestion(a, b),
            anchorQuote: a.token,
            issueNumber: null,
          });
        }
      }

      // First-letter crowding across the cast — severity scaled by how much of the
      // cast clusters on one starting letter (#1291's "2 of 30 is fine, 4 of 6 is not").
      const ratio = cfg.maxShareFirstLetterRatio ?? 0.4;
      if (ratio > 0) {
        const primaries = tokens.filter((t) => !t.isAlias);
        const clusters = findFirstLetterClusters(primaries.map((t) => t.token), { minCount: 3, maxRatio: ratio });
        for (const cluster of clusters) {
          // Derive the unlocked members from the tokens (not a name-keyed map) so
          // two distinct characters sharing an identical name both count.
          const unlocked = primaries
            .filter((t) => !t.locked && normalizeName(t.token)[0] === cluster.letter)
            .map((t) => t.token);
          const renameHint = unlocked.length
            ? `Consider renaming some of the unlocked ones (${unlocked.join(', ')}) so the cast doesn't blur together.`
            : 'All of these are locked — unlock one to rename it so the cast doesn\'t blur together.';
          findings.push({
            severity: escalateSeverity(ctx.severityDefault, cluster.ratio >= 0.5 ? 2 : 1),
            category: 'naming',
            location: `Characters starting with "${cluster.letter.toUpperCase()}"`,
            problem: `${cluster.names.length} of ${primaries.length} character names start with "${cluster.letter.toUpperCase()}" (${cluster.names.join(', ')}) — readers can confuse names that all open the same way.`,
            suggestion: renameHint,
            anchorQuote: cluster.names[0],
            issueNumber: null,
          });
        }
      }

      return findings;
    },
  },
  {
    id: 'roster.economy',
    sources: ['manuscript', 'canon'],
    label: 'Character roster economy / throwaway names',
    description:
      'Flags named characters who appear in only one issue (a named body the reader is told to remember but who never recurs), too many named characters crowded into the opening issue, and overall roster size relative to the drafted length. Reads canon names + aliases against the stitched manuscript.',
    scope: 'series',
    kind: 'deterministic',
    category: 'casting',
    severityDefault: 'low',
    defaultEnabled: true,
    // Reads the stitched manuscript (per-issue sections) to build the appearance
    // map — so the runner only pays the section-collection I/O when enabled.
    needsManuscript: true,
    configSchema: z.object({
      // A named character appearing in fewer than this many issues is flagged as
      // a non-recurring throwaway. 1 disables the throwaway check (never warn).
      minAppearancesToWarn: z.number().int().min(1).max(10).default(2),
      // Flag the opening issue when more than this many distinct named characters
      // appear in it. 0 disables the first-issue-crowding check.
      maxFirstIssueCharacters: z.number().int().min(0).max(30).default(5),
      // Advisory roster-pressure threshold: flag when the appearing named cast
      // exceeds this many characters per drafted issue. 0 disables it.
      maxCastPerIssue: z.number().min(0).max(50).default(6),
    }),
    configFields: [
      {
        key: 'minAppearancesToWarn',
        label: 'Warn below this many appearances',
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        help: 'Flag a named character who appears in fewer than this many issues (1 = never warn; 2 = flag one-issue-only names). Characters who never appear at all are left alone — they may simply be undrafted.',
      },
      {
        key: 'maxFirstIssueCharacters',
        label: 'Max named characters in opening issue',
        type: 'number',
        min: 0,
        max: 30,
        step: 1,
        help: 'Flag when more than this many distinct named characters appear in the first issue — too many introductions at once dilutes the ones that matter. 0 disables the check.',
      },
      {
        key: 'maxCastPerIssue',
        label: 'Roster-pressure ratio (cast per issue)',
        type: 'number',
        min: 0,
        max: 50,
        step: 0.5,
        help: 'Advisory: flag when the appearing named cast exceeds this many characters per drafted issue. 0 disables the pressure check.',
      },
    ],
    // Need both prose to scan AND at least one named canon character to scan for.
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0
      && Array.isArray(ctx.canon?.characters)
      && ctx.canon.characters.some((c) => typeof c?.name === 'string' && c.name.trim()),
    run: (ctx) => {
      const cfg = ctx.config || {};
      const minAppear = cfg.minAppearancesToWarn ?? 2;
      const maxFirst = cfg.maxFirstIssueCharacters ?? 5;
      const castPerIssue = cfg.maxCastPerIssue ?? 6;
      const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
      const sectionCount = sections.length;
      const rows = buildRosterAppearances(ctx);
      const findings = [];
      // All roster findings share category 'casting' and the same shape — collapse
      // the per-block boilerplate (mirrors arc.ticking-clock-hygiene's `flag`).
      const flag = ({ severity, location, problem, suggestion, anchorQuote = '', issueNumber = null }) =>
        findings.push({ severity, category: 'casting', location, problem, suggestion, anchorQuote, issueNumber });
      // A long story makes a one-issue-only named character read as noise more
      // clearly than a one-shot in a 2-issue story — escalate above the low floor.
      const lengthBump = sectionCount >= 8 ? 1 : 0;

      // 1) Throwaway / non-recurring named characters: appears at least once but
      //    in fewer than minAppearancesToWarn issues. Zero-appearance canon
      //    characters are left alone (possibly undrafted — a different concern).
      if (minAppear > 1) {
        for (const r of rows) {
          const n = r.appearedInIssues.length;
          if (n === 0 || n >= minAppear) continue;
          const issuesList = r.appearedInIssues.join(', ');
          // "never recurs" is only true for a one-issue character; with a higher
          // minAppearancesToWarn, a 2+-issue character DOES recur (just under the
          // threshold), so word that case factually.
          const problem = n === 1
            ? `"${r.name}" is a named character who appears in only 1 issue (${issuesList}) — a named body readers are told to remember but who never recurs.`
            : `"${r.name}" is a named character who appears in only ${n} issues (${issuesList}) — fewer than your ${minAppear}-issue recurrence threshold, so they barely register as part of the cast.`;
          flag({
            severity: escalateSeverity(ctx.severityDefault, lengthBump),
            location: r.firstIssueNumber != null ? `Issue ${r.firstIssueNumber}: ${r.name}` : `Character: ${r.name}`,
            problem,
            suggestion: `Cut "${r.name}", merge them into another character, or leave them unnamed (a description) unless they are meant to recur.`,
            anchorQuote: r.anchorQuote,
            issueNumber: r.firstIssueNumber,
          });
        }
      }

      // 2) First-issue crowding: too many distinct named characters introduced in
      //    the opening issue dilutes the ones that matter.
      if (sectionCount > 0 && maxFirst > 0) {
        const firstNumber = sections[0].number;
        const inFirst = rows.filter((r) => r.appearedInIssues.includes(firstNumber));
        if (inFirst.length > maxFirst) {
          // Low by default; escalate to medium only when crowding is well over the
          // threshold (≥1.5×) — it's a pacing nudge, not a correctness error.
          const heavy = inFirst.length >= Math.ceil(maxFirst * 1.5);
          flag({
            severity: escalateSeverity(ctx.severityDefault, heavy ? 1 : 0),
            location: `Issue ${firstNumber} (opening)`,
            problem: `${inFirst.length} named characters appear in the opening issue (${inFirst.map((r) => r.name).join(', ')}) — more than ${maxFirst}. Too many introductions at once makes it hard for readers to tell who matters.`,
            suggestion: 'Introduce fewer named characters up front — delay, merge, or leave some unnamed until readers have anchored to the leads.',
            // Anchor on a real matched token from the opening issue (these rows all
            // first appear there), not the canonical name which may be an alias-only mention.
            anchorQuote: inFirst[0].anchorQuote,
            issueNumber: firstNumber,
          });
        }
      }

      // 3) Roster size pressure (advisory): the cast that ACTUALLY appears vs the
      //    drafted length — tied to prose appearances so canon bloat alone (named
      //    characters who never show up) doesn't trip it.
      if (castPerIssue > 0 && sectionCount > 0) {
        const appearingCast = rows.filter((r) => r.appearedInIssues.length > 0).length;
        if (appearingCast > castPerIssue * sectionCount) {
          flag({
            severity: ctx.severityDefault,
            location: 'Series roster',
            problem: `The drafted story has ${appearingCast} named characters across ${sectionCount} issue${sectionCount === 1 ? '' : 's'} (about ${(appearingCast / sectionCount).toFixed(1)} per issue) — a large roster relative to its length can overwhelm readers.`,
            suggestion: 'Consider consolidating minor named characters or spreading their introductions across more of the story.',
          });
        }
      }

      return findings;
    },
  },
  {
    id: 'scene.component-balance',
    sources: ['reverseOutline'],
    label: 'Scene component balance (narrative / action / dialogue)',
    description:
      'Flags scenes that lean on a single mode — a wall of narration, talking heads with no action, or pure action with no interiority or voice. Reads the reverse-outline scene segmentation; a balanced scene mixes at least two of narrative, action, and dialogue.',
    scope: 'scene',
    kind: 'deterministic',
    category: 'pacing',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // Minimum distinct components (narrative/action/dialogue) a scene should
      // carry. Default 2 (the "at least 2 of 3" rule); 3 demands all three; 1
      // disables the check (every scene with any signal trivially passes).
      minComponents: z.number().int().min(1).max(3).default(2),
    }),
    configFields: [
      {
        key: 'minComponents',
        label: 'Minimum scene components',
        type: 'number',
        min: 1,
        max: 3,
        step: 1,
        help: 'How many of narrative / action / dialogue a scene should mix. 2 flags single-mode scenes (a narration wall, talking heads, pure action); 3 demands all three; 1 disables the check.',
      },
    ],
    // Needs a generated reverse outline with at least one scene to read.
    gate: (ctx) => Array.isArray(ctx.reverseOutline) && ctx.reverseOutline.length > 0,
    run: (ctx) => {
      const minComponents = ctx.config?.minComponents ?? 2;
      if (minComponents <= 1) return []; // disabled — every classified scene passes
      const scenes = Array.isArray(ctx.reverseOutline) ? ctx.reverseOutline : [];
      const findings = [];
      for (const s of scenes) {
        if (!s || typeof s !== 'object') continue;
        const { present, missing } = sceneComponentMix(s.components);
        // Skip unclassified scenes (no component signal at all) — absent ≠ "zero
        // components"; flagging them would be a false positive on older outlines.
        if (present.length === 0 || present.length >= minComponents) continue;
        const label = sceneLabel(s);
        const issueNumber = Number.isInteger(s.issueNumber) ? s.issueNumber : null;
        // How many more modes reach the configured target, and whether ALL the
        // missing ones are required to get there — so the guidance honors
        // minComponents=3 (a single-mode scene must add BOTH missing modes, not one).
        const needed = minComponents - present.length;
        const addJoiner = needed >= missing.length ? ' and ' : ' or ';
        const problem = present.length === 1
          ? `Scene "${label}" is all ${present[0]} — no ${missing.join(' or ')}. A single-mode scene reads flat; aim for at least ${minComponents} of narrative, action, and dialogue.`
          : `Scene "${label}" has ${present.join(' and ')} but no ${missing.join(' or ')} — only ${present.length} of the ${minComponents} components you expect.`;
        findings.push({
          severity: ctx.severityDefault,
          category: 'pacing',
          location: issueNumber != null ? `Issue ${issueNumber}: ${label}` : `Scene: ${label}`,
          problem,
          suggestion: `Add ${missing.join(addJoiner)} so the scene isn't a ${present.join('/')}-only beat (e.g. ground talking heads in the room, give a narration wall a beat of action, or let an action scene breathe with a line of dialogue or interiority).`,
          anchorQuote: typeof s.anchorQuote === 'string' ? s.anchorQuote : '',
          issueNumber,
        });
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
        // An object's motivation can be set up in an earlier chapter and paid off
        // later; without the digest a later chunk may flag a "missing setup" an
        // earlier chunk already accounted for (#1383).
        crossChunkDigest: true,
        // …and a CLEANLY established motivation produces no finding, so the findings
        // digest alone can't carry it forward — roll a setup summary of the objects
        // and their established significance so a later payoff isn't mis-flagged (#1403).
        crossChunkSetup: true,
        setupFocus: 'Objects/items characters interact with, and any motivation, emotional significance, '
          + 'or backstory the prose or canon has established for that object (so a later payoff is recognized as motivated).',
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
    id: 'interiority.protagonist',
    sources: ['manuscript'],
    label: 'Protagonist interiority (mind / objective / emotion / decision)',
    description:
      'Flags POV scenes that move a viewpoint character through events without developing their interiority — their thoughts and feelings, what they want and why, their emotional response to twists, and the reasoning behind their decisions. Infers POV from the prose when it is not explicitly tagged.',
    scope: 'issue',
    kind: 'llm',
    category: 'character',
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
    // Per-scene, localized findings (one interiority gap = one scene), so this
    // stays a plain per-chunk run with no cross-chunk digest — mirrors
    // prose.info-dumping.
    run: (ctx) => runManuscriptLlmCheck(ctx, {
      stage: INTERIORITY_STAGE,
      category: 'character',
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
        // Tense/POV drift is inherently cross-chapter — a per-chunk view can't see
        // that chapter 1 established past-tense when judging chapter 3 (#1383).
        crossChunkDigest: true,
        // A chunk with no tense/POV finding leaves a later chunk blind to what
        // chapter 1 established — the findings digest carries problems, not the clean
        // baseline. Roll a setup summary of the tense/POV/rating in force forward (#1403).
        crossChunkSetup: true,
        setupFocus: 'The narrative tense (past/present), the point-of-view person (first/third/etc.), '
          + 'and the content rating / profanity / violence level in force.',
      });
    },
  },
  {
    id: 'chekhov.setups-payoffs',
    sources: ['manuscript', 'series.arc.readerMap'],
    label: "Chekhov's guns (setups & payoffs)",
    description:
      'Flags planted elements that never pay off (a weapon, clue, secret, stated fear, promise, or threat introduced and then dropped) and payoffs that arrive with no setup (a skill, antidote, or revelation that appears unearned). Reconciles its detected setups/payoffs against the authored reader-map hooks/payoffs.',
    scope: 'series',
    kind: 'llm',
    category: 'continuity',
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
    run: (ctx) => {
      // Authored hooks/payoffs are fixed per-call overhead (re-sent on each chunk).
      const authoredSetups = authoredSetupPayoffSummary(ctx.series?.arc?.readerMap);
      return runManuscriptLlmCheck(ctx, {
        stage: CHEKHOV_STAGE,
        category: 'continuity',
        overheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS + estimateTokens(authoredSetups),
        // `finalPart` gates the whole-corpus "planted, never fired" judgment to the
        // last part of a chunked manuscript (#1299) — an earlier part can't know a
        // setup pays off later, so it would false-flag. A single-chunk run is its own
        // final part. "fired, never planted" stays enabled on every part (the carried
        // setup digest tells a later part what was already planted).
        buildVars: (manuscript, meta) => ({ manuscript, authoredSetups, finalPart: meta?.isFinal ? 'true' : '' }),
        // A setup planted in chapter 2 and paid off (or NOT) in chapter 9 spans
        // chunks — the cross-chunk digest keeps prior findings in view so a later
        // chunk doesn't re-flag, and the clean-setup digest rolls forward which
        // elements have been planted-but-not-yet-paid so a payoff isn't mis-flagged
        // "no setup" and a never-fired plant is caught at the end.
        crossChunkDigest: true,
        crossChunkSetup: true,
        setupFocus: 'Planted elements that a later scene should pay off — weapons/objects/clues, '
          + 'secrets, stated fears, promises/vows, threats, and notable skills — and, for each, '
          + 'whether it has already been paid off (fired, spilled, confronted, kept) or is still open.',
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
