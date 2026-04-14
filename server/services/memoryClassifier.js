/**
 * Memory Classifier Service
 *
 * Uses an LLM to intelligently evaluate agent output and extract useful memories.
 * Falls back to pattern-based extraction if LLM is unavailable.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getStageTemplate } from './promptService.js';
import { ensureDir, safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { getMemories } from './memoryBackend.js';

const MEMORY_CONFIG_FILE = join(PATHS.data, 'memory-classifier-config.json');

// Default configuration
const DEFAULT_CONFIG = {
  enabled: true,
  provider: 'lmstudio',
  endpoint: process.env.LM_STUDIO_URL ? `${process.env.LM_STUDIO_URL.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions` : 'http://localhost:1234/v1/chat/completions',
  model: 'gptoss-20b',
  timeout: 60000,
  maxOutputLength: 10000,
  minConfidence: 0.7,
  fallbackToPatterns: true
};

let configCache = null;

/**
 * Load classifier configuration
 */
async function loadConfig() {
  if (configCache) return configCache;

  if (existsSync(MEMORY_CONFIG_FILE)) {
    const content = await readFile(MEMORY_CONFIG_FILE, 'utf-8');
    // Handle empty or malformed config file
    if (content && content.trim() && content.trim().startsWith('{') && content.trim().endsWith('}')) {
      configCache = { ...DEFAULT_CONFIG, ...safeJSONParse(content, {}) };
    } else {
      console.log('⚠️ Memory classifier config file empty/malformed, using defaults');
      configCache = DEFAULT_CONFIG;
    }
  } else {
    configCache = DEFAULT_CONFIG;
  }

  return configCache;
}

/**
 * Get current configuration
 */
export async function getConfig() {
  return loadConfig();
}

/**
 * Update configuration
 */
export async function updateConfig(updates) {
  const config = await loadConfig();
  const newConfig = { ...config, ...updates };

  if (!existsSync(PATHS.data)) {
    await ensureDir(PATHS.data);
  }

  await writeFile(MEMORY_CONFIG_FILE, JSON.stringify(newConfig, null, 2));
  configCache = newConfig;

  return newConfig;
}

/**
 * Load existing active + pending memories as a summary for the LLM prompt.
 * Defense-in-depth: the LLM sees what's already stored so it avoids proposing
 * duplicates. The backend dedup in memoryExtractor is the actual safety net.
 */
async function loadExistingMemorySummary() {
  const [active, pending] = await Promise.all([
    getMemories({ status: 'active', sortBy: 'importance', sortOrder: 'desc', limit: 30 })
      .catch(() => ({ memories: [] })),
    getMemories({ status: 'pending_approval', limit: 30 })
      .catch(() => ({ memories: [] }))
  ]);

  const allMemories = [...active.memories, ...pending.memories];
  if (allMemories.length === 0) return '';

  // getMemories() returns index/metadata rows without \`content\` — fall back
  // to \`summary\` so each bullet has a real sentence instead of an empty string.
  const lines = allMemories.slice(0, 30).map(m => {
    const text = (m.content || m.summary || '').substring(0, 150);
    return `- [${m.type}] ${text}`;
  });
  return lines.join('\n');
}

/**
 * Build the classification prompt
 */
async function buildClassificationPrompt(task, agentOutput, config) {
  // Try to load the template
  const template = await getStageTemplate('memory-evaluate').catch(() => null);

  // Load existing memories to inject into the prompt
  const existingMemories = await loadExistingMemorySummary();

  if (!template) {
    // Fallback inline template
    return buildFallbackPrompt(task, agentOutput, existingMemories);
  }

  // Apply variables to template
  const variables = {
    taskId: task.id || 'unknown',
    taskDescription: task.description || 'No description',
    taskStatus: task.status || 'completed',
    appName: task.metadata?.app || 'PortOS',
    agentOutput: agentOutput.substring(0, config.maxOutputLength || 10000),
    existingMemories: existingMemories || 'No existing memories yet.'
  };

  let prompt = template;
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  return prompt;
}

/**
 * Fallback prompt if template not found
 */
