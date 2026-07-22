import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureDir, PATHS, safeJSONParse, tryReadFile, atomicWrite } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';

const ACCOUNTS_FILE = join(PATHS.messages, 'accounts.json');

async function loadAccounts() {
  await ensureDir(PATHS.messages);
  const content = await tryReadFile(ACCOUNTS_FILE);
  if (!content) return {};
  const parsed = safeJSONParse(content, {}, { context: 'messageAccounts' });
  return isPlainObject(parsed) ? parsed : {};
}

async function saveAccounts(accounts) {
  await ensureDir(PATHS.messages);
  await atomicWrite(ACCOUNTS_FILE, accounts);
}

export async function listAccounts() {
  const accounts = await loadAccounts();
  return Object.values(accounts).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAccount(id) {
  const accounts = await loadAccounts();
  return accounts[id] || null;
}

export async function createAccount(data) {
  const accounts = await loadAccounts();
  const id = uuidv4();
  accounts[id] = {
    id,
    name: data.name,
    type: data.type, // gmail, outlook, teams
    provider: data.type === 'gmail' ? 'api' : 'playwright',
    email: data.email || '',
    enabled: true,
    syncConfig: {
      maxAge: data.syncConfig?.maxAge || '30d',
      maxMessages: data.syncConfig?.maxMessages || 500,
      syncInterval: data.syncConfig?.syncInterval || 300000,
      // Ingest sent mail into the human-activity timeline as `message.sent` events
      // so Tribe-outreach reply detection can see a thread as answered (#2796).
      // Only Gmail has a sent-fetch path today; default it on there, off elsewhere.
      // Absent (existing accounts) is treated as on for Gmail by the readers, so a
      // migration isn't needed — this only makes new accounts' stored state explicit.
      ingestSent: data.syncConfig?.ingestSent ?? (data.type === 'gmail')
    },
    // Gmail send-as alias addresses (#2831), refreshed on each sync. Owner addresses
    // beyond the primary `email`; used to exclude the owner from received-message
    // participants so a 1:1 email delivered to an alias isn't misread as a group thread.
    // Additive/back-compat: existing accounts lack the key and readers treat absent as [].
    sendAsAliases: [],
    lastSyncAt: null,
    lastSyncStatus: null,
    createdAt: new Date().toISOString()
  };
  await saveAccounts(accounts);
  console.log(`📧 Message account created: ${data.name} (${data.type})`);
  return accounts[id];
}

export async function updateAccount(id, updates) {
  const accounts = await loadAccounts();
  if (!accounts[id]) return null;
  const { name, email, enabled, syncConfig } = updates;
  if (name !== undefined) accounts[id].name = name;
  if (email !== undefined) accounts[id].email = email;
  if (enabled !== undefined) accounts[id].enabled = enabled;
  if (syncConfig) accounts[id].syncConfig = { ...accounts[id].syncConfig, ...syncConfig };
  accounts[id].updatedAt = new Date().toISOString();
  await saveAccounts(accounts);
  return accounts[id];
}

export async function deleteAccount(id) {
  const accounts = await loadAccounts();
  if (!accounts[id]) return false;
  delete accounts[id];
  await saveAccounts(accounts);
  console.log(`🗑️ Message account deleted: ${id}`);
  return true;
}

// Persist the account's Gmail send-as aliases (#2831), refreshed opportunistically on
// each successful sync. Owner addresses beyond the primary `email`; consumed by
// `messageActivityCandidates` to exclude ALL owner addresses (not just the primary)
// from received-message participants. Lowercased + deduped; absent → [] for readers.
export async function updateSendAsAliases(id, aliases = []) {
  const accounts = await loadAccounts();
  if (!accounts[id]) return null;
  accounts[id].sendAsAliases = Array.isArray(aliases)
    ? [...new Set(aliases.map((a) => String(a || '').trim().toLowerCase()).filter(Boolean))]
    : [];
  await saveAccounts(accounts);
  return accounts[id];
}

export async function updateSyncStatus(id, status) {
  const accounts = await loadAccounts();
  if (!accounts[id]) return null;
  accounts[id].lastSyncAt = new Date().toISOString();
  accounts[id].lastSyncStatus = status;
  await saveAccounts(accounts);
  return accounts[id];
}

// Stamp the reply-detection watermark (#2796): the last time this account
// successfully ingested sent mail into the activity timeline. The Tribe-outreach
// detector trusts an account as two-way only when this is set and recent, so an
// account is never trusted before its sent history actually exists.
//
// `partial` (#2820) records whether the sent window was FULLY covered this sync.
// When the sent pass truncates at its ceiling (>SENT_INGEST_MAX sent in the
// window) coverage is incomplete, so the detector must NOT trust this account's
// reply evidence — `sentCoveragePartial:true` drops it from the two-way set for
// the scan (fail closed). A later full sync clears it back to false.
export async function markSentIngested(id, { at = new Date().toISOString(), partial = false } = {}) {
  const accounts = await loadAccounts();
  if (!accounts[id]) return null;
  accounts[id].sentIngestedAt = at;
  accounts[id].sentCoveragePartial = partial;
  await saveAccounts(accounts);
  return accounts[id];
}
