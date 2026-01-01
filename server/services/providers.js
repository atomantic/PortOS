import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const PROVIDERS_FILE = join(DATA_DIR, 'providers.json');
const SAMPLE_FILE = join(__dirname, '../../data.sample/providers.json');

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

async function loadProviders() {
  await ensureDataDir();

  if (!existsSync(PROVIDERS_FILE)) {
    // Copy from sample if exists
    if (existsSync(SAMPLE_FILE)) {
      const sample = await readFile(SAMPLE_FILE, 'utf-8');
      await writeFile(PROVIDERS_FILE, sample);
      return JSON.parse(sample);
    }
    return { activeProvider: null, providers: {} };
  }

  const content = await readFile(PROVIDERS_FILE, 'utf-8');
  return JSON.parse(content);
}

async function saveProviders(data) {
  await ensureDataDir();
  await writeFile(PROVIDERS_FILE, JSON.stringify(data, null, 2));
}

export async function getAllProviders() {
  const data = await loadProviders();
  return {
    activeProvider: data.activeProvider,
    providers: Object.values(data.providers)
  };
}

export async function getProviderById(id) {
  const data = await loadProviders();
  return data.providers[id] || null;
}

export async function getActiveProvider() {
  const data = await loadProviders();
  if (!data.activeProvider) return null;
  return data.providers[data.activeProvider] || null;
}

export async function setActiveProvider(id) {
  const data = await loadProviders();
  if (!data.providers[id]) {
    return null;
  }
  data.activeProvider = id;
  await saveProviders(data);
  return data.providers[id];
}

export async function createProvider(providerData) {
  const data = await loadProviders();
  const id = providerData.id || providerData.name.toLowerCase().replace(/[^a-z0-9]/g, '-');

  if (data.providers[id]) {
    throw new Error('Provider with this ID already exists');
  }

  const provider = {
    id,
    name: providerData.name,
    type: providerData.type || 'cli', // cli | api
    command: providerData.command || null,
    args: providerData.args || [],
    endpoint: providerData.endpoint || null,
    apiKey: providerData.apiKey || '',
    models: providerData.models || [],
    defaultModel: providerData.defaultModel || null,
    timeout: providerData.timeout || 300000,
    enabled: providerData.enabled !== false,
    envVars: providerData.envVars || {}
  };

  data.providers[id] = provider;

  // Set as active if it's the first provider
  if (!data.activeProvider) {
    data.activeProvider = id;
  }

  await saveProviders(data);
  return provider;
}

export async function updateProvider(id, updates) {
  const data = await loadProviders();

  if (!data.providers[id]) {
    return null;
  }

  const provider = {
    ...data.providers[id],
    ...updates,
    id // Prevent ID override
  };

  data.providers[id] = provider;
  await saveProviders(data);
  return provider;
}

export async function deleteProvider(id) {
  const data = await loadProviders();

  if (!data.providers[id]) {
    return false;
  }

  delete data.providers[id];

  // Clear active if it was deleted
  if (data.activeProvider === id) {
    const remaining = Object.keys(data.providers);
    data.activeProvider = remaining.length > 0 ? remaining[0] : null;
  }

  await saveProviders(data);
  return true;
}

export async function testProvider(id) {
  const provider = await getProviderById(id);
  if (!provider) {
    return { success: false, error: 'Provider not found' };
  }

  if (provider.type === 'cli') {
    // Test CLI availability
    const { stdout, stderr } = await execAsync(`which ${provider.command}`).catch(() => ({ stdout: '', stderr: 'not found' }));

    if (!stdout.trim()) {
      return { success: false, error: `Command '${provider.command}' not found in PATH` };
    }

    // Try to get version or help
    const { stdout: versionOut } = await execAsync(`${provider.command} --version 2>/dev/null || ${provider.command} -v 2>/dev/null || echo "available"`).catch(() => ({ stdout: 'available' }));

    return {
      success: true,
      path: stdout.trim(),
      version: versionOut.trim()
    };
  }

  if (provider.type === 'api') {
    // Test API endpoint
    const modelsUrl = `${provider.endpoint}/models`;
    const response = await fetch(modelsUrl, {
      headers: provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}` } : {}
    }).catch(err => ({ ok: false, error: err.message }));

    if (!response.ok) {
      return { success: false, error: `API not reachable: ${response.error || response.status}` };
    }

    const models = await response.json().catch(() => ({ data: [] }));
    return {
      success: true,
      endpoint: provider.endpoint,
      models: models.data?.map(m => m.id) || []
    };
  }

  return { success: false, error: 'Unknown provider type' };
}

export async function refreshProviderModels(id) {
  const provider = await getProviderById(id);
  if (!provider || provider.type !== 'api') {
    return null;
  }

  const modelsUrl = `${provider.endpoint}/models`;
  const response = await fetch(modelsUrl, {
    headers: provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}` } : {}
  }).catch(() => null);

  if (!response?.ok) return null;

  const data = await response.json().catch(() => ({ data: [] }));
  const models = data.data?.map(m => m.id) || [];

  return updateProvider(id, { models });
}
