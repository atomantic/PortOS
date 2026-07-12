/**
 * Safety-kind classifier (#2440)
 *
 * A safety axis ORTHOGONAL to confidence scoring. Confidence gates purely on a
 * task type's historical success rate; safety-kind gates on whether the work is
 * outward-facing / irreversible — publishing content that goes live, federating
 * records to sync peers, pushing PRs to an external/upstream repo, or
 * releasing/deploying. Outward-facing work always needs the single PortOS user's
 * sign-off regardless of how high the success rate is: a 100% score can't undo a
 * published post or a record already fanned out to peers. ("Escalate to human"
 * here means surface to the one PortOS user — the single-user trust model still
 * applies.)
 *
 * Internal, reversible work (analysis, refactor, code-review, dependency audits,
 * same-repo improvement PRs the user can just close) keeps the pure success-rate
 * gate. Reversible is the DEFAULT, so existing CoS auto-approval behavior is
 * unchanged unless a task carries an explicit outward-facing signal.
 *
 * Pure, deterministic (same input → same output), and side-effect free.
 */

/** Reversible internal work — retains today's confidence success-rate gate. */
export const REVERSIBLE_SAFETY_KIND = 'reversible';

/**
 * Outward-facing / irreversible kinds. This is the default set that always
 * requires human approval (issue #2440 acceptance #4). Tunable per install via
 * `config.safetyKindApproval.alwaysApproveKinds`.
 */
export const OUTWARD_SAFETY_KINDS = Object.freeze(['content', 'publish', 'federation', 'external-pr']);
export const DEFAULT_ALWAYS_APPROVE_KINDS = Object.freeze([...OUTWARD_SAFETY_KINDS]);

const OUTWARD_KIND_SET = new Set(OUTWARD_SAFETY_KINDS);

/**
 * Ordered keyword signatures — first match wins. Matched against a lowercased
 * haystack of the task-type key plus description/analysis hints. Kept
 * conservative and biased toward requiring approval: a false positive merely
 * asks the user to review a task that may not have needed it (safe direction);
 * a false negative would auto-approve genuinely outward work (the dangerous one
 * this feature exists to prevent).
 */
const KIND_SIGNATURES = [
  { kind: 'federation', re: /federat|peer[-\s]?sync|sync[-\s]?peer|fan[-\s]?out[-\s]?record/ },
  { kind: 'external-pr', re: /external[-\s]?pr|upstream[-\s]?pr|fork[-\s]?pr/ },
  { kind: 'publish', re: /\bpublish\b|\bdeploy\b|\brelease\b|go[-\s]?live|auto[-\s]?send|outbound[-\s]?message/ },
  { kind: 'content', re: /social[-\s]?media|newsletter|\bblog\b|generate[-\s]?content|publish[-\s]?content/ }
];

const normalizeKind = (k) => (typeof k === 'string' ? k.trim().toLowerCase() : '');

/**
 * Classify a task's safety kind from its task-type key and metadata.
 *
 * Priority order: explicit `metadata.safetyKind` / `metadata.outwardFacing`
 * override → boolean capability hints → keyword signatures → reversible default.
 *
 * @param {{ taskTypeKey?: string, metadata?: object }} [input]
 * @returns {{ kind: string, outwardFacing: boolean, reason: string }}
 */
export function classifySafetyKind({ taskTypeKey = '', metadata = {} } = {}) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};

  // 1) Explicit override wins — a producer that knows the work's kind says so.
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

  // 2) Boolean capability hints a task builder can set when it knows the shape.
  if (meta.federatesRecords === true || meta.publishesToPeers === true) {
    return { kind: 'federation', outwardFacing: true, reason: 'metadata capability: federation' };
  }
  if (meta.publishesContent === true) {
    return { kind: 'content', outwardFacing: true, reason: 'metadata capability: content publish' };
  }
  if (meta.opensExternalPr === true) {
    return { kind: 'external-pr', outwardFacing: true, reason: 'metadata capability: external PR' };
  }

  // 3) Keyword signatures over the task-type key + free-form description hints.
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

  // 4) Default — reversible internal work; keeps the success-rate gate.
  return { kind: REVERSIBLE_SAFETY_KIND, outwardFacing: false, reason: 'no outward signal — reversible internal work' };
}

/**
 * Should a task of this safety kind be forced to human approval, regardless of
 * confidence tier? Reads the `config.safetyKindApproval` slice.
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
