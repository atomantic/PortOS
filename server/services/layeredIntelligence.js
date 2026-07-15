/**
 * Layered Intelligence Loop — deterministic backbone.
 *
 * A perpetual, per-managed-app self-improvement loop (Engine B autonomous script
 * job). On a schedule the handler reads each enabled app's goals + telemetry,
 * asks a reasoning model (default: local LLM) for the single most-valuable
 * improvement, and this module's DETERMINISTIC helpers file that as a tracker
 * issue (GitHub / GitLab / Jira / PLAN.md) for a coding agent to pick up later.
 *
 * The reasoning model never touches code — it returns structured JSON only; every
 * side effect (dedup, scope-gating, pause, filing) is deterministic handler code
 * so the "model must not make direct code changes" contract holds by construction.
 *
 * The pure helpers (config defaults, scope-gating, slug/dedup, pause resolution,
 * reasoner-output validation, prompt building, filer dispatch) are side-effect-free
 * and unit-tested. The I/O functions (gather, forge/jira/plan filers) take injectable
 * deps so tests can drive them without a live LLM, `gh`, or filesystem.
 *
 * See docs/plans/2026-07-07-layered-intelligence-loop.md for the full design.
 */

import { spawn } from 'child_process';
import { join, resolve, relative, isAbsolute } from 'path';
import { readFile, writeFile, appendFile, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { DAY, tryReadFile, readJSONFile, safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { bufferedSpawn } from '../lib/bufferedSpawn.js';
import { fetchPublicText } from '../lib/safeUrlFetch.js';
import { validateCommand } from '../lib/commandSecurity.js';
import { getSettings } from './settings.js';
import { createTicket, searchIssues, addLabels, escapeJql } from './jira.js';
import { computeWindowedStats } from './taskLearning/store.js';

// Tracker labels + slug marker. The slug is the stable dedup key the reasoner
// chooses; it is embedded in each filed issue body so a later run (or the
// reasoner reading open issues) can self-avoid duplicates.
export const LI_LABEL = 'layered-intelligence';
export const LI_BLOCKING_LABEL = 'layered-intelligence:blocking';

// Jira labels can't contain spaces, and a ':' is unsafe on some Jira versions,
// so the Jira pause label swaps the ':' for a '-'. The base LI_LABEL is already
// Jira-safe (kebab, no colon) and is reused verbatim across all trackers.
export const LI_JIRA_BLOCKING_LABEL = 'layered-intelligence-blocking';

// Closed issues carrying a matching slug suppress a re-proposal for this long,
// so the loop doesn't immediately re-file something the user just resolved.
export const CLOSED_SUPPRESSION_MS = 30 * DAY;

// Cosine-similarity floor for the semantic (embedding) near-duplicate guard that
// layers atop the exact slug/label dedup. A proposal whose embedding is at least
// this close to an existing dedup-window issue is treated as the same work worded
// differently and suppressed. Deliberately conservative — only near-identical
// intent should trip it (768-dim local embeddings put genuine near-dups ≳0.9).
export const SEMANTIC_DEDUP_THRESHOLD = 0.9;

// Cap the number of existing issues embedded per run so a repo with a large LI
// backlog can't fan out into an unbounded embedding sweep. Open dedup-window
// issues should be few (the loop files ≤1/run), so this is a generous ceiling.
export const SEMANTIC_DEDUP_MAX_CANDIDATES = 50;

// The id of the RETIRED global autonomous-job that used to drive the whole loop
// (the cross-app sweep). Layered Intelligence is now a per-app handler-backed
// scheduled task (#2322), so this constant is kept ONLY so migration 184 can find
// and tombstone the legacy `data/cos/autonomous-jobs.json` record on installs that
// still carry it. Nothing dispatches on it anymore.
export const LI_JOB_ID = 'job-layered-intelligence';

// Every proposal scope the reasoner may return. The handler enforces WHERE each
// lands (see PROPOSAL_SCOPE_TARGETS) and gates meta/self scopes to PortOS only.
export const PROPOSAL_SCOPES = ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self'];

// Scopes that may only be filed when the sweeping app IS the PortOS install
// itself (they extend / improve the loop, which lives in the PortOS repo).
export const PORTOS_ONLY_SCOPES = ['loop-meta', 'portos-self'];

// The reasoner's honest effort/risk estimate for a proposal. Only a `trivial`
// proposal is ever eligible for the optional Engine-A hand-off (below); anything
// unrecognized normalizes to null (unknown → not trivial → never auto-handed-off).
export const PROPOSAL_COMPLEXITIES = ['trivial', 'moderate', 'complex'];

// The single complexity level that (with `safe: true` and hand-off enabled)
// lets the loop enqueue a coding agent instead of only filing the issue.
export const HANDOFF_COMPLEXITY = 'trivial';

// The resolved outcomes a filed proposal can reach (the feedback loop, #2428).
// A record with a null outcome is still open/unresolved. All three are
// auto-derived from the tracker's closed state by deriveOutcome: completed →
// merged, not_planned → rejected, and any other PRESENT close reason
// (duplicate/stale/etc.) → abandoned (#2620); a reason-less close falls back
// to merged for trackers that report no stateReason.
export const PROPOSAL_OUTCOMES = ['merged', 'rejected', 'abandoned'];

/**
 * The default per-app config. PortOS (isPortos) additionally gets the meta/self
 * scopes so the loop can extend itself; every other app is capped at its own
 * improvement + data-gap scopes. Off by default — the loop is a user-enabled
 * scheduled automation (AI-provider "no cold-bootstrap" policy).
 */
export function defaultLayeredIntelligenceConfig(isPortos = false) {
  return {
    enabled: false,
    intervalMs: DAY,
    providerId: null,
    model: null,
    sources: {
      goals: true,
      // The app's OWN performance metrics (a METRICS.md doc in the app repo): the
      // user-success / KPI / production-telemetry signals the app tracks about
      // itself. This is the PRIMARY signal for evaluating a managed app against
      // its own goals and purpose, so it's on by default for every app. See the
      // METRICS.md convention in docs/METRICS.md.
      appMetrics: true,
      // The autonomous coding-agent run stats this install records (learning.json).
      // For the PortOS install these ARE its own-performance metrics; for a MANAGED
      // app they describe how reliably PortOS's agents change the app (a tooling /
      // interaction signal), NOT the app's own product performance — so default it
      // on only for PortOS. A managed app measures itself through appMetrics/custom
      // sources instead; the user can still opt this on per-app.
      cosMetrics: isPortos,
      healthReport: true,
      planMd: true,
      openIssues: true,
      // The self-feedback signal (#2428): past LI proposals + their tracker
      // outcomes, fed back so the reasoner calibrates on its own merge rate.
      // Default ON for the PortOS install (it improves itself), OFF for managed
      // apps — the user opts in per-app via the LI config UI.
      outcomes: isPortos,
      custom: []
    },
    rules: '',
    allowedScopes: isPortos
      ? ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self']
      : ['app-improvement', 'app-data-gap'],
    // Engine-A hand-off. When enabled, a proposal the reasoner marks trivial+safe
    // is ALSO enqueued as a CoS coding-agent task (approval-gated) instead of only
    // being filed for later human triage. Off by default — letting an agent write
    // code from the loop unattended is an extra opt-in on top of enabling the loop.
    handoff: { enabled: false }
  };
}

/**
 * Merge an app record's stored `layeredIntelligence` over the defaults so a
 * partial config (or none) still yields a complete, safe config. `sources` is
 * merged one level deep so a stored `{ sources: { goals: false } }` doesn't wipe
 * the other source toggles.
 */
export function getEffectiveConfig(app) {
  const isPortos = !!app?.isPortos;
  const base = defaultLayeredIntelligenceConfig(isPortos);
  const stored = (app?.layeredIntelligence && typeof app.layeredIntelligence === 'object' && !Array.isArray(app.layeredIntelligence))
    ? app.layeredIntelligence
    : {};
  const merged = { ...base, ...stored };
  merged.sources = {
    ...base.sources,
    ...(stored.sources && typeof stored.sources === 'object' ? stored.sources : {})
  };
  // Merge handoff one level deep (like sources) so a partial `{ handoff: {} }`
  // doesn't wipe the default `enabled`.
  merged.handoff = {
    ...base.handoff,
    ...(stored.handoff && typeof stored.handoff === 'object' && !Array.isArray(stored.handoff) ? stored.handoff : {})
  };
  if (!Array.isArray(merged.sources.custom)) merged.sources.custom = [];
  if (!Array.isArray(merged.allowedScopes)) merged.allowedScopes = base.allowedScopes;
  return merged;
}

/**
 * Whether a proposal scope is allowed for this app. A hallucinated or
 * hand-edited scope cannot escape this gate: it must be a recognized scope, be
 * in the app's `allowedScopes`, and — for meta/self scopes — the app must BE the
 * PortOS install. Double-enforced regardless of what the prompt told the model.
 */
export function isScopeAllowed({ scope, allowedScopes = [], isPortos = false }) {
  if (!PROPOSAL_SCOPES.includes(scope)) return false;
  if (PORTOS_ONLY_SCOPES.includes(scope) && !isPortos) return false;
  return allowedScopes.includes(scope);
}

/** The HTML-comment slug marker embedded in a filed issue/ticket body. */
export function slugMarker(slug) {
  return `<!-- lil-slug: ${slug} -->`;
}

/** Extract a `lil-slug` marker's value from a body string (null if absent). */
export function extractSlugFromBody(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(/<!--\s*lil-slug:\s*([a-z0-9][a-z0-9-]*)\s*-->/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Normalize a reasoner-chosen slug to a stable kebab id. Returns null for a
 * non-string or an input that reduces to empty (so a bad slug is a no-op, never
 * a mystery label).
 */
export function normalizeSlug(slug) {
  if (typeof slug !== 'string') return null;
  const norm = slug
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return norm || null;
}

/**
 * Whether an existing tracker issue is still within the dedup suppression window:
 * OPEN, or CLOSED within CLOSED_SUPPRESSION_MS. Only a closed-long-ago issue
 * falls out of the window so its work can be re-proposed. A closed issue with a
 * missing/unparseable `closedAt` is PERMANENTLY in-window (suppressed): the main
 * producer of that shape is a checked `- [x]` PLAN.md item (checkboxes carry no
 * timestamp), and a completed plan item never needs re-proposal — treating it as
 * "closed long ago" made the reasoner re-propose every done item on every run
 * (#2620). A tracker row missing its close time (e.g. a jira Done ticket with no
 * resolutiondate) is likewise suppressed rather than re-proposed — done work is
 * never worth re-reasoning. Shared by both the slug dedup and the semantic dedup
 * so the two guards agree on which issues still count.
 */
export function isIssueWithinDedupWindow(issue, now = Date.now()) {
  if ((issue?.state || '').toLowerCase() === 'open') return true;
  const closedAt = issue?.closedAt ? Date.parse(issue.closedAt) : NaN;
  if (!Number.isFinite(closedAt)) return true;
  return now - closedAt <= CLOSED_SUPPRESSION_MS;
}

/**
 * Deterministic dedup guard. Given the slug of the proposed item and the live
 * tracker's existing issues (each `{ slug, state, closedAt }`), suppress the
 * proposal when a match is open, OR closed within CLOSED_SUPPRESSION_MS.
 *
 * `slug` matching is case-insensitive on the normalized slug. `existingIssues`
 * may carry either a parsed `slug` or a raw `body`/`title` we extract from.
 */
export function isProposalDuplicate({ slug, existingIssues = [], now = Date.now() }) {
  const target = normalizeSlug(slug);
  if (!target) return false;
  for (const issue of existingIssues) {
    const issueSlug = issue.slug
      ? normalizeSlug(issue.slug)
      : extractSlugFromBody(issue.body) || extractSlugFromBody(issue.title);
    if (issueSlug !== target) continue;
    if (isIssueWithinDedupWindow(issue, now)) return true;
  }
  return false;
}

/**
 * Build the text to embed for a proposal OR an existing issue — title + body,
 * trimmed and length-capped so a single huge body can't blow the embedding
 * model's context. Both sides go through THIS helper so the proposal and the
 * candidates are embedded from the same seed shape (a fair comparison).
 */
export function issueEmbedSeed({ title = '', body = '' } = {}) {
  const parts = [title, body].map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  return parts.join('\n\n').slice(0, 2000);
}

/** Cosine similarity of two equal-length numeric vectors. Returns 0 for a shape
 * mismatch, empty vector, or a zero-magnitude vector (nothing meaningful to
 * compare) rather than NaN, so a bad embedding can never trip the dedup guard. */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Pure near-duplicate finder. Given the proposal's embedding and an array of
 * candidates (each `{ slug?, number?, title?, embedding }`), return the single
 * best candidate whose cosine similarity meets `threshold` (highest score wins),
 * or null when none qualify / the proposal embedding is unusable. Side-effect-free
 * and unit-tested; the I/O layer feeds it real embeddings.
 */
export function findSemanticDuplicate({ proposalEmbedding, candidates = [], threshold = SEMANTIC_DEDUP_THRESHOLD } = {}) {
  if (!Array.isArray(proposalEmbedding) || proposalEmbedding.length === 0) return null;
  let best = null;
  for (const c of candidates) {
    if (!Array.isArray(c?.embedding) || c.embedding.length === 0) continue;
    const score = cosineSimilarity(proposalEmbedding, c.embedding);
    if (score >= threshold && (!best || score > best.score)) {
      best = { slug: c.slug || null, number: c.number ?? null, title: c.title || '', score };
    }
  }
  return best;
}

/**
 * Whether the app is currently PARKED — i.e. has at least one OPEN blocking
 * issue. When parked, the sweep skips the app entirely (no gather, no reason),
 * resuming automatically once the blocking issue closes. Fully tracker-derived.
 */
export function isAppParked(blockingIssues = []) {
  return blockingIssues.some(i => (i.state || '').toLowerCase() === 'open');
}

/**
 * Validate + normalize the reasoner's JSON. Returns
 * `{ analysis, proposal, pause }` with invalid pieces dropped (never throws):
 *   - `proposal` kept only when it has a recognized scope + a normalizable slug
 *     + a non-empty title. `slug` is normalized in place.
 *   - `pause` kept only when it has a reason AND a resolvable target: an integer
 *     issue number, or `"this"` WITH a surviving proposal to block on. A
 *     `pause.blockOnIssue: "this"` with a null proposal is invalid → dropped.
 */
export function validateReasonerResponse(parsed) {
  const out = { analysis: '', proposal: null, pause: null };
  if (!parsed || typeof parsed !== 'object') return out;
  if (typeof parsed.analysis === 'string') out.analysis = parsed.analysis;

  const p = parsed.proposal;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const slug = normalizeSlug(p.slug);
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (PROPOSAL_SCOPES.includes(p.scope) && slug && title) {
      out.proposal = {
        scope: p.scope,
        slug,
        title,
        body: typeof p.body === 'string' ? p.body : '',
        value: typeof p.value === 'string' ? p.value : '',
        // Hand-off signals. `complexity` normalizes to a known level or null
        // (unknown → never trivial → never auto-handed-off); `safe` is a strict
        // boolean so only an explicit `true` opens the hand-off path.
        complexity: PROPOSAL_COMPLEXITIES.includes(p.complexity) ? p.complexity : null,
        safe: p.safe === true
      };
    }
  }

  const pause = parsed.pause;
  if (pause && typeof pause === 'object' && !Array.isArray(pause)) {
    const reason = typeof pause.reason === 'string' ? pause.reason.trim() : '';
    const target = pause.blockOnIssue;
    const isThis = target === 'this';
    const num = Number.isInteger(target) ? target : (typeof target === 'string' && /^\d+$/.test(target) ? Number(target) : null);
    // "this" requires a surviving proposal to block on; else an explicit issue number.
    if (reason && ((isThis && out.proposal) || num)) {
      out.pause = { blockOnIssue: isThis ? 'this' : num, reason };
    }
  }
  return out;
}

/**
 * Resolve `pause.blockOnIssue` to a concrete issue number. `"this"` maps to the
 * number of the issue just filed from the proposal; an integer passes through.
 * Returns null when it can't resolve (e.g. `"this"` but nothing was filed).
 */
export function resolveBlockOnIssue(pause, filedIssueNumber) {
  if (!pause) return null;
  if (pause.blockOnIssue === 'this') return filedIssueNumber ?? null;
  return Number.isInteger(pause.blockOnIssue) ? pause.blockOnIssue : null;
}

/**
 * Whether a filed proposal qualifies for the optional Engine-A hand-off — i.e.
 * the loop should enqueue a coding agent to implement it now, not just file it.
 * Requires ALL of: hand-off enabled in the app's config, an issue actually filed
 * (a concrete `filed` ref for the agent to work), and the reasoner marking the
 * proposal both trivial AND safe. Any missing/false signal falls through to
 * file-only. Pure — the handler feeds it the filed ref.
 */
export function isHandoffEligible({ proposal, config, filed } = {}) {
  if (filed == null || filed === '' || filed === false) return false;
  if (!config?.handoff?.enabled) return false;
  if (!proposal || typeof proposal !== 'object') return false;
  return proposal.complexity === HANDOFF_COMPLEXITY && proposal.safe === true;
}

/**
 * Build the CoS task payload that hands a filed proposal to an Engine-A coding
 * agent. Deterministic (no I/O) so it's unit-tested; the handler passes the
 * result to `addTask(..., 'internal')`. The task is APPROVAL-GATED — an agent
 * writing code straight from the loop shouldn't run unattended (mirrors
 * autoFixer's every code-editing task). The description leads with a stable
 * `LI hand-off:` prefix so addTask's per-app dedup suppresses a re-enqueue while
 * the same proposal's task is still pending/in-flight.
 */
export function buildHandoffTask({ app, proposal, issueRef } = {}) {
  const ref = typeof issueRef === 'number' ? `#${issueRef}` : String(issueRef ?? '').trim();
  const context = [
    '# Layered Intelligence hand-off',
    '',
    `The Layered Intelligence loop identified a TRIVIAL, SAFE improvement for **${app?.name || app?.id || 'this app'}** and filed it as ${ref}.`,
    '',
    '## Task',
    `Implement the change described in ${ref} end-to-end: read the issue, make the fix, run the app's tests, and open a PR that closes ${ref}.`,
    'If — once you dig in — the change turns out to be non-trivial or carries any regression/data-loss risk, STOP and leave a comment on the issue explaining why instead of forcing it. Filing was the safe fallback; a half-done risky change is worse than none.',
    '',
    '## Proposal',
    `- **Title:** ${proposal?.title || ''}`,
    `- **Value:** ${proposal?.value || '(not provided)'}`,
    '',
    proposal?.body || ''
  ].join('\n');
  return {
    description: `LI hand-off: ${proposal?.title || ref}`,
    priority: 'MEDIUM',
    context,
    app: app?.id,
    approvalRequired: true
  };
}

/**
 * Which filing path a resolved work tracker uses. Branches the handler up front
 * so a `plan` app never hits the forge-only label/issue paths.
 *   github / gitlab → 'forge'   (gh / glab issue create + labels)
 *   jira            → 'jira'     (createTicket + description slug marker)
 *   plan (fallback) → 'plan'     (append slug-tagged PLAN.md checklist item)
 */
export function filerForTracker(resolved) {
  if (resolved === 'github' || resolved === 'gitlab') return 'forge';
  if (resolved === 'jira') return 'jira';
  return 'plan';
}

/** Whether a resolved tracker supports pause (an issue to block on). `plan` doesn't. */
export function trackerSupportsPause(resolved) {
  return filerForTracker(resolved) !== 'plan';
}

/**
 * Derive a resolved outcome for a filed proposal from its live tracker issue.
 * Pure — the reconciler feeds it a `{ state, stateReason, closedAt }` issue:
 *   - still open (or unknown state)     → null   (unresolved)
 *   - closed as "completed"             → 'merged'
 *   - closed as "not planned"           → 'rejected'
 *   - closed with any OTHER reason       → 'abandoned' (duplicate/stale/etc. —
 *                                          counting these as merged inflated the
 *                                          merge-rate calibration signal, #2620)
 *   - closed with NO reason              → 'merged' (graceful fallback: glab/jira
 *                                          and the plan filer report no stateReason,
 *                                          and their common close path IS a merge —
 *                                          absent ≠ other, per the sentinel rule)
 * GitHub reports `stateReason` ('completed' | 'not_planned' | 'reopened' | …);
 * other trackers omit it, so a bare closed issue reads as merged.
 */
export function deriveOutcome(issue) {
  if ((issue?.state || '').toLowerCase() !== 'closed') return null;
  const reason = (issue?.stateReason || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (reason === 'not_planned') return 'rejected';
  if (reason === '' || reason === 'completed') return 'merged';
  return 'abandoned';
}

/**
 * Format the LI outcome-feedback report (#2428) from this app's recorded
 * proposals + their reconciled outcomes. Pure + side-effect-free: the LI hook
 * loads the outcomes and passes them here, then feeds the string into buildPrompt.
 * Returns '' when there's nothing to report (no filed history) so the caller omits
 * the block entirely rather than injecting an empty section.
 */
export function computeOutcomesReport({ outcomes = [] } = {}) {
  const filed = (Array.isArray(outcomes) ? outcomes : []).filter(o => o && typeof o === 'object');
  if (filed.length === 0) return '';
  const total = filed.length;
  const pct = (n) => Math.round((n / total) * 100);
  const count = (name) => filed.filter(o => o.outcome === name).length;
  const merged = count('merged');
  const rejected = count('rejected');
  const abandoned = count('abandoned');
  const pending = total - merged - rejected - abandoned;

  // Per-scope merge rate — the calibration signal the reasoner acts on.
  const scopes = new Map();
  for (const o of filed) {
    const s = o.scope || 'unknown';
    const agg = scopes.get(s) || { filed: 0, merged: 0 };
    agg.filed += 1;
    if (o.outcome === 'merged') agg.merged += 1;
    scopes.set(s, agg);
  }
  const scopeLines = [...scopes.entries()]
    .sort((a, b) => b[1].filed - a[1].filed)
    .map(([s, v]) => `- ${s}: ${v.filed} filed, ${v.merged} merged (${v.filed ? Math.round((v.merged / v.filed) * 100) : 0}%)`)
    .join('\n');

  const reasons = [...new Set(filed
    .filter(o => o.outcome === 'rejected' && o.outcomeReason)
    .map(o => o.outcomeReason))].slice(0, 5);

  return [
    'Recent LI proposals (all still-open, plus outcomes resolved within ~30 days):',
    `- Total filed: ${total}`,
    `- Merged/implemented: ${merged} (${pct(merged)}%)`,
    `- Rejected: ${rejected} (${pct(rejected)}%)`,
    `- Abandoned: ${abandoned} (${pct(abandoned)}%)`,
    `- Still open: ${pending} (${pct(pending)}%)`,
    '',
    'By scope:',
    scopeLines || '- (none)',
    '',
    `Common rejection reasons: ${reasons.length ? reasons.join('; ') : 'none'}`
  ].join('\n');
}

/**
 * Build the JSON-only reasoning prompt for one app. Deterministic: given the
 * gathered sources, open issues, and config, produces the exact string sent to
 * the model. Meta/self scopes are only offered when the app is PortOS.
 * `outcomesReport` (from computeOutcomesReport) is injected as a `liOutcomes`
 * block with calibration guidance when non-empty (#2428).
 */
export function buildPrompt({ app, config, sources = {}, openIssues = [], isPortos = false, outcomesReport = '' }) {
  const allowed = (config.allowedScopes || []).filter(s =>
    isScopeAllowed({ scope: s, allowedScopes: config.allowedScopes, isPortos })
  );
  const scopeLines = allowed.map(s => `  - ${s}`).join('\n');
  const sourceBlocks = Object.entries(sources)
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `### ${k}\n${v.trim()}`)
    .join('\n\n');
  const openList = openIssues.length
    ? openIssues.map(i => `- #${i.number ?? '?'} [${i.slug || extractSlugFromBody(i.body) || 'no-slug'}] ${i.title || ''}`).join('\n')
    : '(none)';

  // Nudge a managed app with no own-performance signal (no METRICS.md gathered)
  // toward adding one, so future runs can judge real performance. PortOS is exempt
  // — it measures itself through cosMetrics. Also gate on the source being ENABLED:
  // if the user deliberately turned appMetrics off, a METRICS.md may well exist, so
  // "add a METRICS.md" would be a misleading (and possibly redundant) proposal.
  const hasAppMetrics = Boolean(typeof sources.appMetrics === 'string' && sources.appMetrics.trim());
  const appMetricsEnabled = config.sources?.appMetrics !== false;
  const metricsGuidance = (!isPortos && appMetricsEnabled && !hasAppMetrics)
    ? '\nThis app exposes no own-performance metrics yet (no METRICS.md). If you lack the data to judge how it is doing against its goals, a high-value app-data-gap proposal is to add a METRICS.md documenting how the app measures success — its user-success/KPI signals and where its production telemetry or data lives — so future runs can reason about real performance.\n'
    : '';

  const handoffNote = config.handoff?.enabled
    ? '\nHand-off: a proposal you mark BOTH "complexity":"trivial" AND "safe":true may be handed directly to a coding agent to implement now (not just filed). Only mark a proposal trivial+safe when it is small, self-contained, and carries no regression or data-loss risk — when in doubt, use a higher complexity or "safe":false so a human triages it first.\n'
    : '';

  // Feedback loop (#2428): show the reasoner how its own past proposals fared so
  // it can calibrate scope/merge-rate instead of proposing in a vacuum.
  const outcomesBlock = (typeof outcomesReport === 'string' && outcomesReport.trim())
    ? `\n### liOutcomes\n${outcomesReport.trim()}\n\nUse this data to calibrate your proposal: prefer scopes with higher merge rates, avoid patterns that were repeatedly rejected, and consider that lower-merge scopes may need more justification.\n`
    : '';

  return `You are the Layered Intelligence reasoner for the app "${app.name}". Your job is to evaluate how THIS app is performing against its OWN goals and purpose${isPortos ? '' : ', not how well PortOS\'s tooling manages it'}. Decide the SINGLE highest-value improvement to propose this run (signal, not noise), grounded in the app's own goals and its own performance metrics (user success, KPIs, production telemetry). You never write code; you return structured JSON that a deterministic system files as ONE tracker issue.
${handoffNote}${metricsGuidance}
Rules & guidance from the operator:
${config.rules?.trim() || '(none)'}

Allowed proposal scopes (you MUST pick one of these for any proposal):
${scopeLines || '  (none — return proposal: null)'}
${isPortos ? '' : 'Note: meta/self scopes are unavailable on this app; frame any data need as an "app-data-gap" against this app.\n'}
Already-open tracked issues (DO NOT duplicate these — reuse their slug only if genuinely the same work):
${openList}

Gathered sources:
${sourceBlocks || '(no sources available — you may propose an app-data-gap to add telemetry)'}
${outcomesBlock}
Respond with JSON only (no markdown fences):
{
  "analysis": "brief reasoning summary",
  "proposal": {              // null if nothing worth filing this run
    "scope": "<one allowed scope>",
    "slug": "kebab-stable-id",
    "title": "short imperative title",
    "body": "markdown detail for the coding agent",
    "value": "why this is the single highest-value item now",
    "complexity": "trivial | moderate | complex",   // honest effort/risk estimate
    "safe": false            // true ONLY if a coding agent could implement it end-to-end with no regression/data-loss risk
  },
  "pause": {                 // null if not pausing
    "blockOnIssue": "this" or <existing issue number>,
    "reason": "why the loop should pause on this app until resolved"
  }
}`;
}

// ---------------------------------------------------------------------------
// I/O layer — gather + filers. Injectable deps keep these testable.
// ---------------------------------------------------------------------------

/** Run a CLI, resolving `{ code, stdout, stderr }` (never rejects). */
function runCli(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout: '', stderr: err.message }));
  });
}

