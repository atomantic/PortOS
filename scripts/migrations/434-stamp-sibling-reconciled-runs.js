/**
 * Stamp `usageSiblingsReconciled` on runs reconciled live after the sibling scan
 * was introduced in #5831, and add them to `usage.json`'s `siblingReconciledRuns`.
 *
 * Background (#12665):
 * Since #5831 (shipped in v2.57.0), `recordCompletedRunUsage` has scanned sibling
 * families (nested `--review-with` CLI sessions like grok, antigravity, kimi)
 * whenever a provider list was available. Until PR #12664, however, it stamped
 * only `usageReconciled` / `reconciledRuns` and never stamped
 * `usageSiblingsReconciled` / `siblingReconciledRuns`.
 *
 * Runs reconciled live before PR #12664 therefore carry no sibling marker.
 * When a historical backfill (`scanHistoricalUsage`) runs on an install where
 * the in-process claim ledger was reset by a restart or 48h retention prune,
 * those runs are treated as sibling-pending, re-reading their windows and
 * adding nested sessions to the sibling provider's bucket a second time.
 *
 * Fix:
 * Distinguish pre-#5831 from post-#5831 runs by `usageReconciledAt`. Runs reconciled
 * on or after the #5831 merge (2026-09-03T06:29:51.000Z) already had their siblings
 * scanned by the live path, so stamp `usageSiblingsReconciled: true` on their
 * run metadata and add them to `usage.json`'s `siblingReconciledRuns`. Runs
 * reconciled before that timestamp are left sibling-pending so a historical
 * backfill will attribute their nested sessions once.
 *
 * Input-gated and idempotent: returns early if neither `usage.json` nor
 * `data/runs` exists, and re-running produces no changes.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonOrNull, writeJsonAtomic } from './_lib.js';

// Commit b862954842 / PR #6035 fixing #5831 merged into main at 2026-09-03T06:29:51Z;
// released in tag v2.57.0 at 2026-09-03T14:36:44Z.
export const SIBLING_SCAN_SHIPPED_AT = '2026-09-03T06:29:51.000Z';

export default {
  async up({ rootDir }) {
    const usagePath = join(rootDir, 'data', 'usage.json');
    const runsDir = join(rootDir, 'data', 'runs');

    const usage = await readJsonOrNull(usagePath);
    const runEntries = await readdir(runsDir, { withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });

    if (!usage && runEntries.length === 0) {
      return { stampedRuns: 0, stampedUsageRuns: 0 };
    }

    const cutoffMs = Date.parse(SIBLING_SCAN_SHIPPED_AT);
    let stampedRuns = 0;
    let stampedUsageRuns = 0;
    let usageChanged = false;

    if (usage && typeof usage === 'object') {
      usage.reconciledRuns ??= {};
      usage.siblingReconciledRuns ??= {};
      for (const [runId, reconciledAt] of Object.entries(usage.reconciledRuns)) {
        if (usage.siblingReconciledRuns[runId]) continue;
        const ms = Date.parse(reconciledAt);
        if (Number.isFinite(ms) && ms >= cutoffMs) {
          usage.siblingReconciledRuns[runId] = reconciledAt;
          stampedUsageRuns++;
          usageChanged = true;
        }
      }
    }

    for (const entry of runEntries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      const metadataPath = join(runsDir, runId, 'metadata.json');
      const metadata = await readJsonOrNull(metadataPath);
      if (!metadata || typeof metadata !== 'object') continue;

      const isParentReconciled = metadata.usageReconciled === true
        || Boolean(usage?.reconciledRuns?.[runId]);
      if (!isParentReconciled) continue;
      if (metadata.usageSiblingsReconciled === true) continue;

      const reconciledAt = metadata.usageReconciledAt || usage?.reconciledRuns?.[runId];
      if (!reconciledAt) continue;
      const ms = Date.parse(reconciledAt);
      if (!Number.isFinite(ms) || ms < cutoffMs) continue;

      metadata.usageSiblingsReconciled = true;
      metadata.usageSiblingsReconciledAt = metadata.usageSiblingsReconciledAt || reconciledAt;
      await writeJsonAtomic(metadataPath, metadata);
      stampedRuns++;

      if (usage && !usage.siblingReconciledRuns[runId]) {
        usage.siblingReconciledRuns[runId] = metadata.usageSiblingsReconciledAt;
        stampedUsageRuns++;
        usageChanged = true;
      }
    }

    if (usageChanged) {
      await writeJsonAtomic(usagePath, usage);
    }

    if (stampedRuns > 0 || stampedUsageRuns > 0) {
      console.log(`📊 Migration 434: stamped sibling reconciliation on ${stampedRuns} run metadata file(s) and ${stampedUsageRuns} usage.json entry/entries`);
    }

    return { stampedRuns, stampedUsageRuns };
  }
};
