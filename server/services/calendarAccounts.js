import { writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';

const ACCOUNTS_FILE = join(PATHS.calendar, 'accounts.json');

async function loadAccounts() {
  await ensureDir(PATHS.calendar);
  const parsed = await readJSONFile(ACCOUNTS_FILE, {});
  return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
}

async function saveAccounts(accounts) {
  await ensureDir(PATHS.calendar);
  await writeFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
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
    type: data.type, // outlook-calendar
    email: data.email || '',
    enabled: true,
    syncConfig: {
      maxAge: data.syncConfig?.maxAge || '90d',
      syncInterval: data.syncConfig?.syncInterval || 300000,
      calendarIds: data.syncConfig?.calendarIds || ['default']
    },
    lastSyncAt: null,
    lastSyncStatus: null,
    createdAt: new Date().toISOString()
  };
  // For google-calendar, initialize subcalendars
  if (data.type === 'google-calendar') {
    accounts[id].subcalendars = (data.subcalendars || []).map(sc => ({
      calendarId: sc.calendarId,
      name: sc.name,
      color: sc.color || '',
      enabled: sc.enabled !== false,
      dormant: sc.dormant || false,
      goalIds: sc.goalIds || [],
      addedAt: sc.addedAt || new Date().toISOString()
    }));
    // Default to google-api if OAuth is configured, otherwise claude-mcp
    const { getAuthStatus } = await import('./googleAuth.js');
    const authStatus = await getAuthStatus().catch(() => ({}));
    accounts[id].syncMethod = authStatus.hasTokens ? 'google-api' : 'claude-mcp';
  }
  await saveAccounts(accounts);
  console.log(`📅 Calendar account created: ${data.name} (${data.type})`);
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
  if (updates.syncMethod !== undefined) accounts[id].syncMethod = updates.syncMethod;
  accounts[id].updatedAt = new Date().toISOString();
  await saveAccounts(accounts);
  return accounts[id];
}

export async function deleteAccount(id) {
  const accounts = await loadAccounts();
  if (!accounts[id]) return false;
  delete accounts[id];
  await saveAccounts(accounts);
  console.log(`🗑️ Calendar account deleted: ${id}`);
  return true;
}

export async function updateSubcalendars(id, subcalendars) {
  const accounts = await loadAccounts();
  if (!accounts[id]) return null;
  accounts[id].subcalendars = subcalendars.map(sc => ({
    calendarId: sc.calendarId,
    name: sc.name,
    color: sc.color || '',
    enabled: sc.enabled !== false,
    dormant: sc.dormant || false,
    goalIds: sc.goalIds || [],
    addedAt: sc.addedAt || new Date().toISOString()
  }));
  accounts[id].updatedAt = new Date().toISOString();
  await saveAccounts(accounts);
  console.log(`📅 Updated subcalendars for account ${accounts[id].name}: ${subcalendars.length} calendars`);
  return accounts[id];
}

export function mergeDiscoveredSubcalendars(existing, discovered) {
  const existingMap = new Map((existing || []).map(sc => [sc.calendarId, sc]));
  return discovered.map(cal => {
    const prev = existingMap.get(cal.id);
    return {
      calendarId: cal.id,
      name: cal.name || cal.id,
      color: cal.color || prev?.color || '',
      enabled: prev?.enabled ?? false,
      dormant: prev?.dormant ?? false,
      goalIds: prev?.goalIds || [],
      addedAt: prev?.addedAt || new Date().toISOString()
    };
  });
}

export async function updateSyncStatus(id, status) {
  const accounts = await loadAccounts();
  if (!accounts[id]) return null;
  accounts[id].lastSyncAt = new Date().toISOString();
  accounts[id].lastSyncStatus = status;
  await saveAccounts(accounts);
  return accounts[id];
}
