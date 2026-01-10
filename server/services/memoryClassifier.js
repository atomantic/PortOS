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
  minConfidence: 0.6,
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
    configCache = { ...DEFAULT_CONFIG, ...JSON.parse(content) };
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
  return `Analyze this agent output and extract useful memories.

Task: ${task.description || 'Unknown task'}
Output:
${agentOutput.substring(0, 8000)}

Return JSON with memories array. Each memory should have:
- type: fact|learning|observation|decision|preference
- category: codebase|workflow|tools|architecture|patterns|conventions|preferences
- content: the actual memory
- confidence: 0.6-1.0
- tags: relevant tags
- reasoning: why this is worth remembering

Only include memories with genuine reusable value. Do not include:
- Task echoes (e.g., "Task X was completed")
- Generic summaries
- Temporary or session-specific info

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

  const parsed = JSON.parse(jsonMatch[1]);

  // Validate structure
  if (!Array.isArray(parsed.memories)) {
    return { memories: [], rejected: parsed.rejected || [], parseError: false };
  }

  // Validate each memory
  const validMemories = parsed.memories.filter(m => {
    if (!m.type || !m.content || typeof m.confidence !== 'number') return false;
    if (m.confidence < 0.6) return false;
    if (m.content.length < 10) return false;

    // Reject obvious task echoes
    if (/^Task\s+['"].*['"]\s*:/i.test(m.content)) return false;
    if (/was\s+(completed|successful|done)/i.test(m.content) && m.content.length < 50) return false;

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
