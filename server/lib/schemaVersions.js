/**
 * PortOS schema-version contract for cross-instance sync.
 *
 * Two PortOS instances that exchange data (federated peer push, snapshot
 * sync, share-bucket manifests) need a way to detect a version mismatch
 * BEFORE applying records the receiver can't parse. Without this, an
 * upgraded sender silently corrupts a downstream peer whose code doesn't
 * yet understand a new storage layout.
 *
 * `PORTOS_SCHEMA_VERSIONS` is the per-sync-category contract. Each entry is
 * the type-level storage layout version the running code expects to read +
 * write. When a category bumps its version (e.g. universes 4→5 splitting
 * out of the monolithic JSON), update the number here AND ship the
 * corresponding `scripts/migrations/NNN-…js`. The number flows through
 * every outbound payload's `portosMeta.schemaVersions`; receivers compare
 * incoming vs local and reject ahead-mismatches (sender too new) or
 * behind-mismatches (sender too old to satisfy a forward-only field).
 *
 * Absent categories default to 0 — the comparator treats 0 as "no check"
 * so historical / un-versioned data categories pass through unchanged.
 * Future PRs that introduce a layout change for `series`, `issues`, etc.
 * add an entry here.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from './fileUtils.js';

export const PORTOS_SCHEMA_VERSIONS = Object.freeze({
  // Type-level (storage layout) version for `data/universes/{id}/index.json`.
  // v5 = post-split. Migration 034 introduced it. The per-record-shape version
  // stays at 4 (stamped inside each record by `sanitizeTemplate`).
  universes: 5,
  // v1 = post-split. Migrations 035/036 introduced the pipeline collection
  // layout for issues and series.
  pipelineIssues: 1,
  pipelineSeries: 1,
  mediaCollections: 1,
});

/**
 * Lazy-read the current PortOS version from the ROOT package.json so a
 * pull-and-restart picks it up without a process-relative cache.
 *
 * Tested-without-files fallback: when PATHS.root is mutated for a test to
 * a directory without package.json, return '0.0.0' instead of throwing.
 * Mirrors `getCurrentVersion` in `server/services/updateChecker.js`.
 */
export async function getPortosVersion() {
  const pkgPath = join(PATHS.root, 'package.json');
  const raw = await readFile(pkgPath, 'utf-8').catch(() => null);
  if (!raw) return '0.0.0';
  const parsed = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  return typeof parsed?.version === 'string' && parsed.version ? parsed.version : '0.0.0';
}

/**
 * Build the `portosMeta` envelope that every outbound sync payload carries
 * at the top level. Receivers feed `meta.schemaVersions` into
 * `compareSchemaVersions(sender, PORTOS_SCHEMA_VERSIONS)` to decide whether
 * to apply the payload.
 *
 *   {
 *     "portosMeta": {
 *       "portosVersion": "2.7.0",
 *       "schemaVersions": { "universes": 5 }
 *     }
 *   }
 *
 * `portosVersion` is informational — for UI surfacing only. The gate logic
 * runs on `schemaVersions` because the on-disk shape is what matters; the
 * PortOS version is just a friendly label users recognize.
 */
export async function buildPortosMeta(overrides = {}) {
  const portosVersion = await getPortosVersion();
  return {
    portosVersion,
    schemaVersions: { ...PORTOS_SCHEMA_VERSIONS, ...(overrides.schemaVersions || {}) },
  };
}

/**
 * Compare a peer's schemaVersions against the local code's expectations.
 *
 * Returns a structured diff so callers (push-rejection, UI surfacing) can
 * tell users WHICH category is mismatched and in which direction.
 *
 *   ahead[]  — categories where the SENDER has a newer schema than the
 *              RECEIVER. The receiver can't safely apply the payload; reject.
 *   behind[] — categories where the SENDER is older than the receiver. The
 *              sanitizer can usually backfill, but some forward-only
 *              contracts may still require the sender to upgrade. Callers
 *              decide whether to gate.
 *
 *   compatible — `true` only when neither list has entries.
 *
 * Absent or zero entries on either side are treated as "no contract" — the
 * comparator skips them. So legacy peers that don't send `portosMeta` at
 * all simply pass through (treat their schemaVersions as `{}` → no
 * `ahead` entries → compatible).
 */
export function compareSchemaVersions(senderVersions = {}, receiverVersions = PORTOS_SCHEMA_VERSIONS) {
  const sender = senderVersions && typeof senderVersions === 'object' ? senderVersions : {};
  const receiver = receiverVersions && typeof receiverVersions === 'object' ? receiverVersions : {};
  const ahead = [];
  const behind = [];
  // Walk the UNION of keys so we catch (a) sender has a category receiver
  // doesn't know (sender ahead), AND (b) receiver requires a category the
  // sender doesn't carry (sender behind on that category).
  const keys = new Set([
    ...Object.keys(sender),
    ...Object.keys(receiver),
  ]);
  for (const cat of keys) {
    const senderV = Number.isInteger(sender[cat]) ? sender[cat] : 0;
    const receiverV = Number.isInteger(receiver[cat]) ? receiver[cat] : 0;
    if (senderV === 0 && receiverV === 0) continue;          // no contract on either side
    if (senderV === receiverV) continue;                      // exact match
    if (senderV > receiverV) ahead.push({ category: cat, senderV, receiverV });
    else behind.push({ category: cat, senderV, receiverV });
  }
  return { ahead, behind, compatible: ahead.length === 0 && behind.length === 0 };
}

/**
 * Human-readable explanation of a comparator result. Used both for log lines
 * and for the UI badge tooltip. Keeps the wording in one place so a peer-
 * sync 409 message, the Instances UI, and the share-bucket panel all
 * describe the gap identically.
 *
 *   formatVersionGap({ ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }] })
 *     → 'sender ahead of receiver on universes (v5 vs v4)'
 */
export function formatVersionGap({ ahead = [], behind = [] } = {}) {
  const parts = [];
  if (ahead.length) {
    parts.push(`sender ahead of receiver on ${ahead.map((g) => `${g.category} (v${g.senderV} vs v${g.receiverV})`).join(', ')}`);
  }
  if (behind.length) {
    parts.push(`sender behind receiver on ${behind.map((g) => `${g.category} (v${g.senderV} vs v${g.receiverV})`).join(', ')}`);
  }
  return parts.join('; ') || 'compatible';
}
