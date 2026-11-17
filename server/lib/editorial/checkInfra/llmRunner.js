/**
 * Shared LLM-check execution helpers: manuscript chunk planning, the cross-chunk
 * prior-findings and setup digests, the staged and inline (user-defined) manuscript
 * runners, and raw-finding normalization.
 */

import { estimateTokens, CREATIVE_LATITUDE_TOKENS } from './externals.js';
import { SEVERITIES, CUSTOM_CHECK_MAX_FINDINGS_DEFAULT } from './taxonomy.js';

// Every `kind: 'llm'` check normalizes raw findings here; manuscript-consuming checks
// also feed the corpus in provider-sized chunks and merge per-chunk findings.

// Fixed per-call prompt overhead (template scaffolding + JSON-shape instructions)
// reserved on top of any check-specific static vars.
export const EDITORIAL_PROMPT_OVERHEAD_TOKENS = 1_500;

// First-wins dedup key for merging findings across chunks (mirrors
// completenessPass.findingKey).
export const editorialFindingKey = (f) => [
  f.issueNumber ?? '',
  f.category ?? '',
  (f.anchorQuote || '').trim().toLowerCase().slice(0, 120),
  (f.problem || '').trim().toLowerCase().slice(0, 120),
].join('|');

// Cross-chunk continuity digest: a check whose problems span chapters can't see them
// in a per-chunk view, so a bounded digest of prior-chunk findings rides in later
// chunks' spare budget.
export const EDITORIAL_PRIOR_DIGEST_MAX = 40;
// Only the findings BODY is capped; the header and trailing `---` delimiter are added
// AFTER the cap (the next manuscript chunk follows directly, so the delimiter MUST
// survive or the manuscript bleeds into the findings list).
export const EDITORIAL_PRIOR_DIGEST_BODY_CHARS = 2_000;
const EDITORIAL_PRIOR_DIGEST_HEADER = '# Editorial findings already recorded for EARLIER parts of this manuscript\n'
  + 'Do not repeat these. Flag only NEW problems in the text below, plus any cross-chapter '
  + 'continuity these earlier findings reveal (e.g. an object set up earlier, or a tense/POV '
  + 'choice established in an earlier chapter).\n\n';
const EDITORIAL_PRIOR_DIGEST_SEPARATOR = '\n\n---\n\n';
// Whole-digest ceiling = wrapper + capped body; the digest is prepended only when it
// fits the chunk's spare budget (see runChunkedManuscriptCheck).
export const EDITORIAL_PRIOR_DIGEST_CHARS =
  EDITORIAL_PRIOR_DIGEST_HEADER.length + EDITORIAL_PRIOR_DIGEST_BODY_CHARS + EDITORIAL_PRIOR_DIGEST_SEPARATOR.length;

// One-block digest of findings recorded for earlier chunks, prepended INSIDE the next
// chunk's manuscript var so no prompt template changes. Returns '' when there are none.
// It carries prior FINDINGS only, not clean setup (see the setup digest below).
export function editorialPriorFindingsDigest(findings) {
  if (!Array.isArray(findings) || !findings.length) return '';
  const lines = findings.slice(0, EDITORIAL_PRIOR_DIGEST_MAX).map((f) => {
    const where = Number.isInteger(f.issueNumber) ? `Issue ${f.issueNumber}` : (f.location || 'general');
    return `- [${where}] ${f.category}: ${f.problem}`;
  });
  const more = findings.length > EDITORIAL_PRIOR_DIGEST_MAX
    ? `\n(+${findings.length - EDITORIAL_PRIOR_DIGEST_MAX} more earlier findings)` : '';
  // Cap the body only so the header and `---` separator always survive.
  const body = `${lines.join('\n')}${more}`.slice(0, EDITORIAL_PRIOR_DIGEST_BODY_CHARS);
  return `${EDITORIAL_PRIOR_DIGEST_HEADER}${body}${EDITORIAL_PRIOR_DIGEST_SEPARATOR}`;
}

// Cross-chunk CLEAN-SETUP digest: clean setup produces no finding, so a later payoff
// could be mis-flagged "missing setup". A rolling summary of established setup is
// built by one extra summarization LLM call per chunk (`crossChunkSetup` path).
//
// Free-form run tag so /runs can filter the setup-summary calls apart.
export const EDITORIAL_SETUP_DIGEST_SOURCE = 'pipeline-editorial-setup-digest';
// Body cap for the rolling setup summary; header and trailing `---` are appended
// AFTER the cap so the delimiter survives truncation.
export const EDITORIAL_SETUP_DIGEST_BODY_CHARS = 1_500;
const EDITORIAL_SETUP_DIGEST_HEADER =
  '# Setup already established in EARLIER parts of this manuscript (clean context — these are NOT problems)\n'
  + 'Use this when judging the text below: do NOT flag a payoff as missing setup, or a tense/POV/rating as a '
  + 'drift, if it was already established here.\n\n';
