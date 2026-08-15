/** Shared best-effort local-model memory reclamation and headroom reporting. */

import { execFile } from './childProcess.js';
import { platform, freemem, totalmem } from 'os';
import { promisify } from 'util';
import { getLoadedModels as ollamaLoadedModels, unloadModel as ollamaUnload, getBaseUrl as ollamaBaseUrl } from '../services/ollamaManager.js';
import { getLoadedModels as lmStudioLoadedModels, unloadModel as lmStudioUnload, getBaseUrl as lmStudioBaseUrl } from '../services/lmStudioManager.js';

const execFileAsync = promisify(execFile);
const GB = 2 ** 30;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

export function isLocalBackendUrl(url) {
  if (!url || !URL.canParse(url)) return false;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

export async function unloadResidentModels() {
  const unloaded = [];
  if (isLocalBackendUrl(ollamaBaseUrl())) {
    const models = await ollamaLoadedModels().catch(() => []);
    for (const model of models) {
      const name = model?.name || model?.id;
      const result = name ? await ollamaUnload(name).catch(() => null) : null;
      if (result?.unloaded) unloaded.push(`ollama:${name}`);
    }
  }
  if (isLocalBackendUrl(lmStudioBaseUrl())) {
    const models = await lmStudioLoadedModels(true).catch(() => []);
    for (const model of models) {
      const result = model?.id ? await lmStudioUnload(model.id).catch(() => null) : null;
      if (result?.success) unloaded.push(`lmstudio:${model.id}`);
    }
  }
  return unloaded;
}

const parsePageSize = (out) => Number(out.match(/page size of (\d+) bytes/i)?.[1] || 4096);

async function darwinAvailableGb() {
  const { stdout } = await execFileAsync('vm_stat');
  const pageSize = parsePageSize(stdout);
  const pages = (label) => Number(stdout.match(new RegExp(`${label}:\\s+(\\d+)\\.`))?.[1] || 0);
  const available = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
  return available ? (available * pageSize) / GB : null;
}

export async function getAvailableMemoryGb() {
  if (platform() === 'darwin') {
    const available = await darwinAvailableGb().catch(() => null);
    if (Number.isFinite(available) && available > 0) return available;
  }
  return freemem() / GB;
}

export async function prepareLocalMemory() {
  const unloaded = await unloadResidentModels().catch(() => []);
  const availableGb = await getAvailableMemoryGb().catch(() => 0);
  const totalGb = totalmem() / GB;
  return { unloaded, availableGb, totalGb, budgetGb: Math.min(totalGb, availableGb) };
}
