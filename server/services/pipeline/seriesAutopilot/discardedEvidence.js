/**
 * Rollback evidence for the autopilot's convergence gates (#3835).
 *
 * Every gate that can THROW A REPAIR AWAY owes the next attempt the whole set of
 * candidates it has already discarded — not just the most recent one. A gate
 * that remembers only the last rejection lets the resolver re-author the first:
 * the observed 2 → 1 → 5 (revert) → 1 → 2 (revert, out of retries) stall the arc
 * gate was fixed for (#3829/#3832), and the same loss the foundation gate had
 * per dimension.
 *
 * The arc gate banks ONE flat history for the run; the foundation gate banks one
 * per dimension, because its repairs are owned by independent editors and a
 * character rejection says nothing about a structure attempt. That is the only
 * difference between them, so both ride this keyed bank — the arc gate simply
 * never passes a key. Two hand-rolled accumulators in one file is how their
 * behaviour drifts while a reader assumes it hasn't.
 *
 * Pure except for the bank's own closed-over state: no I/O, no broadcast.
 */

import { AUTOPILOT_DISCARDED_MAX } from '../series.js';
import { containsFinding } from './convergence.js';

// A gate's evidence is diagnostic context for one prompt, so it is bounded to
// the same cap the persisted marker uses — otherwise the live SSE frame and the
// resume marker would disagree about what was thrown away.
export const boundDiscarded = (findings) => (Array.isArray(findings)
  ? findings.slice(0, AUTOPILOT_DISCARDED_MAX)
  : []);

// The single-history gates (arc) bank under one key rather than growing a second
// code path for "no key".
const FLAT = '';

/**
 * A gate-lifetime bank of discarded findings, newest first, keyed by repair
 * target.
 *
 * `prior` seeds it with evidence carried across a pause — an array for a flat
 * gate, or a `{ key: findings[] }` map for a keyed one. Seeding (rather than
 * holding it alongside) is what keeps a SECOND pause from dropping the first
 * run's evidence: `byKey()`/`all()` re-emit what was carried in, so the marker a
 * twice-resumed gate stamps is still the whole history.
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
   * Record a discarded set as this key's newest evidence. Called at the moment a
   * candidate is thrown away — a rollback, a rewind, an isolated patch's revert
   * — so no exit has to remember to do it on that path's behalf.
   *
   * A finding the VISIBLE history already holds is not re-banked and does not
   * move: the verifier restates the same problem freely, and a bank of
   * paraphrases would push the real history past the bound. But identity is
   * checked against the bounded view, not the raw list — a candidate whose only
   * copy has already been trimmed out of the prompt is, on being discarded
   * again, the newest evidence there is, so it returns to the front and its
   * stale below-the-bound copy goes with it.
   */
  const record = (findings, key = FLAT) => {
    const current = Array.isArray(findings) ? findings : [];
    const held = banked.get(key) || [];
    const visible = boundDiscarded(held);
    const fresh = current.filter((finding) => !containsFinding(visible, finding));
    banked.set(key, [...fresh, ...held.filter((finding) => !containsFinding(fresh, finding))]);
  };

  /**
   * Build the avoid list for ONE repair call and bank that call's own evidence,
   * so a rejected candidate stops being the next retry's private knowledge.
   *
   * `current` — the set this call is itself discarding — leads and stays whole:
   * it describes the exact candidate just rejected, and leading it means the
   * newest evidence is never the part the bound cuts. `active` is what this call
   * is being asked to FIX; a latent defect from a rejected candidate can later be
   * found in the restored checkpoint itself, and telling the repairer both "fix
   * this" and "avoid this" is contradictory, so carried evidence is filtered
   * against it (and against `current`, which routinely restates it).
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