function buildFallbackPrompt(task, agentOutput, existingMemories = '') {
  const existingSection = existingMemories
    ? `\n## Existing Memories (DO NOT duplicate these)\nThe following memories are already stored. Do NOT propose any memory that overlaps with or restates these:\n${existingMemories}\n`
    : '';

  return `Analyze this agent output and extract memories about the USER — their values, preferences, work patterns, and qualities they care about.

Task: ${task.description || 'Unknown task'}
Output:
${agentOutput.substring(0, 8000)}
${existingSection}
Return JSON with memories array. Each memory should have:
- type: preference|decision|learning
- category: values|workflow|preferences|communication|aesthetics|patterns
- content: the actual memory about the user
- confidence: 0.7-1.0
- tags: relevant tags
- reasoning: what this reveals about the user

DO NOT include:
- Implementation details (file paths, function names, CSS values, component structures)
- Architecture descriptions (easily discoverable from code)
- Task completion summaries (that's git history)
- Generic best practices any developer would know
- One-time code observations or status assessments
- Anything already captured in the existing memories listed above

Most outputs should produce ZERO memories. Only extract when you observe something genuinely revealing about the user's values, preferences, or work patterns that is NOT already stored.

Return: {"memories": [...], "rejected": [...]}`;
}

/**
 * Derive the LM Studio base URL from the chat/completions endpoint
 */
function getBaseUrl(endpoint) {
  return endpoint.replace(/\/v1\/chat\/completions\/?$/, '').replace(/\/+$/, '');
}

/**
 * Ensure an LLM model is loaded in LM Studio. If none is loaded, discover
 * downloaded LLM models via `/api/v0/models` and auto-load one via
 * `/api/v1/models/load`. Prefers the configured model when available,
 * otherwise falls back to any downloaded LLM.
 *
 * @returns {Promise<string|null>} The id of a loaded LLM model, or null
 */
