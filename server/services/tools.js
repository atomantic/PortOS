/**
 * Tools Registry Service
 *
 * Manages onboard tools (image generation, etc.) that CoS agents can discover and use.
 * Tools are stored as individual JSON files in data/tools/.
 * In-memory cache avoids disk I/O on hot paths (agent spawning).
 */

import { readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

function validateToolId(id) {
  if (typeof id !== 'string' || !TOOL_ID_PATTERN.test(id)) {
    throw new Error(`Invalid tool id: must match ${TOOL_ID_PATTERN}`);
  }
}

const toolPath = (id) => {
  validateToolId(id);
  return join(PATHS.tools, `${id}.json`);
};

const queueToolWrite = createFileWriteQueue();

// Cache the promise so concurrent callers share the load and an invalidated
// load cannot overwrite the current result when it eventually settles.
let loadAllPromise = null;
let cacheGeneration = 0;

async function loadAll() {
  await ensureDir(PATHS.tools);
  const files = await readdir(PATHS.tools);
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  // Parallelize all per-file reads instead of sequential awaits.
  const results = await Promise.all(
    jsonFiles.map((f) => readJSONFile(join(PATHS.tools, f), null))
  );
  return results.filter(Boolean);
}

export function invalidateCache() {
  cacheGeneration += 1;
  loadAllPromise = null;
}

/** Hold tool mutations through live backup transfer and cache reconciliation. */
export const withLiveRestore = (restore) => queueToolWrite(() => restore(invalidateCache));

export async function getTools() {
  if (loadAllPromise) return loadAllPromise;
  const generation = cacheGeneration;
  const loading = loadAll().then((tools) => {
    if (generation !== cacheGeneration) {
      if (loadAllPromise === loading) loadAllPromise = null;
      return getTools();
    }
    return tools;
  }).catch((err) => {
    if (loadAllPromise === loading) loadAllPromise = null;
    throw err;
  });
  loadAllPromise = loading;
  return loading;
}

// Non-strict by design: updateTool returns without writing when this read fails;
// registerTool is an explicit complete replacement and does not merge this fallback.
export async function getTool(id) {
  return readJSONFile(toolPath(id), null);
}

export async function getEnabledTools() {
  const all = await getTools();
  return all.filter(t => t.enabled);
}

export async function registerTool(config) {
  const id = config.id || randomUUID();
  const path = toolPath(id);
  // Single queue serializes case variants on macOS/Windows and live restores.
  return queueToolWrite(async () => {
    await ensureDir(PATHS.tools);
    const now = new Date().toISOString();
    const tool = {
      id,
      name: config.name,
      category: config.category,
      description: config.description || '',
      enabled: config.enabled ?? true,
      config: config.config || {},
      promptHints: config.promptHints || '',
      createdAt: now,
      updatedAt: now
    };
    await atomicWrite(path, tool);
    invalidateCache();
    console.log(`🔧 Tool registered: ${tool.name} (${id})`);
    return tool;
  });
}

export async function updateTool(id, updates) {
  validateToolId(id);
  return queueToolWrite(async () => {
    const existing = await getTool(id);
    if (!existing) return null;
    const merged = {
      ...existing,
      ...updates,
      id,
      updatedAt: new Date().toISOString()
    };
    await atomicWrite(toolPath(id), merged);
    invalidateCache();
    console.log(`🔧 Tool updated: ${merged.name} (${id})`);
    return merged;
  });
}

export async function deleteTool(id) {
  const path = toolPath(id);
  return queueToolWrite(async () => {
    await unlink(path).catch(() => null);
    invalidateCache();
    console.log(`🗑️ Tool deleted: ${id}`);
  });
}

export async function getToolsSummaryForPrompt() {
  const tools = await getEnabledTools();
  if (tools.length === 0) return '';
  const lines = tools.map(t => {
    const hint = t.promptHints ? ` — ${t.promptHints}` : '';
    return `- **${t.name}** (${t.category}): ${t.description}${hint}`;
  });
  return `## Available Tools\nThe following onboard tools are available for this instance:\n\n${lines.join('\n')}\n`;
}
