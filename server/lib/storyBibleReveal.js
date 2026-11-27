/** Normalize reveal timing and scope canon for drafting prompts, editorial checks, and browser badges. */

import { BIBLE_LIMITS } from './bibleLimits.js';
import { shortCanonPrimaryField } from './canonPrompt.js';
import { isStr, trimTo } from './textUtils.js';
import { BIBLE_FIELD, BIBLE_KEYS, BIBLE_KIND, BIBLE_KINDS } from './universeCanon.js';

// Canon context is injected into every issue's drafting prompt, so a character
// secret or late-story fact could leak into the prose long before it's due.
// A canon entry can carry a reveal gate:
//   - `revealIssue` (int)  — the entry's fact is hidden from any issue numbered
//     BEFORE this. At/after it, the entry is fully visible.
//   - `spoiler: true`      — a hard gate with no specific issue: excluded from
//     ALL drafting context (autonovel's "MYSTERY.md is not for drafting").
//   - `surfaceDescriptor`  — the pre-reveal stand-in. When present on a gated
//     entry, the entry is KEPT in context but reduced to a spoiler-free surface
//     view (identity + surfaceDescriptor only). When absent, the gated entry is
//     dropped from context entirely.
//
// Absent gate fields = always visible — every pre-#2178 entry round-trips
// unchanged. The JUDGE (#2167) and editorial checks receive the FULL canon:
// this filter is ONLY for the writer-facing drafting/revision context.

// Normalize a reveal-issue gate to a positive integer or null. Accepts a
// finite number or a numeric string (LLM/JSON both occur); a 0/negative/
// non-integer/over-cap value collapses to null (no gate). Null = the entry is
// always visible — the backward-compatible default for every existing canon
// entry that predates reveal gating (#2178).
export function ensureRevealIssue(raw) {
  const n = typeof raw === 'number' ? raw : (isStr(raw) && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > BIBLE_LIMITS.REVEAL_ISSUE_MAX) return null;
  return n;
}

// The field a surface view replaces with `surfaceDescriptor` is the kind's
// SHORT primary descriptor — sourced from canonPrompt's SHORT_SPEC via
// `shortCanonPrimaryField` so there's no parallel per-kind map to drift.

// True when an entry carries ANY reveal gate (a hard `spoiler` flag or a valid
// numeric `revealIssue`) — the shared predicate behind `canonHasRevealGated`,
// `revealGatedCanonRows`, and the client badge. Issue-agnostic: use
// `isCanonEntryGatedForIssue` when you need "gated FOR this issue".
export function isEntryRevealGated(entry) {
  return !!entry && (entry.spoiler === true || ensureRevealIssue(entry.revealIssue) != null);
}

/**
 * True when a canon entry is reveal-gated for the given issue number:
 * a hard `spoiler` flag, OR a `revealIssue` the issue hasn't reached yet.
 * A non-finite/absent `issueNumber` is treated as "unknown position" and only
 * the hard `spoiler` flag gates (a numeric reveal gate can't be evaluated
 * without knowing which issue we're drafting).
 */
export function isCanonEntryGatedForIssue(entry, issueNumber) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.spoiler === true) return true;
  const reveal = ensureRevealIssue(entry.revealIssue);
  if (reveal == null) return false;
  const n = typeof issueNumber === 'number' ? issueNumber : Number(issueNumber);
  if (!Number.isFinite(n)) return false;
  return n < reveal;
}

/**
 * Reduce a gated entry to its spoiler-free surface view: identity fields plus
 * the `surfaceDescriptor` substituted into the kind's primary descriptor
 * field. Every other narrative/prose field is dropped so no spoiler-bearing
 * text (background, significance, motivations, …) leaks through. Returns null
 * when the entry has no `surfaceDescriptor` — the caller drops it from context.
 */
function surfaceCanonEntry(kind, entry) {
  const surface = trimTo(entry?.surfaceDescriptor, BIBLE_LIMITS.SURFACE_DESCRIPTOR_MAX);
  if (!surface) return null;
  const descField = shortCanonPrimaryField(kind);
  const out = {
    id: entry.id,
    name: entry.name || '',
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
    // Preserve the identity/continuity keys a matcher or roster needs, but
    // nothing that carries the secret.
    ...(kind === 'character' && entry.role ? { role: entry.role } : {}),
    ...(kind === 'place' && entry.slugline ? { slugline: entry.slugline } : {}),
    // Flag so any downstream renderer / debugging can tell this is a masked view.
    surfaced: true,
  };
  if (descField) out[descField] = surface;
  return out;
}

