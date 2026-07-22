/**
 * Layered Intelligence — per-app config resolution (#2842 split of layeredIntelligence.js).
 *
 * The shipped defaults, the settings→effective-config merge, and the scope gate
 * that keeps the PortOS-only meta/self scopes off other apps.
 */

import { DAY } from '../../lib/fileUtils.js';
import { PROPOSAL_SCOPES, PORTOS_ONLY_SCOPES } from './constants.js';

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
      // The backlog the user has ALREADY committed to (#2698): `plan`-labeled
      // tracker issues / the app's prioritized Jira backlog / PLAN.md's unchecked
      // items. Open issues alone read as a flat list with no priority context, so
      // the reasoner had no way to tell "nobody has looked at this" from "the user
      // already scheduled this" — the top NOT_PLANNED rejection cause. On by
      // default for every app: cross-referencing against committed work is only
      // useful if it is there by default.
      plannedWork: true,
      // The self-feedback signal (#2428): past LI proposals + their tracker
      // outcomes, fed back so the reasoner calibrates on its own merge rate.
      // Default ON for the PortOS install (it improves itself), OFF for managed
      // apps — the user opts in per-app via the LI config UI.
      outcomes: isPortos,
      // The loop's self-awareness signal (#2700): a deterministic read of LI's OWN
      // record — proposal merge rate, how many of its proposals are already filed
      // and suppressed, and whether its own agent runs are succeeding — folded back
      // so the reasoner can judge its proposal quality BEFORE filing rather than
      // only learning from rejections after. Same PortOS-only default as `outcomes`:
      // it is built from LI's own history, which only the self-improving install
      // accumulates meaningfully; managed apps opt in per-app.
      selfEval: isPortos,
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
