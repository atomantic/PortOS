/**
 * Compatibility facade for the AI-provider helpers.
 *
 * The helpers used to live here as one 2,200-line module. They now live in
 * nine responsibility-scoped siblings, each named for the question it answers
 * (and, where one exists, for the server module it mirrors):
 *
 *   providerTypes.js          — what KIND of provider a record is
 *   providerGateways.js       — the hosted-gateway registry a wrapper fronts
 *   providerEndpoints.js      — WHERE its endpoint points (local / fleet / public)
 *   providerModels.js         — which MODEL and EFFORT a run resolves to
 *   providerSelection.js      — which providers/models a picker may OFFER
 *   localModelHeuristics.js   — what an untyped local model can DO
 *   providerContextWindows.js — how large a CONTEXT WINDOW it gets
 *   providerReadiness.js      — is it READY to run, and why not
 *   providerAssignments.js    — which provider a RECORD resolves to; assignment options
 *
 * Every existing `import { … } from '../utils/providers'` keeps working through
 * this file. New code should import the declaring module — that is where the
 * server parity tests pin the mirrored declarations, and where a change belongs.
 */

export * from './localModelHeuristics.js';
export * from './providerAssignments.js';
export * from './providerContextWindows.js';
export * from './providerEndpoints.js';
export * from './providerGateways.js';
export * from './providerModels.js';
export * from './providerReadiness.js';
export * from './providerSelection.js';
export * from './providerTypes.js';
