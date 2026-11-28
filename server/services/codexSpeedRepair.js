/**
 * Add Codex Fast/Ultrafast premiums for sessions whose base tokens are already
 * in the ledger. The native usage store is what the Usage page prices; this
 * repair covers pre-coverage days, estimates, and raw-ledger readers.
 *
 * The plan never rewrites base token counts. Owed speed is the subset inside
 * the token high-water, dated on the UTC day of each snapshot, minus speed
 * the boundary already accounts. A reconcile bills the growth past the
 * previous mark and then advances that mark, so the speed it stored is the
 * tail of what the next repair covers. The credit comes off the latest days;
 * taking it from the earliest day would drop the historical premium a legacy
 * mark never stored. A session with no high-water is skipped: its base was
 * never billed, and a premium alone would invent a charge. A first full bill
 * records one session id; each repaired day records its own, so the two paths
 * cannot both add the same premium.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { mergeCodexBoundary, SPEED_LEDGER_FIELDS } from '../lib/usageFields.js';
import { familyForProvider } from '../lib/provider/providerFamilies.js';
import { parseCodexRollout } from '../lib/provider/providerTranscriptUsage.js';
import { codexSpeedRepairId, readCodexAccountingSources, resolveCodexBoundary } from './codexUsageSources.js';
import { addDatedUsageBatch, backupUsageRepairLedger, loadUsage } from './usage.js';

const INDEXING_PASSES = 20;

/** CLI, then TUI, then any Codex family record, else the id `codex`. */
function codexUsageProviderIdFromList(providers) {
  const codex = (providers || []).filter((provider) => (
    provider && provider.enabled !== false && familyForProvider(provider) === 'codex'
  ));
  const preferred = codex.find((provider) => provider.type === 'cli')
    || codex.find((provider) => provider.type === 'tui')
    || codex[0];
  return preferred?.id || 'codex';
}

function highWaterMap(reconciledRuns) {
  const merged = new Map();
  for (const marker of Object.values(reconciledRuns || {})) {
    if (!Array.isArray(marker?.codexHighWater)) continue;
    for (const entry of marker.codexHighWater) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[1] || typeof entry[1] !== 'object') continue;
      merged.set(entry[0], mergeCodexBoundary(merged.get(entry[0]), entry[1]));
    }
  }
  return merged;
}

function owedSpeed(covered) {
  const owed = {};
  let any = false;
  for (const field of SPEED_LEDGER_FIELDS) {
    const amount = covered?.[field] || 0;
    if (!amount) continue;
    owed[field] = amount;
    any = true;
  }
  return any ? owed : null;
}

function coveredDays(parsed) {
  const dated = (parsed.coveredSpeedDays || [])
    .filter((slice) => typeof slice?.day === 'string' && owedSpeed(slice));
  if (dated.length) return dated;
  const ms = Date.parse(parsed.frontierTs || '');
  if (!Number.isFinite(ms) || !owedSpeed(parsed.coveredSpeed)) return [];
  return [{ day: new Date(ms).toISOString().slice(0, 10), ...parsed.coveredSpeed }];
}

/** Boundary speed is a suffix of the covered premium. Leave the unpaid prefix. */
function unpaidCoveredDays(slices, billed) {
  const remaining = Object.fromEntries(SPEED_LEDGER_FIELDS.map((field) => [field, billed?.[field] || 0]));
  const rows = slices.map((slice) => ({ ...slice }));
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    for (const field of SPEED_LEDGER_FIELDS) {
      const have = rows[index][field] || 0;
      const credit = remaining[field] || 0;
      if (!have || !credit) continue;
      const take = Math.min(have, credit);
      rows[index][field] = have - take;
      remaining[field] = credit - take;
    }
  }
  return rows.filter((slice) => owedSpeed(slice));
}

/**
 * @param {{ home?: string, repairIds?: string[], reconciledRuns?: object, providerId?: string }} input
 * @returns {Promise<{ additions: object[], notes: string[] }>}
 */
async function planCodexSpeedRepair({
  home = homedir(),
  repairIds = [],
  reconciledRuns = {},
  providerId = 'codex',
} = {}) {
  const known = new Set(repairIds.filter((id) => typeof id === 'string' && id));
  const highWater = highWaterMap(reconciledRuns);
  let inventory = null;
  for (let pass = 0; pass < INDEXING_PASSES; pass += 1) {
    inventory = await readCodexAccountingSources({ home });
    if (!inventory?.coverage?.issues?.indexing_pending) break;
  }
  const additions = [];
  const notes = [];
  if (inventory?.coverage?.issues?.indexing_pending) {
    notes.push('Codex speed repair read only part of the session archive. Unread sessions were left for the next reconcile.');
  }
  // An unverified coarse-timestamp file could be a conflicting copy of any
  // resolved session. A dated repair id would prevent revisiting that charge.
  if (inventory?.unverifiedCoarseSources) {
    return { additions, notes: ['Codex speed repair deferred while some coarse-timestamp sources could not be verified.'] };
  }
  for (const session of inventory?.sessions || []) {
    // A first full bill records this id once it has priced the whole session.
    if (known.has(codexSpeedRepairId(session.id))) continue;
    const billed = resolveCodexBoundary(session, highWater);
    // No high-water means the base tokens are not in the ledger.
    if (!billed) continue;
    let records = null;
    try {
      records = await session.loadRecords();
    } catch {
      continue;
    }
    const parsed = parseCodexRollout(records, { billedBaseline: billed, includeCoveredSpeed: true });
    for (const slice of unpaidCoveredDays(coveredDays(parsed), billed)) {
      const repairId = codexSpeedRepairId(session.id, slice.day);
      if (known.has(repairId)) continue;
      const owed = owedSpeed(slice);
      if (!owed) continue;
      known.add(repairId);
      additions.push({
        repairId,
        day: slice.day,
        record: {
          providerId,
          model: parsed.model || null,
          messages: 0,
          ...owed,
          source: 'measured',
        },
      });
    }
  }
  return { additions, notes };
}

function summarizeCodexSpeedRepair(additions = []) {
  const sessions = new Set(additions.map((item) => String(item.repairId || '').replace(/:\d{4}-\d{2}-\d{2}$/, '')));
  sessions.delete('');
  return { added: additions.length, sessions: sessions.size };
}

/**
 * Plan against the in-memory repair ids and add any missing speed rows.
 * Writes only PATHS.data. Does not refresh the native usage store.
 */
export async function applyCodexSpeedRepair({
  home = homedir(),
  dataDir = PATHS.data,
  providers = null,
  providerId = null,
} = {}) {
  if (resolve(dataDir) !== resolve(PATHS.data)) {
    throw new Error('Codex speed repair refuses to write outside the usage ledger');
  }
  const usage = await loadUsage({ includeRepairEvidence: true });
  const plan = await planCodexSpeedRepair({
    home,
    repairIds: usage.grokRepairIds || [],
    reconciledRuns: usage.reconciledRuns || {},
    providerId: providerId || codexUsageProviderIdFromList(providers || []),
  });
  const note = plan.notes[0] || null;
  if (plan.additions.length === 0) {
    return { ...summarizeCodexSpeedRepair([]), backedUp: false, note, backupDir: null };
  }
  const backupDir = await backupUsageRepairLedger(dataDir, 'codex-speed');
  const written = await addDatedUsageBatch(plan.additions);
  return { ...summarizeCodexSpeedRepair(written), backedUp: true, note, backupDir };
}