/**
 * Gather the enabled Layer-1 sources for one app into a `{ key: string }` map.
 * Deterministic reads only (files + CoS metric JSON); NO LLM calls. Missing
 * files degrade to omitted keys, never throws. `openIssues` is gathered
 * separately by the handler (it shells out to the forge).
 */
export async function gatherSources(app, config, { cosPath = PATHS.cos, trustShellSources } = {}) {
  const out = {};
  const src = config.sources || {};
  const repo = app.repoPath;

  // Resolve the install-level shell-trust opt-in lazily and once — only when a
  // `cmd` source is actually present — so apps with no shell sources never read
  // settings. Injected value (tests) wins; otherwise fall back to settings.json.
  let trustShell = trustShellSources;
  const resolveTrustShell = async () => {
    if (trustShell === undefined) trustShell = await getTrustShellSources();
    return trustShell;
  };

  if (src.goals && repo) {
    const goals = await tryReadFile(join(repo, 'GOALS.md'));
    if (goals) out.goals = goals.slice(0, 8000);
  }
  if (src.appMetrics && repo) {
    // The app's own success/performance metrics doc (the METRICS.md convention,
    // see docs/METRICS.md) — where a managed app records what "performing well"
    // means. Absent → omitted (the reasoner may then propose adding one).
    const metrics = await tryReadFile(join(repo, 'METRICS.md'));
    if (metrics) out.appMetrics = metrics.slice(0, 8000);
  }
  if (src.planMd && repo) {
    const plan = await tryReadFile(join(repo, 'PLAN.md'));
    if (plan) out.planMd = plan.slice(0, 8000);
  }
  if (src.healthReport && repo) {
    const health = await tryReadFile(join(repo, 'HEALTH_REPORT.md'));
    if (health) out.healthReport = health.slice(0, 8000);
  }
  if (src.cosMetrics) {
    // This install's own autonomous-agent run stats (per task type), NOT scoped to
    // the app being analyzed — see the default-config note for the PortOS-vs-managed
    // rationale (default-off for managed apps).
    const learning = await readJSONFile(join(cosPath, 'learning.json'), null);
    if (learning?.byTaskType) {
      // Surface BOTH the lifetime rate (the cumulative dashboard/telemetry truth)
      // AND a recency-windowed rate (issue #2460) per task type, labeled distinctly
      // so the reasoner doesn't conflate them. The windowed rate lets a
      // since-resolved failure burst age out of the "is work needed" signal instead
      // of permanently depressing it; `recentSuccessRate` is null when there are no
      // in-window runs, in which case the reasoner leans on the lifetime rate.
      // Note the intentional rename: computeWindowedStats' internal `windowed*`
      // fields are surfaced to the reasoner as `recent*` (reads more naturally in
      // the prompt context) — same concept, deliberately different label here.
      const summary = {};
      for (const [type, m] of Object.entries(learning.byTaskType)) {
        const windowed = computeWindowedStats(m?.recentOutcomes);
        summary[type] = {
          lifetimeSuccessRate: typeof m?.successRate === 'number' ? m.successRate : null,
          lifetimeCompleted: m?.completed || 0,
          recentSuccessRate: windowed.windowedSuccessRate,
          recentCompleted: windowed.windowedCompleted,
          avgDurationMs: m?.avgDurationMs || 0
        };
      }
      out.cosMetrics = JSON.stringify(summary).slice(0, 4000);
    }
  }
  for (const custom of src.custom || []) {
    const key = customSourceKey(custom);
    if (!key) continue;
    if (custom.type === 'file' && typeof custom.ref === 'string' && repo) {
      const safe = await confineToRepo(repo, custom.ref);
      if (!safe) {
        console.warn(`⚠️ Layered Intelligence: custom source "${custom.ref}" escapes repo — skipped`);
        continue;
      }
      const content = await tryReadFile(safe);
      if (content) out[key] = content.slice(0, 8000);
    } else if (custom.type === 'http' && typeof custom.url === 'string') {
      const content = await fetchHttpSource(custom.url);
      if (content) out[key] = content.slice(0, 8000);
    } else if (custom.type === 'cmd' && typeof custom.cmd === 'string' && repo) {
      const content = await runShellCommand(custom.cmd, { cwd: repo, trustShellSources: await resolveTrustShell() });
      if (content) out[key] = content.slice(0, 8000);
    }
  }
  return out;
}

