/**
 * macOS Contacts ingestion (#2415) — read-only scan of AddressBook SQLite DBs
 * (AddressBook root + Sources/.../AddressBook-v22.abcddb) into a machine-local
 * cache used to resolve phone/email → display name for iMessage and to enrich
 * Tribe phones/emails.
 *
 * Design constraints:
 * - Zero new dependencies. node:sqlite readOnly (same as imessageSync).
 * - Never write Apple's Contacts databases.
 * - Machine-local cache in data/contacts-cache.json (not federated).
 * - LLM-free. Pure normalize + index; Tribe wins over Contacts on resolve.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { expandHome, dataPath, atomicWrite, tryReadFile, safeJSONParse } from '../lib/fileUtils.js';
import { identityFromHandle, normalizeIdentifier, normalizePhone } from '../lib/tribeMatch.js';

const DEFAULT_AB_ROOT = '~/Library/Application Support/AddressBook';
const CACHE_FILE = 'contacts-cache.json';
const STATE_FILE = 'contacts-sync-state.json';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Build a human display name from contact name parts + organization.
 * Prefers "First Last" / nickname; falls back to organization (companies).
 */
export function contactDisplayName({
  firstName, lastName, middleName, nickname, organization, name,
} = {}) {
  const nick = String(nickname || '').trim();
  const first = String(firstName || '').trim();
  const middle = String(middleName || '').trim();
  const last = String(lastName || '').trim();
  const org = String(organization || '').trim();
  const full = String(name || '').trim();

  const parts = [first, middle, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (parts) return parts;
  if (nick) return nick;
  if (full) return full;
  if (org) return org;
  return '';
}

/**
 * Normalize a raw AddressBook row-group into a contact record, or null when
 * there is nothing usable (no name and no phones/emails).
 */
export function normalizeContactRecord(raw) {
  if (!raw) return null;
  const phones = [...new Set(
    (raw.phones || []).map((p) => normalizePhone(p)).filter(Boolean),
  )];
  const emails = [...new Set(
    (raw.emails || []).map((e) => normalizeIdentifier(e)).filter(Boolean),
  )];
  const displayName = contactDisplayName(raw);
  if (!displayName && phones.length === 0 && emails.length === 0) return null;
  const id = String(raw.id || raw.uniqueId || `${displayName}|${phones[0] || ''}|${emails[0] || ''}`);
  return {
    id,
    uniqueId: raw.uniqueId || id,
    displayName: displayName || phones[0] || emails[0] || 'Contact',
    firstName: String(raw.firstName || '').trim() || null,
    lastName: String(raw.lastName || '').trim() || null,
    organization: String(raw.organization || '').trim() || null,
    nickname: String(raw.nickname || '').trim() || null,
    phones,
    emails,
    sourcePath: raw.sourcePath || null,
  };
}

/**
 * Merge contacts from multiple AddressBook sources. Same uniqueId or same
 * phone/email set collapses; prefers the record with more fields.
 */
export function mergeContacts(lists = []) {
  const byKey = new Map();
  const score = (c) => (c.phones?.length || 0) + (c.emails?.length || 0) + (c.organization ? 1 : 0)
    + (c.firstName ? 1 : 0) + (c.lastName ? 1 : 0);

  for (const list of lists) {
    for (const raw of list || []) {
      const c = normalizeContactRecord(raw);
      if (!c) continue;
      // Prefer uniqueId; also index under each phone/email for dedupe across sources.
      const keys = new Set([`id:${c.uniqueId}`]);
      for (const p of c.phones) keys.add(`p:${p}`);
      for (const e of c.emails) keys.add(`e:${e}`);

      let existing = null;
      for (const k of keys) {
        if (byKey.has(k)) {
          existing = byKey.get(k);
          break;
        }
      }
      if (!existing) {
        for (const k of keys) byKey.set(k, c);
        continue;
      }
      // Merge phones/emails into the richer record.
      const merged = {
        ...existing,
        phones: [...new Set([...(existing.phones || []), ...(c.phones || [])])],
        emails: [...new Set([...(existing.emails || []), ...(c.emails || [])])],
        organization: existing.organization || c.organization,
        firstName: existing.firstName || c.firstName,
        lastName: existing.lastName || c.lastName,
        nickname: existing.nickname || c.nickname,
        displayName: score(c) > score(existing) ? c.displayName : existing.displayName,
      };
      // Re-point all keys for both records at the merged one.
      const allKeys = new Set([...keys]);
      for (const p of merged.phones) allKeys.add(`p:${p}`);
      for (const e of merged.emails) allKeys.add(`e:${e}`);
      allKeys.add(`id:${merged.uniqueId}`);
      for (const k of allKeys) byKey.set(k, merged);
    }
  }

  // De-dupe by uniqueId for the returned array.
  const seen = new Set();
  const out = [];
  for (const c of byKey.values()) {
    if (seen.has(c.uniqueId)) continue;
    seen.add(c.uniqueId);
    out.push(c);
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return out;
}

/**
 * Build lookup maps from a contact list: byPhone, byEmail.
 * First claim wins (stable after sort).
 */
export function buildContactIndex(contacts = []) {
  const byPhone = new Map();
  const byEmail = new Map();
  for (const c of contacts) {
    for (const p of c.phones || []) {
      if (p && !byPhone.has(p)) byPhone.set(p, c);
    }
    for (const e of c.emails || []) {
      if (e && !byEmail.has(e)) byEmail.set(e, c);
    }
  }
  return { byPhone, byEmail };
}

/**
 * Resolve a raw handle (phone or email) against a contacts index.
 * Returns `{ displayName, organization, contactId, source: 'contacts' }` or null.
 */
export function resolveHandleAgainstContacts(handle, contactIndex) {
  if (!handle || !contactIndex) return null;
  const id = identityFromHandle(handle);
  if (id.phone && contactIndex.byPhone.has(id.phone)) {
    const c = contactIndex.byPhone.get(id.phone);
    return {
      displayName: c.displayName,
      organization: c.organization || null,
      contactId: c.id,
      source: 'contacts',
    };
  }
  if (id.email && contactIndex.byEmail.has(id.email)) {
    const c = contactIndex.byEmail.get(id.email);
    return {
      displayName: c.displayName,
      organization: c.organization || null,
      contactId: c.id,
      source: 'contacts',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filesystem: discover AddressBook DBs
// ---------------------------------------------------------------------------

export function addressBookRoot() {
  return expandHome(process.env.CONTACTS_AB_ROOT || DEFAULT_AB_ROOT);
}

/**
 * List every AddressBook-v22.abcddb under the root (root + Sources/*).
 * Pure-ish: uses readdir/stat only.
 */
export function discoverAddressBookPaths(root = addressBookRoot()) {
  const paths = [];
  const rootDb = join(root, 'AddressBook-v22.abcddb');
  if (existsSync(rootDb)) paths.push(rootDb);
  const sourcesDir = join(root, 'Sources');
  if (!existsSync(sourcesDir)) return paths;
  let entries = [];
  try {
    entries = readdirSync(sourcesDir, { withFileTypes: true });
  } catch {
    return paths;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const db = join(sourcesDir, ent.name, 'AddressBook-v22.abcddb');
    if (existsSync(db)) paths.push(db);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// SQLite read (try/catch sanctioned — outside Express request lifecycle)
// ---------------------------------------------------------------------------

function isPermissionError(err) {
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return true;
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('unable to open')
    || msg.includes('not authorized')
    || msg.includes('operation not permitted');
}

/**
 * Read one AddressBook DB into raw contact groups (pre-normalize).
 * Groups phones/emails by owner Z_PK.
 */
export function readAddressBookDb(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return { ok: false, path: dbPath, error: err?.message || String(err), permission: isPermissionError(err), contacts: [] };
  }
  try {
    // Presence check — older/empty DBs may lack phone tables.
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ZABCDRECORD','ZABCDPHONENUMBER','ZABCDEMAILADDRESS')`,
    ).all().map((r) => r.name);
    if (!tables.includes('ZABCDRECORD')) {
      return { ok: true, path: dbPath, contacts: [], empty: true };
    }

    const records = db.prepare(
      `SELECT Z_PK AS pk, ZUNIQUEID AS unique_id,
              ZFIRSTNAME AS first_name, ZLASTNAME AS last_name,
              ZMIDDLENAME AS middle_name, ZNICKNAME AS nickname,
              ZORGANIZATION AS organization, ZNAME AS name
         FROM ZABCDRECORD`,
    ).all();

    const phonesByOwner = new Map();
    if (tables.includes('ZABCDPHONENUMBER')) {
      const phoneRows = db.prepare(
        `SELECT ZOWNER AS owner, ZFULLNUMBER AS full_number FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL AND ZFULLNUMBER <> ''`,
      ).all();
      for (const r of phoneRows) {
        const list = phonesByOwner.get(r.owner) || [];
        list.push(String(r.full_number));
        phonesByOwner.set(r.owner, list);
      }
    }

    const emailsByOwner = new Map();
    if (tables.includes('ZABCDEMAILADDRESS')) {
      const emailRows = db.prepare(
        `SELECT ZOWNER AS owner, ZADDRESS AS address FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL AND ZADDRESS <> ''`,
      ).all();
      for (const r of emailRows) {
        const list = emailsByOwner.get(r.owner) || [];
        list.push(String(r.address));
        emailsByOwner.set(r.owner, list);
      }
    }

    const contacts = [];
    for (const r of records) {
      const phones = phonesByOwner.get(r.pk) || [];
      const emails = emailsByOwner.get(r.pk) || [];
      // Skip group-ish rows with no contact data (many ZABCDRECORD rows are groups/meta).
      if (!r.first_name && !r.last_name && !r.organization && !r.nickname && !r.name
        && phones.length === 0 && emails.length === 0) {
        continue;
      }
      contacts.push({
        id: r.unique_id || `ab:${dbPath}:${r.pk}`,
        uniqueId: r.unique_id || `ab:${r.pk}`,
        firstName: r.first_name,
        lastName: r.last_name,
        middleName: r.middle_name,
        nickname: r.nickname,
        organization: r.organization,
        name: r.name,
        phones,
        emails,
        sourcePath: dbPath,
      });
    }
    return { ok: true, path: dbPath, contacts };
  } catch (err) {
    return { ok: false, path: dbPath, error: err?.message || String(err), permission: isPermissionError(err), contacts: [] };
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// Cache + state
// ---------------------------------------------------------------------------

function cachePath() {
  return dataPath(CACHE_FILE);
}

function statePath() {
  return dataPath(STATE_FILE);
}

export async function readContactCache() {
  const raw = await tryReadFile(cachePath());
  const parsed = raw ? safeJSONParse(raw, null, { allowArray: false }) : null;
  const contacts = Array.isArray(parsed?.contacts) ? parsed.contacts : [];
  return {
    contacts,
    syncedAt: parsed?.syncedAt || null,
    sourceCount: parsed?.sourceCount || 0,
  };
}

async function writeContactCache(contacts, meta = {}) {
  const payload = {
    contacts,
    syncedAt: new Date().toISOString(),
    sourceCount: meta.sourceCount || 0,
    contactCount: contacts.length,
  };
  await atomicWrite(cachePath(), JSON.stringify(payload));
  return payload;
}

export async function readSyncState() {
  const raw = await tryReadFile(statePath());
  const parsed = raw ? safeJSONParse(raw, null, { allowArray: false }) : null;
  return {
    lastRunAt: parsed?.lastRunAt || null,
    lastResult: parsed?.lastResult || null,
  };
}

async function writeSyncState(state) {
  await atomicWrite(statePath(), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Setup check — discover DBs and attempt a read of the first one. Never throws.
 */
export async function checkSetup() {
  const root = addressBookRoot();
  let paths = [];
  try {
    paths = discoverAddressBookPaths(root);
  } catch (err) {
    return {
      ok: false,
      root,
      error: err?.message || 'Failed to scan AddressBook directory',
      fullDiskAccessRequired: isPermissionError(err),
      remediation: isPermissionError(err)
        ? 'Grant Full Disk Access to the process running PortOS (System Settings → Privacy & Security → Full Disk Access), then restart PortOS.'
        : `Could not scan ${root}: ${err?.message || 'unknown error'}`,
    };
  }
  if (paths.length === 0) {
    return {
      ok: false,
      root,
      paths: [],
      error: 'No AddressBook-v22.abcddb found',
      remediation: `No Contacts databases under ${root}. Open the macOS Contacts app at least once, or check CONTACTS_AB_ROOT.`,
    };
  }
  // Probe the largest source for a real permission signal.
  let best = { path: paths[0], n: 0 };
  for (const p of paths) {
    try {
      const n = statSync(p).size || 0;
      if (n > best.n) best = { path: p, n };
    } catch { /* skip */ }
  }
  const probe = readAddressBookDb(best.path);
  if (!probe.ok) {
    return {
      ok: false,
      root,
      paths,
      error: probe.error,
      fullDiskAccessRequired: probe.permission,
      remediation: probe.permission
        ? 'Grant Full Disk Access to the process running PortOS (System Settings → Privacy & Security → Full Disk Access), then restart PortOS.'
        : probe.error,
    };
  }
  // Count across all sources (cheap open).
  let totalRaw = 0;
  let sourcesOk = 0;
  for (const p of paths) {
    const r = readAddressBookDb(p);
    if (r.ok) {
      sourcesOk += 1;
      totalRaw += r.contacts.length;
    }
  }
  return {
    ok: true,
    root,
    paths,
    sourceCount: sourcesOk,
    rawContactRows: totalRaw,
  };
}

/**
 * Full sync: read all AddressBook sources, merge, write cache.
 */
let syncInFlight = null;
export async function runSync() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doRunSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function doRunSync() {
  const setup = await checkSetup();
  if (!setup.ok) {
    const result = {
      ok: false,
      error: setup.error,
      fullDiskAccessRequired: setup.fullDiskAccessRequired,
      remediation: setup.remediation,
    };
    await writeSyncState({ lastRunAt: new Date().toISOString(), lastResult: result });
    return result;
  }

  const lists = [];
  const errors = [];
  for (const p of setup.paths || []) {
    const r = readAddressBookDb(p);
    if (r.ok) lists.push(r.contacts);
    else errors.push({ path: p, error: r.error });
  }
  const contacts = mergeContacts(lists);
  const cache = await writeContactCache(contacts, { sourceCount: lists.length });
  const result = {
    ok: true,
    contactCount: contacts.length,
    sourceCount: lists.length,
    phoneKeys: contacts.reduce((n, c) => n + (c.phones?.length || 0), 0),
    emailKeys: contacts.reduce((n, c) => n + (c.emails?.length || 0), 0),
    errors: errors.length ? errors : undefined,
    syncedAt: cache.syncedAt,
  };
  await writeSyncState({ lastRunAt: new Date().toISOString(), lastResult: result });
  console.log(`📇 Contacts sync: ${result.contactCount} contact(s) from ${result.sourceCount} source(s)`);
  return result;
}

export async function getStatus() {
  const [cache, state, setup] = await Promise.all([
    readContactCache(),
    readSyncState(),
    checkSetup().catch(() => ({ ok: false })),
  ]);
  return {
    cache: {
      contactCount: cache.contacts.length,
      syncedAt: cache.syncedAt,
      sourceCount: cache.sourceCount,
    },
    state,
    setup: {
      ok: setup.ok,
      sourceCount: setup.sourceCount,
      root: setup.root,
      fullDiskAccessRequired: setup.fullDiskAccessRequired,
      error: setup.error,
    },
  };
}

/**
 * Search the cached contacts (name / org / phone / email substring).
 */
export async function searchContacts({ q, limit } = {}) {
  const { contacts } = await readContactCache();
  const needle = String(q || '').trim().toLowerCase();
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
  if (!needle) return contacts.slice(0, cap);
  const out = [];
  for (const c of contacts) {
    const hay = [
      c.displayName,
      c.organization,
      c.firstName,
      c.lastName,
      ...(c.phones || []),
      ...(c.emails || []),
    ].filter(Boolean).join(' ').toLowerCase();
    if (hay.includes(needle)) {
      out.push(c);
      if (out.length >= cap) break;
    }
  }
  return out;
}

export async function getContactById(id) {
  const { contacts } = await readContactCache();
  return contacts.find((c) => c.id === id || c.uniqueId === id) || null;
}

/**
 * Load contacts + build index. Cached in-process for the duration of a request
 * batch via the returned object (caller holds it).
 */
export async function loadContactIndex() {
  const { contacts, syncedAt } = await readContactCache();
  return {
    contacts,
    syncedAt,
    index: buildContactIndex(contacts),
  };
}