/**
 * Filter one kind's canon list for a drafting/revision prompt at `issueNumber`.
 * Ungated entries pass through untouched; gated entries with a
 * `surfaceDescriptor` are reduced to their surface view; gated entries without
 * one are dropped. Pure — returns a new array, never mutates the input.
 */
export function filterCanonListForIssue(list, kind, issueNumber) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (!isCanonEntryGatedForIssue(entry, issueNumber)) {
      out.push(entry);
      continue;
    }
    const surfaced = surfaceCanonEntry(kind, entry);
    if (surfaced) out.push(surfaced);
    // else: no surface stand-in → hidden from drafting context entirely.
  }
  return out;
}

/**
 * Filter a whole `{ characters, places, objects }` canon bundle for a drafting
 * prompt at `issueNumber`. Returns a NEW bundle with each list reveal-filtered;
 * a nullish canon returns empty lists. Used by `buildStageContext` and the
 * revision-loop cast builder — NOT by the editorial checks (they get full canon).
 */
export function filterCanonForIssue(canon, issueNumber) {
  return {
    characters: filterCanonListForIssue(canon?.characters, 'character', issueNumber),
    places: filterCanonListForIssue(canon?.places, 'place', issueNumber),
    objects: filterCanonListForIssue(canon?.objects, 'object', issueNumber),
  };
}

/**
 * True when ANY entry across a `{ characters, places, objects }` canon bundle
 * carries a reveal gate (a `revealIssue` or a `spoiler` flag). The
 * `continuity.premature-reveal` editorial check gates on this so it never fires
 * on a series that authored no reveal-gated canon.
 */
export function canonHasRevealGated(canon) {
  for (const key of BIBLE_KEYS) {
    const list = canon?.[key];
    if (Array.isArray(list) && list.some(isEntryRevealGated)) return true;
  }
  return false;
}

// The spoiler-bearing narrative fields per kind whose content the
// premature-reveal prompt names as "the gated fact" (what a leak looks like).
// Keyed by BIBLE_KIND so a future kind added to the enum surfaces here.
const SECRET_FIELDS_BY_KIND = Object.freeze({
  [BIBLE_KIND.CHARACTER]: ['physicalDescription', 'personality', 'background', 'motivations', 'specialTraits'],
  [BIBLE_KIND.PLACE]: ['description', 'recurringDetails'],
  [BIBLE_KIND.OBJECT]: ['description', 'significance'],
});

/**
 * Enumerate every reveal-gated canon entry across a bundle as a compact row
 * `{ kind, name, revealIssue, spoiler, surfaceDescriptor, fact }` for the
 * `continuity.premature-reveal` prompt. `fact` is the spoiler content the prose
 * must NOT reveal early — the kind's primary descriptor plus the deeper
 * narrative field so the model knows what "leaked" looks like. Pure.
 */
export function revealGatedCanonRows(canon) {
  const rows = [];
  // Iterate kinds via BIBLE_KIND → BIBLE_FIELD (kind → plural key) so the
  // kind↔key mapping stays derived from the module's single source of truth.
  for (const kind of BIBLE_KINDS) {
    const list = canon?.[BIBLE_FIELD[kind]];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!isEntryRevealGated(e)) continue;
      const fact = SECRET_FIELDS_BY_KIND[kind]
        .map((f) => trimTo(e[f], 600))
        .filter(Boolean)
        .join(' — ');
      rows.push({
        kind,
        name: trimTo(e.name, BIBLE_LIMITS.NAME_MAX) || '(unnamed)',
        revealIssue: ensureRevealIssue(e.revealIssue),
        spoiler: e.spoiler === true,
        surfaceDescriptor: trimTo(e.surfaceDescriptor, BIBLE_LIMITS.SURFACE_DESCRIPTOR_MAX) || null,
        fact,
      });
    }
  }
  return rows;
}