async function ensureLLMModelLoaded(config) {
  const baseUrl = getBaseUrl(config.endpoint);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  const listResponse = await fetch(`${baseUrl}/api/v0/models`, {
    method: 'GET',
    signal: controller.signal
  }).catch(() => null).finally(() => clearTimeout(timeoutId));

  if (!listResponse?.ok) return null;

  const payload = await listResponse.json().catch(() => null);
  const allModels = payload?.data || [];
  const llmModels = allModels.filter(m => m.type === 'llm');

  if (llmModels.length === 0) {
    console.warn('⚠️ No LLM models downloaded in LM Studio — download one in the Discover tab');
    return null;
  }

  // If any LLM is already loaded, prefer the configured one; otherwise use any loaded LLM
  const loaded = llmModels.filter(m => m.state === 'loaded');
  if (loaded.length > 0) {
    const match = loaded.find(m => m.id === config.model || m.id.includes(config.model));
    return (match || loaded[0]).id;
  }

  // Need to load one — prefer configured model, else first available
  const preferred = llmModels.find(m => m.id === config.model || m.id.includes(config.model))
    || llmModels[0];

  console.log(`📦 Auto-loading LLM model: ${preferred.id}`);

  const loadController = new AbortController();
  const loadTimeout = setTimeout(() => loadController.abort(), 120000);
  const loadResponse = await fetch(`${baseUrl}/api/v1/models/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: preferred.id }),
    signal: loadController.signal
  }).catch(err => ({ ok: false, _err: err.message })).finally(() => clearTimeout(loadTimeout));

  if (!loadResponse.ok) {
    const errText = loadResponse._err || await loadResponse.text?.().catch(() => 'unknown error') || 'unknown error';
    console.error(`❌ Failed to auto-load LLM model ${preferred.id}: ${errText}`);
    return null;
  }

  console.log(`✅ LLM model loaded: ${preferred.id}`);
  return preferred.id;
}

/**
 * Call LM Studio API for classification
 */
async function callLLM(prompt, config) {
  // Make sure a model is loaded before sending the request — LM Studio returns
  // 400 "No models loaded" otherwise.
  const loadedModel = await ensureLLMModelLoaded(config);
  const modelToUse = loadedModel || config.model;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer lm-studio`
    },
    body: JSON.stringify({
      model: modelToUse,
      messages: [
        {
          role: 'system',
          content: 'You are a memory classification assistant. Return only valid JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 2000
    }),
    signal: controller.signal
  }).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    const error = await response.text().catch(() => 'Unknown error');
    throw new Error(`LLM API error ${response.status}: ${error}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Parse LLM response to extract memories
 */
function parseLLMResponse(response) {
  // Extract JSON from response (may be wrapped in markdown code blocks)
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                    response.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) {
    console.log('⚠️ Could not find JSON in LLM response');
    return { memories: [], rejected: [], parseError: true };
  }

  let parsed;
  const jsonStr = jsonMatch[1].trim();
  // Validate JSON structure before parsing
  if (!jsonStr || !(jsonStr.startsWith('{') && jsonStr.endsWith('}'))) {
    console.log('⚠️ Extracted JSON appears malformed');
    return { memories: [], rejected: [], parseError: true };
  }
  parsed = safeJSONParse(jsonStr, null, { logError: true, context: 'memory classification' });
  if (!parsed) return { memories: [], rejected: [], parseError: true };

  // Validate structure
  if (!Array.isArray(parsed.memories)) {
    return { memories: [], rejected: parsed.rejected || [], parseError: false };
  }

  // Validate each memory — reject implementation details and low-value noise
  const validMemories = parsed.memories.filter(m => {
    if (!m.type || !m.content || typeof m.confidence !== 'number') return false;
    if (m.confidence < 0.7) return false;
    if (m.content.length < 15) return false;

    // Reject obvious task echoes
    if (/^Task\s+['"].*['"]\s*:/i.test(m.content)) return false;
    if (/was\s+(completed|successful|done)/i.test(m.content) && m.content.length < 80) return false;

    // Reject implementation details — file paths, function names, CSS values
    if (/\.(jsx?|tsx?|css|json|md|py|sh|yml)\b/i.test(m.content) && m.type !== 'preference') return false;
    if (/\b\d+px\b/.test(m.content)) return false;
    if (/\b#[0-9a-f]{6}\b/i.test(m.content) && m.type !== 'preference') return false;
    if (/\bport\s+\d{4}\b/i.test(m.content)) return false;

    // Reject architecture descriptions (easily discoverable from code)
    if (/\b(?:uses?\s+(?:express|react|vite|pm2|tailwind|socket\.io|zod))\b/i.test(m.content) && m.type === 'fact') return false;

    // Reject positive status assessments (not memories)
    if (/\b(?:no\s+issues?\s+found|well[- ]optimized|already\s+(?:has|implements)|no\s+(?:fixes?|changes?)\s+(?:required|needed))\b/i.test(m.content)) return false;

    // Reject one-time observations about code state
    if (/\b(?:imported?\s+but\s+(?:not\s+used|unused|never)|is\s+sized|has\s+\d+\s+lines?)\b/i.test(m.content)) return false;

    return true;
  });

  return {
    memories: validMemories,
    rejected: parsed.rejected || [],
    parseError: false
  };
}

/**
 * Main classification function
 *
 * @param {Object} task - Task object with id, description, metadata
 * @param {string} agentOutput - The agent's output text
 * @returns {Object} { memories: [], rejected: [], usedLLM: boolean, error?: string }
 */
export async function classifyMemories(task, agentOutput) {
  const config = await loadConfig();

  // Skip if output is too short
  if (!agentOutput || agentOutput.length < 100) {
    return { memories: [], rejected: [], usedLLM: false, skipped: 'output-too-short' };
  }

  // Skip if disabled
  if (!config.enabled) {
    return { memories: [], rejected: [], usedLLM: false, skipped: 'classifier-disabled' };
  }

  const prompt = await buildClassificationPrompt(task, agentOutput, config);

  // Call LLM for classification
  const llmResponse = await callLLM(prompt, config).catch(err => {
    console.log(`⚠️ LLM classification failed: ${err.message}`);
    return null;
  });

  if (!llmResponse) {
    return {
      memories: [],
      rejected: [],
      usedLLM: false,
      error: 'LLM call failed',
      fallbackAvailable: config.fallbackToPatterns
    };
  }

  const result = parseLLMResponse(llmResponse);

  if (result.parseError) {
    console.log('⚠️ Failed to parse LLM response, raw:', llmResponse.substring(0, 200));
    return {
      memories: [],
      rejected: [],
      usedLLM: true,
      error: 'Failed to parse LLM response',
      fallbackAvailable: config.fallbackToPatterns
    };
  }

  console.log(`🧠 LLM classified ${result.memories.length} memories, rejected ${result.rejected.length}`);

  return {
    memories: result.memories,
    rejected: result.rejected,
    usedLLM: true
  };
}

/**
 * Check if the classifier is available (LLM endpoint reachable)
 */
export async function isAvailable() {
  const config = await loadConfig();

  if (!config.enabled) return false;

  // Quick health check
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  const response = await fetch(config.endpoint.replace('/chat/completions', '/models'), {
    method: 'GET',
    signal: controller.signal
  }).catch(() => null).finally(() => clearTimeout(timeoutId));

  return response?.ok === true;
}