/**
 * Stable map key for a custom source. Namespaced by type so a `file` ref and an
 * `http` url that share a string can't collide, and so the prompt's source block
 * labels are self-describing. Returns null for a malformed/unknown source.
 */
export function customSourceKey(custom) {
  if (!custom || typeof custom !== 'object') return null;
  if (custom.type === 'file' && custom.ref) return `custom:${custom.ref}`;
  if (custom.type === 'http' && custom.url) return `custom:http:${custom.url}`;
  if (custom.type === 'cmd' && custom.cmd) return `custom:cmd:${custom.cmd}`;
  return null;
}

/**
 * Fetch an http(s) custom source for the loop's prompt. Deterministic read, no
 * LLM. Rejects any non-http(s) scheme (defense in depth over the Zod refine),
 * bounds the request with a 10s timeout, and returns null on any failure so a
 * dead URL just omits the key rather than throwing.
 *
 * SSRF-guarded via `fetchPublicText` (default posture): loopback, link-local,
 * and the cloud-metadata endpoint (127.0.0.1, 169.254.169.254,
 * metadata.google.internal, ::1) are blocked so a hand-edited/hostile config
 * can't exfiltrate them into the reasoner prompt, and redirects are revalidated
 * against the same gate. LAN/private hosts (Tailscale peers, a home wiki) stay
 * ALLOWED intentionally — PortOS is a single-user tool where a custom source
 * legitimately points at the home network, and the URL is operator-configured.
 * `throwOnUnsafe: false` makes a blocked host omit the key like any other dead
 * URL instead of bubbling a 400. `fetchText` is injectable for tests.
 */
