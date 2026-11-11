/**
 * Add Codex Fast/Ultrafast premiums for sessions whose base tokens are already
 * in the ledger. The native usage store is what the Usage page prices; this
 * repair covers pre-coverage days, estimates, and raw-ledger readers.
 *
 * The plan never rewrites base token counts. Owed speed is the covered subset
 * through the token high-water minus speed that boundary already accounts.
 * A session with no high-water is skipped: its base was never billed, and a
 * premium alone would invent a charge. The repair id is the same one a first
 * full bill records, so the two paths cannot both add the premium.
 */

import { copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { SPEED_LEDGER_FIELDS } from '../lib/modelPricing.js';
import { familyForProvider } from '../lib/providerFamilies.js';
import { parseCodexRollout } from '../lib/providerTranscriptUsage.js';
import { codexIdentityHash, codexSessionClaimKey, readCodexAccountingSources } from './codexUsageSources.js';
import { addDatedUsageBatch, getUsage, loadUsage } from './usage.js';

const TOKEN_FIELDS = ['messages', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens'];
const INDEXING_PASSES = 20;

function mergeBoundary(existing, value) {
  const merged = {};
  for (const field of TOKEN_FIELDS) merged[field] = Math.max(existing?.[field] || 0, value?.[field] || 0);
  for (const field of SPEED_LEDGER_FIELDS) {
    const amount = Math.max(existing?.[field] || 0, value?.[field] || 0);
    if (amount) merged[field] = amount;
  }
  return merged;
}

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
      merged.set(entry[0], mergeBoundary(merged.get(entry[0]), entry[1]));
    }
  }
  return merged;
}

function boundaryForSession(session, highWater) {
  let billed = highWater.get(codexSessionClaimKey(session.id)) || null;
  for (const [key, counts] of highWater) {
    const legacyId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i.exec(key)?.[1];
    if (session.paths?.includes(key) || (legacyId && codexIdentityHash(legacyId) === session.id)) {
      billed = mergeBoundary(billed, counts);
    }
  }
  return billed;
}

function owedSpeed(covered, billed) {
  const owed = {};
  let any = false;
  for (const field of SPEED_LEDGER_FIELDS) {
    const amount = Math.max(0, (covered?.[field] || 0) - (billed?.[field] || 0));
    if (!amount) continue;
    owed[field] = amount;
    any = true;
  }
  return any ? owed : null;
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
  for (const session of inventory?.sessions || []) {
    const repairId = `codex-speed:v1:${session.id}`;
    if (known.has(repairId)) continue;
    const billed = boundaryForSession(session, highWater);
    // No high-water means the base tokens are not in the ledger.
    if (!billed) continue;
    let records = null;
    try {
      records = await session.loadRecords();
    } catch {
      continue;
    }
    const parsed = parseCodexRollout(records, { billedBaseline: billed, includeCoveredSpeed: true });
    const owed = owedSpeed(parsed.coveredSpeed, billed);
    if (!owed) continue;
    const ms = Date.parse(parsed.frontierTs || '');
    if (!Number.isFinite(ms)) continue;
    known.add(repairId);
    additions.push({
      repairId,
      day: new Date(ms).toISOString().slice(0, 10),
      record: {
        providerId,
        model: parsed.model || null,
        messages: 0,
        ...owed,
        source: 'measured',
      },
    });
  }
  return { additions, notes };
}

function summarizeCodexSpeedRepair(additions = []) {
  return { added: additions.length, sessions: additions.length };
}

async function backupLedger(dataDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(dataDir, 'backups', `codex-speed-${stamp}`);
  await mkdir(dest, { recursive: true });
  try {
    await copyFile(join(dataDir, 'usage.json'), join(dest, 'usage.json'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return dest;
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
  await loadUsage();
  const usage = getUsage();
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
  const backupDir = await backupLedger(dataDir);
  const written = await addDatedUsageBatch(plan.additions);
  return { ...summarizeCodexSpeedRepair(written), backedUp: true, note, backupDir };
}
