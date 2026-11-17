/**
 * Layered Intelligence — per-app config resolution (#2842 split of layeredIntelligence.js).
 *
 * The shipped defaults, the settings→effective-config merge, and the scope gate
 * that keeps the PortOS-only meta/self scopes off other apps.
 */

import { DAY } from '../../lib/fileUtils.js';
import { PROPOSAL_SCOPES, PORTOS_ONLY_SCOPES } from './constants.js';

/**
 * The default per-app config. PortOS additionally gets the meta/self scopes; other apps are
 * capped at improvement + data-gap. Off by default (user-enabled automation, no cold-bootstrap).
 */
export function defaultLayeredIntelligenceConfig(isPortos = false) {
  return {
    enabled: false,
    intervalMs: DAY,
    providerId: null,
    model: null,
    sources: {
      goals: true,
      // The app's OWN metrics (METRICS.md, docs/METRICS.md): the primary signal, ON for every app.
      appMetrics: true,
      // Autonomous agent run stats (learning.json): PortOS's own performance, but for a
      // managed app only a tooling signal, so default ON for PortOS only.
      cosMetrics: isPortos,
      healthReport: true,
      planMd: true,
      openIssues: true,
      // The backlog the user already committed to (#2698): `plan`-labeled issues, the Jira
      // backlog, PLAN.md unchecked items. ON for every app so proposals cross-reference it.
      plannedWork: true,
      // PortOS's own product-success signals (POST activity and creative
      // commission feedback). Managed apps use appMetrics/custom sources.
      productMetrics: isPortos,
      // Self-feedback signal (#2428): past proposals and tracker outcomes. ON for PortOS, OFF for managed apps.
      outcomes: isPortos,
      // Self-awareness signal (#2700): a deterministic read of LI's own record (merge rate,
      // suppressed proposals, agent-run success). PortOS-only default, like `outcomes`.
      selfEval: isPortos,
      custom: []
    },
    rules: '',
    allowedScopes: isPortos
      ? ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self']
      : ['app-improvement', 'app-data-gap'],
    // Engine-A hand-off: a trivial+safe proposal is ALSO enqueued as an approval-gated CoS
    // task. Off by default: unattended code writing is a separate opt-in.
    handoff: { enabled: false }
  };
}

/**
 * Merge an app record's stored `layeredIntelligence` over the defaults so a partial config
 * still yields a complete, safe one; `sources` merges one level deep.
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
  // Merge handoff one level deep so a partial `{ handoff: {} }` keeps the default `enabled`.
  merged.handoff = {
    ...base.handoff,
    ...(stored.handoff && typeof stored.handoff === 'object' && !Array.isArray(stored.handoff) ? stored.handoff : {})
  };
  if (!Array.isArray(merged.sources.custom)) merged.sources.custom = [];
  if (!Array.isArray(merged.allowedScopes)) merged.allowedScopes = base.allowedScopes;
  return merged;
}

/**
 * Whether a proposal scope is allowed for this app: it must be recognized, in the app's
 * `allowedScopes`, and meta/self scopes require the PortOS install itself, whatever the prompt said.
 */
export function isScopeAllowed({ scope, allowedScopes = [], isPortos = false }) {
  if (!PROPOSAL_SCOPES.includes(scope)) return false;
  if (PORTOS_ONLY_SCOPES.includes(scope) && !isPortos) return false;
  return allowedScopes.includes(scope);
}