const EDITORIAL_SETUP_DIGEST_SEPARATOR = '\n\n---\n\n';
// Whole-digest ceiling; prepended only when it fits the chunk's spare budget.
export const EDITORIAL_SETUP_DIGEST_CHARS =
  EDITORIAL_SETUP_DIGEST_HEADER.length + EDITORIAL_SETUP_DIGEST_BODY_CHARS + EDITORIAL_SETUP_DIGEST_SEPARATOR.length;

// Wrap the accumulated setup summary in the header + trailing `---` so it rides INSIDE
// the next chunk's manuscript var. Returns '' for an empty/non-string summary.
export function editorialSetupDigest(summary) {
  if (typeof summary !== 'string' || !summary.trim()) return '';
  const body = summary.trim().slice(0, EDITORIAL_SETUP_DIGEST_BODY_CHARS);
  return `${EDITORIAL_SETUP_DIGEST_HEADER}${body}${EDITORIAL_SETUP_DIGEST_SEPARATOR}`;
}

// Inline summarization prompt that maintains the rolling setup summary; `focus` is the
// per-check tracking target. Asks for terse merged text only (no JSON), since the
// result rides verbatim into the next chunk's digest.
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

// Shared chunk loop for manuscript-consuming LLM checks: run `callChunk` on each
// provider-sized chunk, normalizing and merging findings first-wins (capped at `max`
// overall). Digests ride INSIDE the chunk text, so prompt templates are unchanged.
//
// Digests YIELD to manuscript coverage: one is prepended only when it fits the chunk's
// spare budget (`usableChars - chunk length`), so it never grows a chunk past the
// provider window. No reported budget (single-call provider, test stub) = unbounded.
//
// `crossChunkDigest` prefixes later chunks with the findings so far. `summarizeChunk`
// `(priorSummary, chunkText) => nextSummary` opts in the CLEAN-SETUP digest, prepended
// after the findings digest; it is a no-op for a single-chunk run.
//
// `reserveSetupDigest` GUARANTEES the setup digest reaches the FINAL chunk for checks
// that gate a whole-story verdict to it and anchor on the carried snippet: when it
// doesn't fit, the manuscript TAIL is trimmed to make room (the inverse of the usual
// yield). Scoped to the final chunk of opt-in checks; a digest larger than the whole
// window still yields, preserving the no-overflow contract.
async function runChunkedManuscriptCheck(ctx, { chunks, category, max, callChunk, crossChunkDigest = false, summarizeChunk = null, reserveSetupDigest = false, subtypes = null }) {
  const usableChars = Number.isFinite(chunks?.usableChars) ? chunks.usableChars : Infinity;
  const merged = new Map();
  // `summarizeChunk` is set only when the check opts in AND an inline caller exists, so
  // it is itself the gate for the setup digest.
  let setupSummary = '';
  for (let i = 0; i < chunks.length; i++) {
    const manuscript = chunks[i];
    // Stop launching chunk calls once cancelled; the runner only checks the signal
    // around the whole check.
    if (ctx.signal?.aborted) break;
    // `isFinal`: whole-corpus judgments (e.g. Chekhov "planted, never fired") can only
    // be made on the final part; a single-chunk run is its own final part.
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
        // Fits the spare room left AFTER the findings digest; manuscript and findings win.
        text = `${setup}${text}`;
      } else if (setup && reserveSetupDigest && isFinal && setup.length <= usableChars) {
        // Digest didn't fit but this check gates its verdict to the final part: reserve
        // the digest's room and trim the manuscript tail. Rebuild from the RAW
        // `manuscript`, not `text`, which could truncate the findings digest mid-block
        // (its dedup job is covered by the first-wins merge). `setup.length <=
        // usableChars` keeps an oversized digest from overflowing the window.
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
    // Roll the setup summary forward for the NEXT chunk (skip after the last chunk and on
    // cancellation). Summarize the RAW chunk; a summarizer failure keeps the prior summary.
    if (summarizeChunk && i < chunks.length - 1 && !ctx.signal?.aborted) {
      const next = await summarizeChunk(setupSummary, manuscript).catch(() => setupSummary);
      // Cap the STORED summary: it feeds back into the next summarization prompt, so an
      // uncapped echoing response would compound past the provider context.
      if (typeof next === 'string' && next.trim()) {
        setupSummary = next.trim().slice(0, EDITORIAL_SETUP_DIGEST_BODY_CHARS);
      }
    }
  }
  return [...merged.values()].slice(0, Math.max(0, max));
}

