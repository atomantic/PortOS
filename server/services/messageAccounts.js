import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';

const ACCOUNTS_FILE = join(PATHS.messages, 'accounts.json');

async function loadAccounts() {
  await ensureDir(PATHS.messages);
  const content = await readFile(ACCOUNTS_FILE, 'utf-8').catch(() => null);
  if (!content) return {};
  const parsed = safeJSONParse(content, {}, { context: 'messageAccounts' });
  return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
}

async function saveAccounts(accounts) {
  await ensureDir(PATHS.messages);
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
    type: data.type, // gmail, outlook, teams
    provider: data.type === 'gmail' ? 'api' : 'playwright',
    email: data.email || '',
    enabled: true,
    syncConfig: {
      maxAge: data.syncConfig?.maxAge || '30d',
      maxMessages: data.syncConfig?.maxMessages || 500,
      syncInterval: data.syncConfig?.syncInterval || 300000
    },
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

export async function updateSyncStatus(id, status) {
  const accounts = await loadAccounts();
  if (!accounts[id]) return null;
  accounts[id].lastSyncAt = new Date().toISOString();
  accounts[id].lastSyncStatus = status;
  await saveAccounts(accounts);
  return accounts[id];
}
