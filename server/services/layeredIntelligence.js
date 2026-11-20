/**
 * Layered Intelligence Loop: deterministic backbone (re-exporting barrel).
 *
 * A reasoning model proposes one improvement per managed app as structured JSON;
 * every side effect (dedup, scope-gating, pause, tracker filing) is deterministic
 * code here, so the model never makes direct code changes. Pure helpers are
 * unit-tested; I/O functions take injectable deps. Split into
 * ./layeredIntelligence/* (#2842); this barrel keeps old imports working.
 * Design: docs/plans/archive/2026-07-07-layered-intelligence-loop.md
 */

export * from './layeredIntelligence/constants.js';
export * from './layeredIntelligence/config.js';
export * from './layeredIntelligence/dedup.js';
export * from './layeredIntelligence/proposal.js';
export * from './layeredIntelligence/outcomes.js';
export * from './layeredIntelligence/awareness.js';
export * from './layeredIntelligence/approvalFunnel.js';
export * from './layeredIntelligence/gates.js';
export * from './layeredIntelligence/prompt.js';
export * from './layeredIntelligence/sources.js';
export * from './layeredIntelligence/semanticDedup.js';
export * from './layeredIntelligence/forgeFiler.js';
export * from './layeredIntelligence/jiraFiler.js';
export * from './layeredIntelligence/planFiler.js';