// Shared body for a manuscript-consuming LLM check: plans provider-sized chunks for
// `stage` (via `ctx.planManuscriptChunks`), runs the model on each, merges findings
// first-wins (capped at `maxFindings`). Findings keep a model-supplied issue number.
// `buildVars(chunk, meta, context)` returns the stage vars; only the manuscript var
// changes per chunk, `meta.isFinal` marks the last (or only) chunk, and `context` is
// the trimmed block map (`{}` for an `overheadTokens` check).
//
// Per-chunk non-manuscript overhead is declared one of two ways:
//   `context` (preferred): a `{ varName: string }` map of TRIMMABLE blocks re-sent on
//     each chunk. The runner counts them as overhead and, on a small window where they
//     would starve the manuscript, trims them to keep a manuscript budget floor.
//     `buildVars` must send these trimmed blocks, not the originals, or the window
//     overflows. `EDITORIAL_PROMPT_OVERHEAD_TOKENS` is added as the fixed reserve.
//   `overheadTokens` (legacy): one fixed count for a check with no trimmable context;
//     MUST cover every non-manuscript prompt var on top of the fixed reserve.
// `promptOverheadTokens` may raise the fixed reserve for an unusually detailed template.
export async function runManuscriptLlmCheck(ctx, { stage, category, overheadTokens = 0, promptOverheadTokens = EDITORIAL_PROMPT_OVERHEAD_TOKENS, context = null, buildVars, crossChunkDigest = false, crossChunkSetup = false, setupFocus = '', reserveSetupDigest = false, subtypes = null }) {
  const max = ctx.config?.maxFindings ?? 12;
  // Chunks are planned at the full budget; digests fit into later chunks' spare room
  // inside runChunkedManuscriptCheck. A `context` map is trimmed to keep the manuscript
  // a budget floor and comes back on `chunks.context`.
  const chunks = context
    ? await ctx.planManuscriptChunks(stage, { context, fixedOverheadTokens: promptOverheadTokens })
    : await ctx.planManuscriptChunks(stage, { overheadTokens });
  // Fall back to the originals if the chunker doesn't echo context, and `{}` when none.
  const fittedContext = chunks?.context || context || {};
  // Clean-setup digest: only wired when the check opts in AND the runner injected the
  // inline caller. The call is STAGE-SCOPED so the summary runs on the provider the
  // stage is pinned to, never leaking manuscript text to a cloud provider when the
  // stage targets a private/local one.
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

// Normalize raw LLM findings into partial manuscriptReview comments: validate severity
// (fall back to the check default), force `category`, coerce string fields, cap the
// count, drop findings with no `problem`. `withIssueNumber` keeps the model's issue
// number (manuscript-scoped) vs null (canon-scoped). `subtypes` is an optional
// per-check allow-list; an off-list or absent `subtype` becomes null.
export function mapLlmFindings(raw, { severityDefault, category, max, withIssueNumber, subtypes = null }) {
  const list = Array.isArray(raw) ? raw : [];
  const allowSubtype = Array.isArray(subtypes) && subtypes.length > 0;
  return list.slice(0, max).map((f) => ({
    severity: SEVERITIES.includes(f?.severity) ? f.severity : severityDefault,
    category,
    // Set only when the check declares an allow-list AND the model returned a member.
    subtype: allowSubtype && subtypes.includes(f?.subtype) ? f.subtype : null,
    location: typeof f?.location === 'string' ? f.location : '',
    problem: typeof f?.problem === 'string' ? f.problem : '',
    suggestion: typeof f?.suggestion === 'string' ? f.suggestion : '',
    anchorQuote: typeof f?.anchorQuote === 'string' ? f.anchorQuote : '',
    issueNumber: withIssueNumber && Number.isInteger(f?.issueNumber) ? f.issueNumber : null,
  })).filter((f) => f.problem);
}

// ---------------------------------------------------------------------------
// User-defined (custom) LLM checks. The fixed JSON output contract is enforced HERE so
// an author only describes WHAT to look for; responses go through `mapLlmFindings`.
// The model caller and chunk planner are injected by the runner.
// ---------------------------------------------------------------------------

// Run tag persisted so /runs can filter custom-check calls from named-stage checks.
export const CUSTOM_CHECK_RUN_SOURCE = 'pipeline-editorial-custom';

// Wrap authored instructions in the fixed findings JSON contract. Pure so it can be
// rendered with an empty manuscript to measure per-call overhead.
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

// Inline-prompt sibling of `runManuscriptLlmCheck` for custom checks. A custom check has
// no stage to pin, so `planManuscriptChunks(null, …)` uses the active provider's window.
export async function runManuscriptLlmCheckInline(ctx, { category, instructions }) {
  const max = ctx.config?.maxFindings ?? CUSTOM_CHECK_MAX_FINDINGS_DEFAULT;
  // Per-call overhead = contract wrapper + instructions, measured by rendering with an
  // empty manuscript. The IP-latitude clause is prepended downstream AFTER this
  // measurement, so reserve it here or every chunk ships uncounted tokens.
  const overheadTokens = EDITORIAL_PROMPT_OVERHEAD_TOKENS
    + CREATIVE_LATITUDE_TOKENS
    + estimateTokens(buildCustomCheckPrompt({ instructions, manuscript: '', maxFindings: max }));
  const chunks = await ctx.planManuscriptChunks(null, { overheadTokens });
  return runChunkedManuscriptCheck(ctx, {
    chunks,
    category,
    max,
    // No cross-chunk digest: custom checks are localized to the authored instruction.
    callChunk: async (manuscript) => {
      const prompt = buildCustomCheckPrompt({ instructions, manuscript, maxFindings: max });
      const { content } = await ctx.callInlineLLM(prompt, { returnsJson: true, source: CUSTOM_CHECK_RUN_SOURCE });
      return content;
    },
  });
}
