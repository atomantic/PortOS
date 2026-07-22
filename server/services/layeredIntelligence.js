/**
 * Layered Intelligence Loop — deterministic backbone (re-exporting barrel).
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
 * This file had grown to 2,631 lines spanning constants, config, dedup, outcomes,
 * awareness reports, prompt assembly and four tracker filers. Issue #2842 split it
 * into ./layeredIntelligence/* the same way #1152 split `arcPlanner.js`; this
 * barrel re-exports everything so existing `from './layeredIntelligence.js'`
 * imports keep working. New code may import the focused module directly.
 *
 * See docs/plans/2026-07-07-layered-intelligence-loop.md for the full design.
 */

export * from './layeredIntelligence/constants.js';
export * from './layeredIntelligence/config.js';
export * from './layeredIntelligence/dedup.js';
export * from './layeredIntelligence/proposal.js';
export * from './layeredIntelligence/outcomes.js';
export * from './layeredIntelligence/awareness.js';
export * from './layeredIntelligence/gates.js';
export * from './layeredIntelligence/prompt.js';
export * from './layeredIntelligence/runCli.js';
export * from './layeredIntelligence/sources.js';
export * from './layeredIntelligence/semanticDedup.js';
export * from './layeredIntelligence/forgeFiler.js';
export * from './layeredIntelligence/jiraFiler.js';
export * from './layeredIntelligence/planFiler.js';
