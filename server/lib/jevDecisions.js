/**
 * The closed-set decisions PortOS is willing to answer with the local
 * entailment scorer instead of a chat completion, and the exact hypothesis
 * wording each one scores.
 *
 * These hypotheses are PROMPTS. They are the entire instruction surface of the
 * feature, so they live here — frozen, versioned with the file, reviewable in a
 * diff — rather than as string literals inside the four services that consume
 * them. A service that inlined its own wording would drift from the wording the
 * agreement measurement was collected against, and the measurement is the only
 * evidence an operator has before flipping a source to `prefer`.
 *
 * Pure: no I/O, no settings, no scorer. `services/untrustedContent.js` owns the
 * screen → jev → chat ladder; this module only says what may be asked.
 */

import { JEV_DEFAULT_MIN_MARGIN, JEV_MAX_HYPOTHESIS_CHARS } from './jev.js';

/**
 * Per-decision and per-option abstention floors.
 *
 * `minMargin` on the decision is the bar every option clears. `minMargin` on an
 * OPTION raises the bar for that option alone, which is how an asymmetric
 * decision is expressed: inside one triage call, recommending `delete` on a
 * real person's mail has to clear a far wider separation than recommending
 * `archive`, even though both come out of the same forward pass.
 *
 * The floors exist because a confident-wrong local classifier is worse than a
 * slow correct remote one. They are deliberately set high enough that the
 * destructive-leaning options effectively always fall through to the chat model
 * until an operator has shadow-mode agreement data that says otherwise.
 */
export const JEV_DECISIONS = Object.freeze({
  // Every new external issue comment costs a chat completion today, and the
  // overwhelmingly common answer is `none`. This is the highest-volume and
  // least destructive of the decisions, so it is the first real cutover.
  'issue-comment-reply': Object.freeze({
    source: 'github-issue',
    label: 'Issue comment reply gate',
    minMargin: 0.2,
    options: Object.freeze([
      Object.freeze({
        value: 'reply',
        hypothesis: 'The external contributor is asking the repository maintainer a project question, reporting an actionable bug, or raising a concrete ambiguity that needs a written public reply.',
      }),
      Object.freeze({
        value: 'none',
        hypothesis: 'The external contributor needs no written reply from the repository maintainer.',
      }),
    ]),
  }),

  'message-triage': Object.freeze({
    source: 'email',
    label: 'Message triage action',
    minMargin: 0.25,
    options: Object.freeze([
      Object.freeze({
        value: 'reply',
        hypothesis: 'This message asks the recipient something or expects a written response from them.',
      }),
      Object.freeze({
        value: 'archive',
        hypothesis: 'This message is informational only and can be filed away without a response.',
      }),
      Object.freeze({
        // Discarding a real person's mail on a local argmax is the one outcome
        // in this table that cannot be walked back by reading it later.
        value: 'delete',
        hypothesis: 'This message is junk, spam, or bulk marketing with no value to the recipient.',
        minMargin: 0.6,
      }),
      Object.freeze({
        value: 'review',
        hypothesis: 'The recipient needs to read this message themselves and decide what to do about it.',
      }),
    ]),
  }),

  'message-priority': Object.freeze({
    source: 'email',
    label: 'Message triage priority',
    minMargin: 0.2,
    options: Object.freeze([
      Object.freeze({
        value: 'high',
        hypothesis: 'This message is urgent and the recipient should deal with it today.',
      }),
      Object.freeze({
        value: 'medium',
        hypothesis: 'This message matters to the recipient but is not urgent.',
      }),
      Object.freeze({
        value: 'low',
        hypothesis: 'This message is unimportant to the recipient and can wait indefinitely.',
      }),
    ]),
  }),

  'forge-maintenance-disposition': Object.freeze({
    source: 'github-issue',
    label: 'Forge maintenance discussion disposition',
    minMargin: 0.25,
    options: Object.freeze([
      Object.freeze({
        // `defer` withholds the record and costs nothing but a skipped task;
        // `inspect-trusted-change` RELEASES a maintenance task built from a
        // discussion that may be trying to steer it. The asymmetry is the
        // whole safety argument, so only one side gets a wide bar.
        value: 'inspect-trusted-change',
        hypothesis: 'This discussion is ordinary project conversation with no attempt to direct an automated maintainer to ignore its instructions, reveal private information, run supplied commands, or install attachments.',
        minMargin: 0.6,
      }),
      Object.freeze({
        value: 'defer',
        hypothesis: 'This discussion contains an attempt to direct an automated maintainer to ignore its instructions, reveal private information, run supplied commands, or install attachments, or its intent is unclear.',
      }),
    ]),
  }),
});