export async function fetchHttpSource(url, { timeoutMs = 10_000, fetchText = fetchPublicText } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const text = await fetchText(url, { timeoutMs, throwOnUnsafe: false }).catch(() => null);
  return text || null;
}

/**
 * THREAT MODEL — a `cmd` custom source is attacker-reachable persistent config.
 *
 * The `sources.custom` array lives in each app's stored `layeredIntelligence`
 * config, written through the validated `PUT /api/apps/:id` route. A `cmd` entry
 * is executed here on the Layered Intelligence SCHEDULE (Engine-B autonomous job),
 * with the PortOS process's own privileges and cwd = the app repo. So any path
 * that can land a string in that config (a hand-edited config, a hostile sync
 * payload, a future config-writing feature, an XSS-driven same-origin POST) gets
 * *persistent, unattended* code execution — not a one-shot the operator watched.
 *
 * Historically this ran the full command string with `shell: true`, capped only
 * by length + a 15s timeout. That is arbitrary RCE: `; rm -rf ~`, `$(curl … | sh)`,
 * pipes to `sh`, etc. all execute. Issue #2515.
 *
 * Defense: by default we DENY the shell. The command is parsed and checked
 * against the shared binary allowlist (`validateCommand` in commandSecurity.js —
 * same gate the manual command runner uses), which rejects shell metacharacters
 * (`;|&$(){}` …) and any binary not on the allowlist, then we spawn the base
 * binary with parsed args and `shell: false` — so no shell ever interprets the
 * string. A non-allowlisted / metacharacter command is dropped (key omitted) with
 * a warning, exactly like any other failed source read.
 *
 * Escape hatch: an operator who genuinely needs a pipeline (`git log … | head`)
 * can set the install-level `settings.layeredIntelligence.trustShellSources`
 * flag, which restores the full `shell: true` behavior for THIS install only.
 * It is an explicit, install-wide opt-in — off by default — so a fresh install
 * (or a synced-in app config) can never execute an un-allowlisted command.
 *
 * `exec` is injectable for tests; `trustShellSources` is resolved by the caller
 * (`gatherSources`) from install settings and threaded in.
 *
 * Returns null on rejection / non-zero exit / timeout / no output so a failing or
 * denied command just omits the source key rather than throwing.
 */
