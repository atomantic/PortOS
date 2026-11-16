/**
 * Rollback evidence for the autopilot's convergence gates (#3835).
 *
 * A gate that can THROW A REPAIR AWAY owes the next attempt every candidate it has
 * discarded, not just the latest, or the resolver re-authors the first (the 2 -> 1
 * -> 5 -> 1 -> 2 arc stall, #3829/#3832). The arc gate banks one flat history; the
 * foundation gate one per dimension (independent editors). Both ride this keyed
 * bank; the arc gate never passes a key.
 *
 * Pure except for the bank's own closed-over state: no I/O, no broadcast.
 */

import { AUTOPILOT_DISCARDED_MAX } from '../series.js';
import { containsFinding } from './convergence.js';

// Bounded to the persisted marker's cap so the live SSE frame and the resume marker agree.
export const boundDiscarded = (findings) => (Array.isArray(findings)
  ? findings.slice(0, AUTOPILOT_DISCARDED_MAX)
  : []);

// Single-history gates (arc) bank under one key.
const FLAT = '';

/**
 * A gate-lifetime bank of discarded findings, newest first, keyed by repair target.
 * `prior` seeds it with evidence carried across a pause (array for a flat gate, or
 * `{ key: findings[] }`), so a second pause still stamps the whole history.
 */
export function createDiscardedBank(prior) {
  const banked = new Map();
  const seed = Array.isArray(prior) ? { [FLAT]: prior } : (prior || {});
  for (const [key, findings] of Object.entries(seed)) {
    if (Array.isArray(findings) && findings.length > 0) banked.set(key, [...findings]);
  }

  /** Everything banked for `key`, newest first, bounded. */
  const history = (key = FLAT) => boundDiscarded(banked.get(key) || []);

  /**
   * Record a discarded set as this key's newest evidence, at the moment a candidate
   * is thrown away. A finding the VISIBLE history already holds is not re-banked
   * (paraphrases would push real history past the bound); identity is checked
   * against the bounded view, so a candidate whose only copy was trimmed returns
   * to the front and its stale copy goes with it.
   */
  const record = (findings, key = FLAT) => {
    const current = Array.isArray(findings) ? findings : [];
    const held = banked.get(key) || [];
    const visible = boundDiscarded(held);
    const fresh = current.filter((finding) => !containsFinding(visible, finding));
    banked.set(key, [...fresh, ...held.filter((finding) => !containsFinding(fresh, finding))]);
  };

  /**
   * Build the avoid list for ONE repair call and bank that call's evidence.
   * `current` (what this call is discarding) leads and stays whole so the bound
   * never cuts the newest evidence. `active` is what this call must FIX; carried
   * evidence is filtered against it (and `current`) so the repairer isn't told both
   * "fix this" and "avoid this".
   */
  const avoid = (current = [], active = [], key = FLAT) => {
    const own = Array.isArray(current) ? current : [];
    const list = boundDiscarded([
      ...own,
      ...history(key).filter((candidate) => (
        !containsFinding(active, candidate) && !containsFinding(own, candidate)
      )),
    ]);
    record(own, key);
    return list;
  };

  /** The flat gate's whole history — what a pause stamps onto its marker. */
  const all = () => history(FLAT);

  /** The keyed gate's whole history, bounded per key, empty keys dropped. */
  const byKey = () => Object.fromEntries(
    [...banked.keys()]
      .map((key) => [key, history(key)])
      .filter(([, findings]) => findings.length > 0),
  );

  return { record, avoid, history, all, byKey };
}
