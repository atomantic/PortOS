/**
 * Safety-kind classifier (#2440)
 *
 * A safety axis ORTHOGONAL to confidence scoring: outward-facing / irreversible
 * work (publishing, federating to peers, external PRs, releases) always needs the
 * PortOS user's sign-off however high the success rate, since a 100% score can't
 * undo a published post. Internal reversible work keeps the success-rate gate;
 * reversible is the DEFAULT. Pure and deterministic.
 */

import { currentTaskTypeName } from '../../lib/scheduledTaskTypes.js';
import { OUTWARD_SAFETY_KINDS } from '../../lib/cos/cosSafetyKinds.js';

export { OUTWARD_SAFETY_KINDS };

/** Reversible internal work — retains today's confidence success-rate gate. */
export const REVERSIBLE_SAFETY_KIND = 'reversible';

export const DEFAULT_ALWAYS_APPROVE_KINDS = Object.freeze([...OUTWARD_SAFETY_KINDS]);

const OUTWARD_KIND_SET = new Set(OUTWARD_SAFETY_KINDS);

/**
 * Ordered keyword signatures, first match wins, over a lowercased haystack of
 * the task-type key plus hints. Biased toward requiring approval: a false
 * positive costs a review, a false negative auto-approves outward work.
 *
 * Bare `\brelease\b` is intentionally NOT a publish signal (it matches
 * `pre-release`, a check); shipping names match via `\bpublish\b` or the explicit
 * `cut/create/ship/do-release` forms. The scheduled `do-release` task itself is
 * exempt: operator configuration or Run Now is the consent.
 */
const KIND_SIGNATURES = [
  { kind: 'federation', re: /federat|peer[-\s]?sync|sync[-\s]?peer|fan[-\s]?out[-\s]?record/ },
  { kind: 'external-pr', re: /external[-\s]?pr|upstream[-\s]?pr|fork[-\s]?pr/ },
  { kind: 'publish', re: /\bpublish\b|\bdeploy\b|\b(cut|create|ship|do)[- ]release\b|go[-\s]?live|auto[-\s]?send|outbound[-\s]?message/ },
  { kind: 'content', re: /social[-\s]?media|newsletter|\bblog\b|generate[-\s]?content/ }
];

const isScheduledReleaseTaskType = (key) => typeof key === 'string'
  && currentTaskTypeName(key.replace(/^(self|app)-improve:/, '')) === 'do-release';

const normalizeKind = (k) => (typeof k === 'string' ? k.trim().toLowerCase() : '');

/**
 * Classify a task's safety kind. Priority: explicit `metadata.safetyKind` /
 * `outwardFacing` → capability hints → scheduled release task → keyword
 * signatures → reversible default.
 *
 * @param {{ taskTypeKey?: string, metadata?: object }} [input]
 * @returns {{ kind: string, outwardFacing: boolean, reason: string }}
 */
export function classifySafetyKind({ taskTypeKey = '', metadata = {} } = {}) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};

  // 1) Explicit override wins.
  const explicit = normalizeKind(meta.safetyKind);
  if (explicit) {
    return {
      kind: explicit,
      outwardFacing: OUTWARD_KIND_SET.has(explicit),
      reason: `explicit metadata.safetyKind=${explicit}`
    };
  }
  if (meta.outwardFacing === true) {
    return { kind: 'publish', outwardFacing: true, reason: 'explicit metadata.outwardFacing flag' };
  }
  if (meta.outwardFacing === false) {
    return { kind: REVERSIBLE_SAFETY_KIND, outwardFacing: false, reason: 'explicit metadata.outwardFacing=false' };
  }

  // 2) Capability hints.
  if (meta.federatesRecords === true || meta.publishesToPeers === true) {
    return { kind: 'federation', outwardFacing: true, reason: 'metadata capability: federation' };
  }
  if (meta.publishesContent === true) {
    return { kind: 'content', outwardFacing: true, reason: 'metadata capability: content publish' };
  }
  if (meta.opensExternalPr === true) {
    return { kind: 'external-pr', outwardFacing: true, reason: 'metadata capability: external PR' };
  }

  // 3) The scheduled release coordinator keeps the confidence gate (its prompt
  //    title would otherwise match `do-release`).
  if ([taskTypeKey, meta.analysisType, meta.selfImprovementType].some(isScheduledReleaseTaskType)) {
    return { kind: REVERSIBLE_SAFETY_KIND, outwardFacing: false, reason: 'operator-configured scheduled release task' };
  }

  // 4) Keyword signatures.
  const haystack = [taskTypeKey, meta.analysisType, meta.selfImprovementType, meta.taskDescription]
    .filter((s) => typeof s === 'string' && s)
    .join(' ')
    .toLowerCase();
  if (haystack) {
    for (const { kind, re } of KIND_SIGNATURES) {
      if (re.test(haystack)) {
        return { kind, outwardFacing: true, reason: `signature match: ${kind}` };
      }
    }
  }

  // 5) Default: reversible.
  return { kind: REVERSIBLE_SAFETY_KIND, outwardFacing: false, reason: 'no outward signal — reversible internal work' };
}

/**
 * Should this safety kind be forced to human approval regardless of confidence?
 * Reads `config.safetyKindApproval`. `alwaysApproveKinds` is the final authority:
 * an outward kind absent from it (or with the gate disabled) falls through to the
 * confidence gate, so tuning the list also tempers explicit classifications.
 *
 * @param {string} kind - a safety kind from classifySafetyKind()
 * @param {{ enabled?: boolean, alwaysApproveKinds?: string[] }} [config]
 * @returns {boolean}
 */
export function requiresSafetyApproval(kind, config = {}) {
  if (config?.enabled === false) return false;
  const list = Array.isArray(config?.alwaysApproveKinds)
    ? config.alwaysApproveKinds
    : DEFAULT_ALWAYS_APPROVE_KINDS;
  const target = normalizeKind(kind);
  if (!target) return false;
  return list.map(normalizeKind).includes(target);
}