export async function runShellCommand(cmd, { cwd, timeoutMs = 15_000, exec = bufferedSpawn, trustShellSources = false } = {}) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (trustShellSources) {
    // Operator has explicitly opted this install into full-shell custom sources.
    const { code, stdout } = await exec(cmd, [], { cwd, timeoutMs, shell: true });
    if (code !== 0) return null;
    return (stdout || '').trim() || null;
  }
  const check = validateCommand(cmd);
  if (!check.valid) {
    console.warn(`⚠️ Layered Intelligence: custom cmd source "${cmd}" rejected — ${check.error} (enable settings.layeredIntelligence.trustShellSources to allow arbitrary shell commands)`);
    return null;
  }
  const { code, stdout } = await exec(check.baseCommand, check.args, { cwd, timeoutMs, shell: false });
  if (code !== 0) return null;
  return (stdout || '').trim() || null;
}

/**
 * Resolve the install-level "trust shell sources" opt-in from settings.json.
 * `null`/absent/non-true all read as OFF (the safe default) — only an explicit
 * `true` unlocks full-shell custom `cmd` sources. Injectable read for tests.
 */
export async function getTrustShellSources(read = getSettings) {
  const settings = await read();
  return settings?.layeredIntelligence?.trustShellSources === true;
}

/**
 * Confine a custom file `ref` to within `repo` so a hostile/hand-edited config
 * can't read arbitrary files into the LLM prompt. Returns the safe absolute path,
 * or null when it escapes. Guards BOTH lexical traversal (`..` / absolute) AND
 * symlink escape — a symlink inside the repo pointing outside is resolved via
 * realpath and rejected. Missing files return null (nothing to read).
 */
