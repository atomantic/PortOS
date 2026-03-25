/**
 * Tools Registry Service
 *
 * Manages onboard tools (image generation, etc.) that CoS agents can discover and use.
 * Tools are stored as individual JSON files in data/tools/.
 * In-memory cache avoids disk I/O on hot paths (agent spawning).
 */

import { writeFile, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';

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

let cache = null;

async function loadAll() {
  await ensureDir(PATHS.tools);
  const files = await readdir(PATHS.tools);
  const tools = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const data = await readJSONFile(join(PATHS.tools, f), null);
    if (data) tools.push(data);
  }
  cache = tools;
  return tools;
}

function invalidateCache() { cache = null; }

export async function getTools() {
  return cache || loadAll();
}

export async function getTool(id) {
  return readJSONFile(toolPath(id), null);
}

export async function getEnabledTools() {
  const all = await getTools();
  return all.filter(t => t.enabled);
}

export async function registerTool(config) {
  await ensureDir(PATHS.tools);
  const now = new Date().toISOString();
  const tool = {
    id: config.id || randomUUID(),
    name: config.name,
    category: config.category,
    description: config.description || '',
    enabled: config.enabled ?? true,
    config: config.config || {},
    promptHints: config.promptHints || '',
    createdAt: now,
    updatedAt: now
  };
  await writeFile(toolPath(tool.id), JSON.stringify(tool, null, 2) + '\n');
  invalidateCache();
  console.log(`🔧 Tool registered: ${tool.name} (${tool.id})`);
  return tool;
}

export async function updateTool(id, updates) {
  const existing = await getTool(id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...updates,
    id,
    updatedAt: new Date().toISOString()
  };
  await writeFile(toolPath(id), JSON.stringify(merged, null, 2) + '\n');
  invalidateCache();
  console.log(`🔧 Tool updated: ${merged.name} (${id})`);
  return merged;
}

export async function deleteTool(id) {
  await unlink(toolPath(id)).catch(() => null);
  invalidateCache();
  console.log(`🗑️ Tool deleted: ${id}`);
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
