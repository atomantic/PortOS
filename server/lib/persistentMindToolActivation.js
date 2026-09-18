/**
 * Pure state helpers for the Persistent Mind's progressive tool exposure
 * (issue #7624): a small always-on core plus family-scoped explicit
 * activation with a short, turn-scoped retention lease.
 *
 * Retention here is a SELECTION HINT, never an authority grant. Every helper
 * in this module only decides what tool schemas are SHOWN to the mind on its
 * next prompt. The capability/`granted` gate in cosToolRegistry.js runs
 * independently at both selection and execution time, so a lease can never
 * widen what the mind is allowed to do — a revoked capability drops a leased
 * tool immediately regardless of anything recorded here.
 */

import { z } from 'zod';

// Families mirror the existing capability/scope groupings already declared
// per tool in cosToolRegistry.js (the precedent is TOOL_GROUPS/GROUP_INTENT
// in server/services/voice/tools.js) — no new vocabulary.
export const TOOL_ACTIVATION_FAMILIES = Object.freeze(['tasks', 'issues', 'mind', 'eidoverse', 'recipes', 'voice']);

export const TOOL_ACTIVATION_LIMITS = Object.freeze({
  MIN_RETENTION_TURNS: 0,
  MAX_RETENTION_TURNS: 20,
});

// 0 is deliberately "one-turn behaviour": activating a family only expands it
// for the turn that activated it, with nothing persisted for the next one.
export const DEFAULT_TOOL_ACTIVATION_RETENTION_TURNS = 3;

export const toolActivationFamilySchema = z.enum(TOOL_ACTIVATION_FAMILIES);

export const toolsActivateInputSchema = z.object({
  families: z.array(toolActivationFamilySchema).min(1).max(TOOL_ACTIVATION_FAMILIES.length),
}).strict();

export const toolsDeactivateInputSchema = z.object({
  // Omitted clears every currently-selected/leased family.
  families: z.array(toolActivationFamilySchema).min(1).max(TOOL_ACTIVATION_FAMILIES.length).optional(),
}).strict();

const isValidFamily = (value) => TOOL_ACTIVATION_FAMILIES.includes(value);
// A lease VALUE of 0 is meaningful — it means "this is the family's last
// turn, still fully exposed" (see agePersistentMindToolActivation) — so
// stored leases accept zero. Only a fresh ACTIVATION (below) requires a
// strictly positive retention count; activating with 0 persists nothing.
const isNonNegativeInt = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositiveInt = (value) => Number.isSafeInteger(value) && value > 0;

export function createDefaultPersistentMindToolActivation() {
  return { leases: {}, lastAgedTurnId: null };
}

/** Normalize hand-edited or legacy state: unknown families and negative/non-integer counts are dropped. */
export function normalizePersistentMindToolActivation(raw) {
  const leases = {};
  const source = raw?.leases;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const family of TOOL_ACTIVATION_FAMILIES) {
      if (isNonNegativeInt(source[family])) leases[family] = source[family];
    }
  }
  const lastAgedTurnId = typeof raw?.lastAgedTurnId === 'string' && raw.lastAgedTurnId.trim()
    ? raw.lastAgedTurnId.trim().slice(0, 200)
    : null;
  return { leases, lastAgedTurnId };
}

/**
 * Age every existing lease by exactly one USER turn. Call this at most once
 * per user turn — never per tool-round loop within a single turn, or a
 * multi-step sequence would lose its own tools mid-flow — and never at all
 * for a self-directed wake.
 *
 * A family already at 0 (its floor, set by a PRIOR aging pass) is dropped:
 * that prior turn was its last one. Everything else decrements with a floor
 * of 0 rather than being deleted immediately, so a family that just reached
 * its floor THIS aging pass stays present — and therefore still exposed —
 * for every remaining tool-round rebuild within the turn being aged, not
 * only the first one.
 */
export function agePersistentMindToolActivation(leases) {
  const normalized = normalizePersistentMindToolActivation({ leases }).leases;
  const nextLeases = {};
  for (const [family, turnsLeft] of Object.entries(normalized)) {
    if (turnsLeft <= 0) continue;
    nextLeases[family] = Math.max(turnsLeft - 1, 0);
  }
  return { leases: nextLeases };
}

/**
 * Activate one or more families for a fresh `retentionTurns`-turn window.
 * `retentionTurns <= 0` persists nothing — the family is still exposed for
 * whatever turn calls this (the caller re-reads `leases` afterward), but
 * ages away immediately rather than surviving into the next user turn.
 */
export function activatePersistentMindToolActivationFamilies(leases, families, retentionTurns) {
  const normalized = normalizePersistentMindToolActivation({ leases }).leases;
  const next = { ...normalized };
  if (isPositiveInt(retentionTurns)) {
    for (const family of Array.isArray(families) ? families : []) {
      if (isValidFamily(family)) next[family] = retentionTurns;
    }
  }
  return next;
}

/**
 * Renew a single family's lease back to the full retention window because a
 * tool from it was just used — extending only the family actually exercised,
 * never every family the turn happens to have activated.
 */
export function renewPersistentMindToolActivationFamily(leases, family, retentionTurns) {
  return activatePersistentMindToolActivationFamilies(leases, [family], retentionTurns);
}

/** Clear one or more families (or all, when `families` is omitted/empty) — tools.deactivate. */
export function deactivatePersistentMindToolActivationFamilies(leases, families) {
  const normalized = normalizePersistentMindToolActivation({ leases }).leases;
  if (!Array.isArray(families) || families.length === 0) return {};
  const next = { ...normalized };
  for (const family of families) delete next[family];
  return next;
}
