/**
 * Shared LLM-check execution helpers (#2842 split of checkInfra.js): manuscript
 * chunk planning, the cross-chunk prior-findings and setup digests, the staged
 * and inline (user-defined) manuscript runners, and raw-finding normalization.
 */

import { estimateTokens } from './externals.js';
import { SEVERITIES, CUSTOM_CHECK_MAX_FINDINGS_DEFAULT } from './taxonomy.js';

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
//
// `reserveSetupDigest` (#1667) GUARANTEES the carried setup digest reaches the
// FINAL chunk for checks that gate a whole-story verdict to it and anchor that
// verdict on the carried snippet (arc.climax-agency #1583, emotion.reaction-
// proportionality #1584). The setup digest normally yields to manuscript coverage,
// so a final chunk packed to within a few hundred chars of the window silently
// drops the digest and the final-only finding is missed. When this opt-in is set
// and the digest doesn't fit the final chunk's spare room, the manuscript TAIL is
// trimmed to reserve the digest's room (the inverse of the usual yield) so the
// verdict keeps its carried context. Scoped to the final chunk and to opt-in checks
// only — every other chunk, and every non-reserving check, keeps full manuscript
// coverage. If the digest alone is larger than the whole window it still yields
// (never prepended past the budget), preserving the no-overflow contract.
async function runChunkedManuscriptCheck(ctx, { chunks, category, max, callChunk, crossChunkDigest = false, summarizeChunk = null, reserveSetupDigest = false, subtypes = null }) {
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
    // `isFinal` lets a check distinguish the last part of a chunked manuscript
    // from earlier ones (#1299): a whole-corpus judgment like "this setup is
    // never paid off" can only be made once the final part is in view, so the
    // Chekhov check defers its "planted, never fired" findings to it. A
    // single-chunk run is its own final part, so the common (provider-fits-the-
    // book) case judges against the whole text. Existing checks ignore the arg.
    const isFinal = i === chunks.length - 1;
    let text = manuscript;
    if (crossChunkDigest && merged.size) {
      const digest = editorialPriorFindingsDigest([...merged.values()]);
      // Only prepend when the digest fits the chunk's spare room — never trim the
      // manuscript (would drop review coverage) or overflow the window.
      if (digest && digest.length <= usableChars - text.length) text = `${digest}${manuscript}`;
    }
    if (summarizeChunk && setupSummary) {
      const setup = editorialSetupDigest(setupSummary);
      if (setup && setup.length <= usableChars - text.length) {
        // Fits into whatever spare room remains AFTER the findings digest — manuscript
        // coverage and the findings digest both win over the setup digest if budget is tight.
        text = `${setup}${text}`;
      } else if (setup && reserveSetupDigest && isFinal && setup.length <= usableChars) {
        // #1667: the digest didn't fit, but this check gates its verdict to the final
        // part and anchors it on the carried snippet — so reserve the digest's room and
        // fill the rest with the manuscript HEAD (trimming its tail) rather than drop
        // the carried context. Rebuild from the RAW `manuscript`, NOT the
        // findings-digest-prefixed `text`: slicing `text` could truncate the findings
        // digest mid-block into a malformed prefix, and the findings digest's job
        // (suppressing duplicate re-flags) is already covered by the first-wins merge,
        // so it safely yields here. Gated on `setup.length <= usableChars` so a digest
        // larger than the whole window yields instead of overflowing it — preserving
        // the pre-reserve no-overflow contract on a tiny/high-overhead window.
        text = `${setup}${manuscript.slice(0, usableChars - setup.length)}`;
      }
    }
    const content = await callChunk(text, { isFinal });
    for (const f of mapLlmFindings(content?.findings, {
      severityDefault: ctx.severityDefault,
      category,
      max,
      withIssueNumber: true,
      subtypes,
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
// A check declares its per-chunk non-manuscript overhead in ONE of two ways:
//
//   `context` (preferred) — a `{ varName: string }` map of the TRIMMABLE context
//     blocks the check re-sends on each chunk (the scene map, character arcs, the
//     style-guide expectations, …). The runner counts them as overhead AND, on a
//     small/fallback window where they'd starve the manuscript chunk to '', trims
//     them to guarantee the manuscript a budget floor (#1459). `buildVars` then
//     receives the (possibly trimmed) blocks as its third arg — so the check feeds
//     the SAME context it was budgeted for (sending the untrimmed originals would
//     overflow the window the trim was sized to fit). `EDITORIAL_PROMPT_OVERHEAD_TOKENS`
//     is added automatically as the fixed (non-trimmable) template/contract reserve.
//
//   `overheadTokens` (legacy) — a single fixed token count for a check with no
//     trimmable context (a plain whole-manuscript scan). MUST account for every
//     non-manuscript prompt var, on top of EDITORIAL_PROMPT_OVERHEAD_TOKENS.
//
// `buildVars(chunk, meta, context)` returns the stage vars — only the manuscript
// var changes per chunk; `meta.isFinal` is true on the last (or only) chunk so a
// check can gate whole-corpus judgments to it (the Chekhov "planted, never fired"
// pass), and `context` is the trimmed block map (or `{}` for an `overheadTokens`
// check). Existing checks ignore the extra args. These checks are all
// manuscript-scoped, so findings keep a model-supplied issue number
// (`withIssueNumber: true`).
export async function runManuscriptLlmCheck(ctx, { stage, category, overheadTokens = 0, context = null, buildVars, crossChunkDigest = false, crossChunkSetup = false, setupFocus = '', reserveSetupDigest = false, subtypes = null }) {
  const max = ctx.config?.maxFindings ?? 12;
  // Chunks are planned at the full usable budget; the digest is fitted into each
  // later chunk's spare room inside runChunkedManuscriptCheck (it yields to the
  // manuscript), so no budget is reserved or carved out here. A `context` map is
  // trimmed to keep the manuscript a budget floor; the trimmed blocks come back on
  // `chunks.context` so they're what we feed the model.
  const chunks = context
    ? await ctx.planManuscriptChunks(stage, { context, fixedOverheadTokens: EDITORIAL_PROMPT_OVERHEAD_TOKENS })
    : await ctx.planManuscriptChunks(stage, { overheadTokens });
  // The runner returns the (possibly trimmed) context on `chunks.context`; fall back
  // to the originals if it didn't echo them (a chunker that doesn't implement the
  // context path), and to `{}` for an `overheadTokens` check with no context.
  const fittedContext = chunks?.context || context || {};
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
    reserveSetupDigest,
    subtypes,
    callChunk: async (manuscript, meta) => {
      const { content } = await ctx.callStagedLLM(stage, buildVars(manuscript, meta, fittedContext), { returnsJson: true, source: stage });
      return content;
    },
  });
}

// Normalize raw LLM findings into partial manuscriptReview comments: validate
// severity against the allow-list (fall back to the check default), force the
// check's `category`, coerce each string field, cap the count, and drop any
// finding with no `problem`. `withIssueNumber` keeps a model-supplied issue
// number (manuscript-scoped checks) vs. forcing null (canon-scoped checks).
// `subtypes` (optional) is a per-check allow-list (#1626): when supplied, the
// model's `subtype` is validated against it and stamped on the finding (off-list
// or absent → null), letting a check sub-classify its findings (e.g. on-the-nose
// → exposition / emotion-tell / relationship-report) without a new field on every
// other check.
export function mapLlmFindings(raw, { severityDefault, category, max, withIssueNumber, subtypes = null }) {
  const list = Array.isArray(raw) ? raw : [];
  const allowSubtype = Array.isArray(subtypes) && subtypes.length > 0;
  return list.slice(0, max).map((f) => ({
    severity: SEVERITIES.includes(f?.severity) ? f.severity : severityDefault,
    category,
    // Optional per-check sub-classification. Only set when the check declares an
    // allow-list AND the model returned a recognized value — null otherwise so a
    // check with no subtypes (and an unrecognized label) carries a clean null.
    subtype: allowSubtype && subtypes.includes(f?.subtype) ? f.subtype : null,
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
export async function runManuscriptLlmCheckInline(ctx, { category, instructions }) {
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

