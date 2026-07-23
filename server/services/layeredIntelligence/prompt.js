/**
 * Layered Intelligence — reasoning-prompt assembly
 * (#2842 split of layeredIntelligence.js).
 *
 * Deterministic: given the gathered sources, open issues and config, produces the
 * exact JSON-only string sent to the reasoning model.
 */

import { PLANNED_WORK_GUIDANCE, LI_PROPOSAL_PLAYBOOK, LI_PLAYBOOK_GUIDANCE } from './constants.js';
import { isScopeAllowed } from './config.js';
import { extractSlugFromBody } from './dedup.js';

// Source keys that buildPrompt renders as their OWN dedicated block (with tailored
// guidance) instead of dumping into the generic "### <key>\n<value>" source list.
// Keeping them in one named set — rather than accreting `&& k !== 'x'` clauses on the
// filter — documents WHY these keys are special and gives the next dedicated-block
// signal a single edit point.
const BESPOKE_SOURCE_BLOCK_KEYS = new Set(['plannedWork', 'scopeGuidance']);

/**
 * Build the JSON-only reasoning prompt for one app. Deterministic: given the
 * gathered sources, open issues, and config, produces the exact string sent to
 * the model. Meta/self scopes are only offered when the app is PortOS.
 * `outcomesReport` (from computeOutcomesReport) is injected as a `liOutcomes`
 * block with calibration guidance when non-empty (#2428). `selfEvalReport` (from
 * computeSelfEvalSummary) is injected as a `liSelfEval` block the same way (#2700).
 * `sources.scopeGuidance` (from computeScopeAwareness) is injected as a
 * `liScopeAwareness` block the same way (#2760). `proposalExecutionReport` (from
 * computeProposalExecutionAwareness) is injected as a `liProposalExecution` block —
 * the TRUE per-proposal-domain execution record #2760 could only approximate (#2765).
 * `crossReferenceReport` (from computeCrossReferenceAnalysis) is injected as a
 * `liCrossReference` block that names domains LI proposes well but executes poorly (#2764 §3).
 * `hardExclusionNotice` (from computeHardExclusionNotice, #2824) is injected as a
 * prominent `liHardExclusions` block ABOVE the allowed scopes when LI's execution
 * health is degraded — the reasoner-facing mirror of the deterministic filing gate.
 * Finally, the static `liPlaybook` block (LI_PROPOSAL_PLAYBOOK, #2763) is ALWAYS
 * appended: the a-priori scope/task-type/goal rule set LI needs from run one, before
 * any per-app outcome data exists.
 */