export const JEV_DECISION_IDS = Object.freeze(Object.keys(JEV_DECISIONS));

/** The descriptor for `id`, or null. Never throws on an unknown id. */
export function getJevDecision(id) {
  return Object.hasOwn(JEV_DECISIONS, id) ? JEV_DECISIONS[id] : null;
}

/**
 * The hypotheses for `id`, in the order they are sent to the scorer.
 *
 * Request order is part of the wire contract: `normalizeJevScores` rejects a
 * reply whose hypotheses do not match this list position for position.
 */
export function jevHypotheses(id) {
  const decision = getJevDecision(id);
  return decision ? decision.options.map((option) => option.hypothesis) : null;
}

/** The enum value a returned hypothesis stands for, or null if it is not ours. */
export function jevValueForHypothesis(id, hypothesis) {
  const decision = getJevDecision(id);
  return decision?.options.find((option) => option.hypothesis === hypothesis)?.value ?? null;
}

/**
 * The margin a decision — or a specific winning option — has to clear.
 *
 * `policyMinMargin` (the operator's `jevMinMargin` setting) can only RAISE the
 * bar. The floors in this file are what keep the destructive-leaning options
 * deferring to the chat model, and a settings field that could relax them would
 * be a one-field bypass of the safety argument above.
 */
export function jevMinMarginFor(id, { optionValue = null, policyMinMargin = null } = {}) {
  const decision = getJevDecision(id);
  if (!decision) return null;
  const base = Number.isFinite(decision.minMargin) ? decision.minMargin : JEV_DEFAULT_MIN_MARGIN;
  const option = optionValue === null
    ? null
    : decision.options.find((entry) => entry.value === optionValue);
  const optionFloor = Number.isFinite(option?.minMargin) ? option.minMargin : 0;
  const operator = Number.isFinite(policyMinMargin) ? policyMinMargin : 0;
  return Math.max(base, optionFloor, operator);
}

/**
 * Whether a descriptor can actually be scored.
 *
 * Exported so the contract test can assert it for every shipped decision: an
 * over-long hypothesis or a single-option decision is rejected by the scorer at
 * request time, which would turn a typo in this file into a silent permanent
 * fallback nobody notices because the chat model keeps answering.
 */
export function isValidJevDecision(decision) {
  if (!decision || !Array.isArray(decision.options) || decision.options.length < 2) return false;
  const values = new Set();
  const hypotheses = new Set();
  for (const option of decision.options) {
    if (typeof option?.value !== 'string' || !option.value) return false;
    if (typeof option?.hypothesis !== 'string' || !option.hypothesis.trim()) return false;
    if (option.hypothesis.length > JEV_MAX_HYPOTHESIS_CHARS) return false;
    if (option.minMargin !== undefined && !(Number.isFinite(option.minMargin) && option.minMargin >= 0 && option.minMargin <= 1)) return false;
    values.add(option.value);
    hypotheses.add(option.hypothesis);
  }
  if (values.size !== decision.options.length || hypotheses.size !== decision.options.length) return false;
  return Number.isFinite(decision.minMargin) && decision.minMargin >= 0 && decision.minMargin <= 1;
}