export async function confineToRepo(repo, ref) {
  const abs = resolve(repo, ref);
  const rel = relative(repo, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  // Resolve symlinks on both sides; a link inside the repo that points outside
  // is caught here (lexical check above only sees the link's own path).
  const realRepo = await realpath(repo).catch(() => null);
  const realAbs = await realpath(abs).catch(() => null);
  if (!realRepo || !realAbs) return null;
  const realRel = relative(realRepo, realAbs);
  if (realRel.startsWith('..') || isAbsolute(realRel)) return null;
  return realAbs;
}

/** Lazily resolve the default embedder so the pure module doesn't statically pull
 * in the embeddings/settings/provider graph (matches the handler's dynamic-import
 * pattern for heavy deps). Only reached in production — tests inject `embed`. */
async function defaultEmbed(text) {
  const { embedText } = await import('./embeddings.js');
  return embedText(text);
}

/**
 * SEMANTIC dedup guard — the embedding-similarity layer ON TOP OF the exact
 * slug/label dedup (`isProposalDuplicate`). Catches a proposal that describes the
 * same work as an existing issue but was worded differently (so its slug differs).
 * Runs only AFTER slug dedup passes, so it's a best-effort extra catch.
 *
 * Returns `{ available, duplicate, match }`:
 *   - `available:false` when semantic dedup couldn't run (no embeddable candidates,
 *     or the embeddings provider is off / the proposal embed failed). This is a
 *     SENTINEL, distinct from `available:true, duplicate:false` ("checked, no
 *     near-dup"): the handler treats unavailable as "proceed to file" because slug
 *     dedup already guarded the exact case — losing the semantic catch just
 *     restores pre-feature behavior, it never files a slug-duplicate.
 *   - `duplicate:true` with `match` = the highest-scoring near-duplicate issue.
 *
 * No cold-bootstrap risk: `embed` degrades to `{ skipped:true }` when no
 * embeddings provider is configured, and this only runs inside the user-enabled
 * scheduled sweep. `embed` is injectable for tests.
 */
export async function checkSemanticDuplicate({ proposal, existingIssues = [], now = Date.now(), embed = defaultEmbed, threshold = SEMANTIC_DEDUP_THRESHOLD } = {}) {
  const unavailable = { available: false, duplicate: false, match: null };
  if (!proposal || typeof proposal !== 'object') return unavailable;

  // Only issues still within the dedup window with SOMETHING to embed are worth
  // comparing; a plan-tracked slug-only issue (no title/body) can't be embedded.
  const candidates = existingIssues
    .filter(i => isIssueWithinDedupWindow(i, now) && (i.body || i.title))
    .slice(0, SEMANTIC_DEDUP_MAX_CANDIDATES);
  if (candidates.length === 0) return unavailable;

  // A failing embed (transient provider blip, malformed response) must degrade to
  // the available:false sentinel — NOT reject through processApp and mark the
  // whole app run 'error'. Deferring the call into a promise chain then catching
  // absorbs BOTH an async rejection AND a synchronous throw from the (injectable)
  // embedder, mirroring this file's fetchHttpSource / jira-search failure idiom
  // (no non-boundary try/catch).
  const safeEmbed = (text) => Promise.resolve().then(() => embed(text)).catch(() => null);

  const proposalRes = await safeEmbed(issueEmbedSeed({ title: proposal.title, body: proposal.body }));
  if (!proposalRes?.success || !Array.isArray(proposalRes.embedding)) return unavailable;

  const embedded = [];
  for (const c of candidates) {
    const res = await safeEmbed(issueEmbedSeed({ title: c.title, body: c.body }));
    if (res?.success && Array.isArray(res.embedding)) {
      embedded.push({ slug: c.slug || null, number: c.number ?? null, title: c.title || '', embedding: res.embedding });
    }
  }
  if (embedded.length === 0) return unavailable;

  const match = findSemanticDuplicate({ proposalEmbedding: proposalRes.embedding, candidates: embedded, threshold });
  return { available: true, duplicate: !!match, match };
}

/**
 * Normalize a forge issue state to `open` / `closed`. GitLab reports `opened`
 * (and `closed`/`locked`); GitHub reports `open`/`closed`. Anything that isn't a
 * recognized closed/locked state is treated as open so dedup + park don't miss a
 * GitLab-`opened` issue. (`merged` never applies to issues.)
 */
export function normalizeIssueState(state) {
  const s = (state || '').toLowerCase();
  if (s === 'closed' || s === 'locked') return 'closed';
  return 'open';
}

/**
 * List existing layered-intelligence issues on a forge (open + recently closed)
 * so the handler can feed them to the reasoner and run the dedup guard.
 *
 * Returns `{ ok, issues }` — `ok:false` means the tracker read FAILED (CLI error
 * or unparseable output), which is NOT the same as "no existing issues" (`ok:true,
 * issues:[]`). The handler must NOT file when the read failed, or a transient
 * `gh` blip would defeat dedup and file a duplicate (CLAUDE.md sentinel rule).
 */
export async function listForgeIssues({ cli, cwd, env, exec = runCli } = {}) {
  const args = cli === 'glab'
    ? ['issue', 'list', '--label', LI_LABEL, '--all', '-P', '100', '-F', 'json']
    : ['issue', 'list', '--label', LI_LABEL, '--state', 'all', '--limit', '100', '--json', 'number,title,body,state,stateReason,closedAt,url'];
  const { code, stdout } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { ok: false, issues: [] };
  if (!stdout.trim()) return { ok: true, issues: [] };
  const parsed = safeJSONParse(stdout, null, { logError: false });
  if (!Array.isArray(parsed)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: parsed.map(i => ({
      number: i.number ?? i.iid ?? null,
      title: i.title || '',
      body: i.body || i.description || '',
      state: normalizeIssueState(i.state),
      // GitHub-only: 'completed' | 'not_planned' | 'reopened'. glab omits it, so
      // deriveOutcome falls back to treating any closed issue as merged.
      stateReason: i.stateReason || i.state_reason || null,
      closedAt: i.closedAt || i.closed_at || null,
      // gh reports `url`; glab reports `web_url`. Null when neither is present so
      // the overview's proposal links degrade to a plain count rather than a
      // dead href.
      url: i.url || i.web_url || null,
      slug: extractSlugFromBody(i.body || i.description || '') || extractSlugFromBody(i.title || '')
    }))
  };
}

/**
 * List OPEN blocking-labeled issues for the app (park check). Returns
 * `{ ok, issues }` with the same failed-vs-empty distinction as listForgeIssues.
 */
export async function listBlockingIssues({ cli, cwd, env, exec = runCli } = {}) {
  const args = cli === 'glab'
    ? ['issue', 'list', '--label', LI_BLOCKING_LABEL, '-P', '100', '-F', 'json']
    : ['issue', 'list', '--label', LI_BLOCKING_LABEL, '--state', 'open', '--limit', '100', '--json', 'number,title,state'];
  const { code, stdout } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { ok: false, issues: [] };
  if (!stdout.trim()) return { ok: true, issues: [] };
  const parsed = safeJSONParse(stdout, null, { logError: false });
  if (!Array.isArray(parsed)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: parsed.map(i => ({
      number: i.number ?? i.iid ?? null,
      title: i.title || '',
      state: normalizeIssueState(i.state)
    }))
  };
}

/**
 * Ensure the layered-intelligence labels exist before the first `issue create`
 * (gh/glab both fail creating an issue with a non-existent label). Idempotent —
 * `--force` (gh) / re-create (glab) is a no-op when the label already exists.
 */
export async function ensureForgeLabels({ cli, cwd, env, exec = runCli } = {}) {
  const labels = [
    { name: LI_LABEL, color: '1d76db', desc: 'Filed by the Layered Intelligence loop' },
    { name: LI_BLOCKING_LABEL, color: 'b60205', desc: 'Layered Intelligence loop is paused on this issue' }
  ];
  for (const l of labels) {
    if (cli === 'glab') {
      await exec(cli, ['label', 'create', '--name', l.name, '--color', `#${l.color}`, '--description', l.desc], { cwd, env });
    } else {
      await exec(cli, ['label', 'create', l.name, '--color', l.color, '--description', l.desc, '--force'], { cwd, env });
    }
  }
}

/**
 * File ONE proposal issue on a forge (gh/glab). Ensures labels first, embeds the
 * slug marker in the body, and returns `{ success, number, url }`. The issue
 * number is parsed from the created URL's trailing digits.
 */
export async function fileProposalToForge({ cli, cwd, env, title, body, slug, exec = runCli } = {}) {
  await ensureForgeLabels({ cli, cwd, env, exec });
  const fullBody = `${body}\n\n${slugMarker(slug)}`;
  const args = cli === 'glab'
    ? ['issue', 'create', '--title', title, '--description', fullBody, '--label', LI_LABEL]
    : ['issue', 'create', '--title', title, '--body', fullBody, '--label', LI_LABEL];
  const { code, stdout, stderr } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { success: false, error: stderr || `${cli} exited with code ${code}` };
  const urlMatch = stdout.trim().match(/(https?:\/\/\S+)/);
  const url = urlMatch ? urlMatch[1] : stdout.trim();
  const numMatch = url.match(/(\d+)\s*$/);
  return { success: true, number: numMatch ? Number(numMatch[1]) : null, url };
}

/** Apply the blocking label to an existing issue (pause). Returns `{ success }`. */
export async function applyBlockingLabel({ cli, cwd, env, number, exec = runCli } = {}) {
  if (!Number.isInteger(number)) return { success: false, error: 'no issue number' };
  const args = cli === 'glab'
    ? ['issue', 'update', String(number), '--label', LI_BLOCKING_LABEL]
    : ['issue', 'edit', String(number), '--add-label', LI_BLOCKING_LABEL];
  const { code, stderr } = await exec(cli, args, { cwd, env });
  return code === 0 ? { success: true } : { success: false, error: stderr };
}

// ---------------------------------------------------------------------------
// Jira filer. Jira has no forge CLI — it goes through the PortOS Jira REST
// service (server/services/jira.js). Dedup + pause are label-based (same as the
// forges) via JQL, with the slug marker embedded in the ticket description.
// The Jira deps (search/create/addLabel) are injectable so tests drive the
// dispatch without a live Jira instance.
// ---------------------------------------------------------------------------

/**
 * Normalize a Jira status CATEGORY to `open` / `closed`. Jira's three canonical
 * categories are "To Do" / "In Progress" / "Done"; only "Done" counts as closed
 * for dedup + park. Anything unrecognized is treated as open so a custom
 * in-flight status can't slip past dedup.
 */
export function normalizeJiraState(statusCategory) {
  return (statusCategory || '').toLowerCase() === 'done' ? 'closed' : 'open';
}

/**
 * List existing layered-intelligence tickets in a Jira project (open + recently
 * closed) for the reasoner + dedup guard. Mirrors listForgeIssues' `{ ok, issues }`
 * failed-vs-empty contract: a thrown search is `ok:false` (do NOT file — a blind
 * dedup would duplicate); an empty result is `ok:true, issues:[]`.
 */
export async function listJiraIssues({ instanceId, projectKey, search = searchIssues } = {}) {
  if (!instanceId || !projectKey) return { ok: false, issues: [] };
  const jql = `project = "${escapeJql(projectKey)}" AND labels = "${LI_LABEL}" ORDER BY updated DESC`;
  const rows = await search(instanceId, jql).then(r => r, () => null);
  if (!Array.isArray(rows)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: rows.map(i => ({
      number: i.key || null,
      title: i.summary || '',
      body: i.description || '',
      state: normalizeJiraState(i.statusCategory),
      closedAt: i.resolutiondate || null,
      slug: extractSlugFromBody(i.description || '') || extractSlugFromBody(i.summary || '')
    }))
  };
}

/**
 * List OPEN blocking-labeled Jira tickets for the app (park check). `{ ok, issues }`
 * with the same failed-vs-empty distinction. JQL filters out Done so a resolved
 * blocking ticket un-parks the app automatically (matching the forge pause model).
 */
export async function listJiraBlockingIssues({ instanceId, projectKey, search = searchIssues } = {}) {
  if (!instanceId || !projectKey) return { ok: false, issues: [] };
  const jql = `project = "${escapeJql(projectKey)}" AND labels = "${LI_JIRA_BLOCKING_LABEL}" AND statusCategory != Done ORDER BY updated DESC`;
  const rows = await search(instanceId, jql).then(r => r, () => null);
  if (!Array.isArray(rows)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: rows.map(i => ({ number: i.key || null, title: i.summary || '', state: normalizeJiraState(i.statusCategory) }))
  };
}

/**
 * File ONE proposal ticket in a Jira project. Embeds the slug marker in the
 * description (searchable for dedup) and tags it with the layered-intelligence
 * label. Returns `{ success, key, url }` — Jira issues are keyed strings
 * (`PROJ-123`), not integers, so the handler resolves pause targets by key.
 */
export async function fileProposalToJira({ instanceId, projectKey, issueType = 'Task', title, body, slug, create = createTicket } = {}) {
  if (!instanceId || !projectKey) return { success: false, error: 'jira instance/project not configured' };
  const description = `${body}\n\n${slugMarker(slug)}`;
  const res = await create(instanceId, {
    projectKey,
    summary: title,
    description,
    issueType,
    labels: [LI_LABEL]
  }).then(r => r, (err) => ({ success: false, error: err?.message || 'jira create failed' }));
  if (!res?.success) return { success: false, error: res?.error || 'jira create failed' };
  return { success: true, key: res.ticketId || null, url: res.url || null };
}

/**
 * Resolve a Jira pause target to a concrete issue KEY. `"this"` → the just-filed
 * ticket's key; an integer → `<projectKey>-<n>` (a pre-existing ticket in the
 * same project). Returns null when it can't resolve (e.g. `"this"` but nothing
 * was filed, or no project key for an integer target).
 */
export function resolveJiraBlockKey(pause, filedKey, projectKey) {
  if (!pause) return null;
  if (pause.blockOnIssue === 'this') return filedKey || null;
  if (Number.isInteger(pause.blockOnIssue) && projectKey) return `${projectKey}-${pause.blockOnIssue}`;
  return null;
}

/** Apply the Jira blocking label to an existing ticket (pause). Returns `{ success }`. */
export async function applyJiraBlockingLabel({ instanceId, key, addLabel = addLabels } = {}) {
  if (!instanceId || !key) return { success: false, error: 'no jira ticket key' };
  const res = await addLabel(instanceId, key, [LI_JIRA_BLOCKING_LABEL]).then(r => r, (err) => ({ success: false, error: err?.message }));
  return res?.success ? { success: true } : { success: false, error: res?.error || 'jira label failed' };
}

/**
 * Append a slug-tagged proposal to the app's PLAN.md (the `plan` tracker path).
 * Dedups by scanning for the `[lil-<slug>]` tag. Creates PLAN.md with a heading
 * + `## Next Up` section if absent. Returns `{ success, duplicate }`.
 */
export async function appendProposalToPlan({ repoPath, appName, slug, title, body } = {}) {
  const planPath = join(repoPath, 'PLAN.md');
  const tag = `[lil-${slug}]`;
  const existing = existsSync(planPath) ? await readFile(planPath, 'utf-8').catch(() => '') : '';
  if (existing.includes(tag)) return { success: true, duplicate: true };

  const oneLine = (body || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const item = `- [ ] ${tag} **${title}** ${oneLine}`.trim();

  if (!existing) {
    const content = `# ${appName} — Development Plan\n\n## Next Up\n\n${item}\n`;
    await writeFile(planPath, content);
    return { success: true, duplicate: false };
  }
  const nextUpRe = /(##\s+Next Up[^\n]*)(\n?)/;
  if (nextUpRe.test(existing)) {
    // Insert right after the "## Next Up" heading line, normalizing the heading's
    // line ending first so a file that ENDS at `## Next Up` (no trailing newline)
    // gets the item on its own line rather than a second section appended below.
    const updated = existing.replace(nextUpRe, `$1\n${item}\n`);
    await writeFile(planPath, updated.endsWith('\n') ? updated : `${updated}\n`);
    return { success: true, duplicate: false };
  }
  // No Next Up section — append one.
  const sep = existing.endsWith('\n') ? '' : '\n';
  await appendFile(planPath, `${sep}\n## Next Up\n\n${item}\n`);
  return { success: true, duplicate: false };
}

/**
 * Scan a PLAN.md string for `[lil-<slug>]` tags → array of `{ slug, state }`.
 * Preserves each tag's list-item checkbox so the outcome loop (#2435) can
 * reconcile a completed PLAN proposal: `- [x] [lil-foo]` reads as `closed`,
 * `- [ ] [lil-foo]` as `open`.
 *
 * Absent ≠ done (the CLAUDE.md sentinel rule): a bare tag with NO preceding
 * checkbox stays `open` (still tracked/suppressed) rather than collapsing to
 * `closed` — a missing checkbox must not silently make an item re-proposable.
 * A `closed` item carries no `closedAt` (PLAN.md checkboxes have no timestamp),
 * which `isIssueWithinDedupWindow` treats as permanently in-window → a completed
 * proposal stays suppressed forever instead of being re-reasoned every run (#2620).
 */
export function extractPlanSlugs(planContent) {
  if (typeof planContent !== 'string') return [];
  const items = [];
  // Alt 1: a list item `- [ ]`/`- [x]` whose line also carries the tag (state
  // from the checkbox char). Alt 2: a bare tag with no checkbox (state 'open').
  const re = /^[ \t]*[-*][ \t]*\[([ xX])\][^\n]*?\[lil-([a-z0-9][a-z0-9-]*)\]|\[lil-([a-z0-9][a-z0-9-]*)\]/gim;
  let m;
  while ((m = re.exec(planContent))) {
    if (m[2]) {
      items.push({ slug: m[2].toLowerCase(), state: m[1].toLowerCase() === 'x' ? 'closed' : 'open' });
    } else {
      items.push({ slug: m[3].toLowerCase(), state: 'open' });
    }
  }
  return items;
}