export function buildPrompt({ app, config, sources = {}, openIssues = [], isPortos = false, outcomesReport = '', selfEvalReport = '', proposalExecutionReport = '', crossReferenceReport = '', hardExclusionNotice = '' }) {
  const allowed = (config.allowedScopes || []).filter(s =>
    isScopeAllowed({ scope: s, allowedScopes: config.allowedScopes, isPortos })
  );
  const scopeLines = allowed.map(s => `  - ${s}`).join('\n');
  // plannedWork renders as its OWN block (below) rather than inside the generic
  // source list, so the cross-reference guidance is guaranteed to sit directly
  // under the committed backlog it refers to instead of drifting to wherever
  // object key order happens to put it.
  const sourceBlocks = Object.entries(sources)
    .filter(([k]) => !BESPOKE_SOURCE_BLOCK_KEYS.has(k))
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
    ? '\nHand-off: a proposal you mark BOTH "complexity":"trivial" AND "safe":true may be handed directly to a coding agent to implement now (not just filed). Only mark a proposal trivial+safe when it is small, self-contained, and carries no regression or data-loss risk — when in doubt, use a higher complexity or "safe":false so a human triages it first. Note: even a trivial+safe proposal is filed for a human (not auto-handed-off) when it falls in a domain where LI\'s own past hand-offs chronically fail, so prefer to narrow such a proposal to a slice an agent can actually finish.\n'
    : '';

  // The committed backlog (#2698) + the instruction to check against it. Emitted
  // whenever gatherPlannedWork produced ANY string — including its explicit
  // "could not be read" marker, which must still reach the reasoner: silently
  // dropping an unavailable read would look identical to "this app has nothing
  // planned" and license a proposal straight into committed work.
  const plannedWorkBlock = (typeof sources.plannedWork === 'string' && sources.plannedWork.trim())
    ? `\n### plannedWork\n${sources.plannedWork.trim()}\n\n${PLANNED_WORK_GUIDANCE}\n`
    : '';

  // Feedback loop (#2428): show the reasoner how its own past proposals fared so
  // it can calibrate scope/merge-rate instead of proposing in a vacuum.
  const outcomesBlock = (typeof outcomesReport === 'string' && outcomesReport.trim())
    ? `\n### liOutcomes\n${outcomesReport.trim()}\n\nUse this data to calibrate your proposal: prefer scopes with higher merge rates, avoid patterns that were repeatedly rejected, and consider that lower-merge scopes may need more justification.\n`
    : '';

  // Self-evaluation (#2700): the loop's own quality check BEFORE it files, so it
  // can decline instead of learning only from a later rejection. Carries its own
  // low-confidence / degraded-execution guidance (computeSelfEvalSummary), which is
  // why no extra instruction sentence is appended here — the block is self-contained
  // and its guidance is conditional on what the signals actually say.
  const selfEvalBlock = (typeof selfEvalReport === 'string' && selfEvalReport.trim())
    ? `\n### liSelfEval\n${selfEvalReport.trim()}\n\nWeigh this against the sources above before you commit to a proposal. Filing nothing (proposal: null) is a legitimate, and sometimes the correct, outcome — a marginal issue costs the user triage time and lowers your merge rate further.\n`
    : '';

  // Scope-awareness (#2760): install-wide completion rates by CoS task TYPE — directional
  // context for how reliably different KINDS of work get finished here. PortOS-only
  // (codex P2): these rates are this install's own CoS execution history, meaningless to
  // a managed app, so the block is gated on isPortos even if a managed app enabled the
  // cosMetrics source. It is context, not a rule (codex P1): a proposal does not map 1:1
  // onto a listed type, so treat a low-completion type as a reason for extra scrutiny /
  // a narrower scope, not a hard veto.
  const scopeGuidanceBlock = (isPortos && typeof sources.scopeGuidance === 'string' && sources.scopeGuidance.trim())
    ? `\n### liScopeAwareness\n${sources.scopeGuidance.trim()}\n\nThese are per-task-type completion rates for THIS install — how reliably each KIND of work tends to get finished, not a per-proposal record (your proposals don't map 1:1 onto these types). Use it as directional context: a proposal whose implementation resembles a low-completion type deserves extra scrutiny or a narrower scope; high-completion kinds are safer bets. A low rate on self-improve:layered-intelligence is LI's OWN reasoning-run rate — a direct signal to propose conservatively. Where the liProposalExecution block below covers a domain, prefer it: it is a direct per-proposal record, whereas these buckets are only directional.\n`
    : '';

  // Per-proposal-domain execution record (#2765): unlike liScopeAwareness above —
  // which borrows install-wide per-task-TYPE rates a proposal only loosely maps onto —
  // this keys on how LI's OWN proposals in each domain actually fared once handed off
  // and executed. It carries NO "directional only" caveat because the mapping is real,
  // so it is the authoritative avoid/prefer signal wherever it has data. The report is
  // pre-gated on the outcomes source by the caller (built from the same records), so no
  // isPortos re-check here — the block simply renders when execution history exists.
  const proposalExecutionBlock = (typeof proposalExecutionReport === 'string' && proposalExecutionReport.trim())
    ? `\n### liProposalExecution\n${proposalExecutionReport.trim()}\n\nThis is a DIRECT record of how LI's own proposals in each domain fared once implemented — not directional context. Favor domains LI executes reliably; for a low-execution domain, either narrow the proposal to a slice an agent can finish or justify why it is still the highest-value work despite the track record.\n`
    : '';

  // Cross-reference (#2764 §3): the CONTRAST liOutcomes and liProposalExecution can't
  // show on their own — a domain LI proposes well (merges) but executes poorly (its
  // hand-offs fail with a named cause). It carries its own actionable guidance in the
  // header, so no extra instruction sentence is appended. Gated on the outcomes source
  // by the caller (built from the same records), so no isPortos re-check here.
  const crossReferenceBlock = (typeof crossReferenceReport === 'string' && crossReferenceReport.trim())
    ? `\n### liCrossReference\n${crossReferenceReport.trim()}\n`
    : '';

  // Proposal Playbook (#2763): the STANDING, a-priori rule set — always rendered.
  // Unlike the data blocks above (which appear only once enough per-app outcome data
  // accumulates), the playbook is the guidance LI needs from run one, when it would
  // otherwise be proposing blind. It sits last so it is the freshest instruction
  // before the JSON contract, and its guidance sentence defers to any live data block
  // above that has real numbers contradicting a general rule.
  const playbookBlock = LI_PROPOSAL_PLAYBOOK
    ? `\n### liPlaybook\n${LI_PROPOSAL_PLAYBOOK}\n\n${LI_PLAYBOOK_GUIDANCE}\n`
    : '';

  // Hard exclusion gate (#2824): rendered ABOVE the allowed scopes and sources as a
  // hard constraint so the reasoner sees what is off-limits before it picks a scope.
  // Non-empty only when the deterministic filing gate is armed (execution health
  // degraded), so a healthy loop's prompt is unchanged. Even if the reasoner reasons
  // past this, computeHardExclusionGate drops the proposal before it is filed.
  const hardExclusionBlock = (typeof hardExclusionNotice === 'string' && hardExclusionNotice.trim())
    ? `\n### liHardExclusions\n${hardExclusionNotice.trim()}\n`
    : '';

  return `You are the Layered Intelligence reasoner for the app "${app.name}". Your job is to evaluate how THIS app is performing against its OWN goals and purpose${isPortos ? '' : ', not how well PortOS\'s tooling manages it'}. Decide the SINGLE highest-value improvement to propose this run (signal, not noise), grounded in the app's own goals and its own performance metrics (user success, KPIs, production telemetry). You never write code; you return structured JSON that a deterministic system files as ONE tracker issue.
${handoffNote}${metricsGuidance}${hardExclusionBlock}
Rules & guidance from the operator:
${config.rules?.trim() || '(none)'}

Allowed proposal scopes (you MUST pick one of these for any proposal):
${scopeLines || '  (none — return proposal: null)'}
${isPortos ? '' : 'Note: meta/self scopes are unavailable on this app; frame any data need as an "app-data-gap" against this app.\n'}
Already-open tracked issues (DO NOT duplicate these — reuse their slug only if genuinely the same work):
${openList}

Gathered sources:
${sourceBlocks || (plannedWorkBlock ? '(no other sources available — you may propose an app-data-gap to add telemetry)' : '(no sources available — you may propose an app-data-gap to add telemetry)')}
${plannedWorkBlock}${outcomesBlock}${selfEvalBlock}${scopeGuidanceBlock}${proposalExecutionBlock}${crossReferenceBlock}${playbookBlock}
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
