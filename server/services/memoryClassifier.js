/**
 * Memory Classifier Service
 *
 * Uses an LLM to intelligently evaluate agent output and extract useful memories.
 * Falls back to pattern-based extraction if LLM is unavailable.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getStageTemplate } from './promptService.js';
import { safeJSONParse } from '../lib/fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, '../../data');
const MEMORY_CONFIG_FILE = join(CONFIG_DIR, 'memory-classifier-config.json');

// Default configuration
const DEFAULT_CONFIG = {
  enabled: true,
  provider: 'lmstudio',
  endpoint: 'http://localhost:1234/v1/chat/completions',
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
      configCache = { ...DEFAULT_CONFIG, ...JSON.parse(content) };
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
  const { writeFile, mkdir } = await import('fs/promises');

  const config = await loadConfig();
  const newConfig = { ...config, ...updates };

  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }

  await writeFile(MEMORY_CONFIG_FILE, JSON.stringify(newConfig, null, 2));
  configCache = newConfig;

  return newConfig;
}

/**
 * Build the classification prompt
 */
async function buildClassificationPrompt(task, agentOutput, config) {
  // Try to load the template
  const template = await getStageTemplate('memory-evaluate').catch(() => null);

  if (!template) {
    // Fallback inline template
    return buildFallbackPrompt(task, agentOutput);
  }

  // Apply variables to template
  const variables = {
    taskId: task.id || 'unknown',
    taskDescription: task.description || 'No description',
    taskStatus: task.status || 'completed',
    appName: task.metadata?.app || 'PortOS',
    agentOutput: agentOutput.substring(0, config.maxOutputLength || 10000)
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
function buildFallbackPrompt(task, agentOutput) {
  return `Analyze this agent output and extract memories about the USER — their values, preferences, work patterns, and qualities they care about.

Task: ${task.description || 'Unknown task'}
Output:
${agentOutput.substring(0, 8000)}

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

Most outputs should produce ZERO memories. Only extract when you observe something genuinely revealing about the user's values, preferences, or work patterns.

Return: {"memories": [...], "rejected": [...]}`;
}

/**
 * Call LM Studio API for classification
 */
async function callLLM(prompt, config) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer lm-studio`
    },
    body: JSON.stringify({
      model: config.model,
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
