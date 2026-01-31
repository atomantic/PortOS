/**
 * Task Enhancer Service
 *
 * Uses AI to enhance task descriptions/prompts to be more detailed,
 * actionable, and comprehensive for agent execution.
 */

import { executeApiRun, createRun } from './runner.js';
import { getActiveProvider, getProviderById } from './providers.js';
import { getConfig } from './cos.js';

/**
 * Default enhancement prompt template
 */
const ENHANCEMENT_PROMPT = `You are a task prompt enhancer for an AI agent system. Your job is to take a brief task description and expand it into a comprehensive, detailed prompt that an AI coding agent can execute effectively.

## Guidelines

1. **Preserve the original intent** - Don't change what the user wants, just make it clearer and more actionable
2. **Add specific steps** - Break down the task into clear, sequential steps when appropriate
3. **Include relevant context** - Mention file paths, patterns, or conventions that should be followed
4. **Define success criteria** - What does "done" look like?
5. **Anticipate edge cases** - Mention potential issues to watch out for
6. **Keep it focused** - Don't add unrelated tasks or scope creep

## Original Task Description
{description}

{contextSection}

## Your Enhanced Prompt

Provide an enhanced version of this task that an AI agent can execute. Output ONLY the enhanced prompt text, nothing else. Do not include any preamble like "Here is the enhanced prompt:" - just output the prompt itself.`;

/**
 * Enhance a task prompt using AI
 *
 * @param {string} description - The original task description
 * @param {string} context - Optional additional context
 * @returns {Promise<{enhancedDescription: string, originalDescription: string, model: string, provider: string}>}
 */
export async function enhanceTaskPrompt(description, context = '') {
  console.log(`✨ Enhancing task prompt: "${description.substring(0, 50)}..."`);

  // Get CoS config for default enhancement settings
  const config = await getConfig();

  // Determine provider and model to use
  // Priority: CoS config -> active provider default
  let provider = await getActiveProvider();
  let model = 'codex';

  // Use OpenAI for enhancement by default if available, otherwise fall back to active provider
  const openaiProvider = await getProviderById('openai').catch(() => null);
  if (openaiProvider?.enabled) {
    provider = openaiProvider;
    model = 'codex';
  } else if (provider) {
    // Fall back to active provider's default model
    model = provider.defaultModel || provider.models?.[0] || 'claude-sonnet-4-20250514';
  }

  if (!provider) {
    throw new Error('No AI provider available for enhancement');
  }

  // Build the enhancement prompt
  const contextSection = context
    ? `## Additional Context\n${context}`
    : '';

  const fullPrompt = ENHANCEMENT_PROMPT
    .replace('{description}', description)
    .replace('{contextSection}', contextSection);

  // Create a run for this enhancement
  const { runId } = await createRun({
    providerId: provider.id,
    model,
    prompt: fullPrompt,
    source: 'task-enhancement'
  });

  // Collect the response
  let enhancedDescription = '';

  await new Promise((resolve, reject) => {
    executeApiRun(
      runId,
      provider,
      model,
      fullPrompt,
      process.cwd(),
      [], // No screenshots needed
      (data) => {
        if (data?.text) {
          enhancedDescription += data.text;
        }
      },
      (result) => {
        if (result?.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      }
    );
  });

  // Clean up the response - remove any leading/trailing whitespace and common prefixes
  enhancedDescription = enhancedDescription.trim();

  // Remove common AI response prefixes
  const prefixesToRemove = [
    /^Here is the enhanced prompt[:\s]*/i,
    /^Enhanced prompt[:\s]*/i,
    /^Here's the enhanced version[:\s]*/i,
    /^Certainly[!,.\s]*/i,
    /^Sure[!,.\s]*/i
  ];

  for (const prefix of prefixesToRemove) {
    enhancedDescription = enhancedDescription.replace(prefix, '');
  }

  enhancedDescription = enhancedDescription.trim();

  console.log(`✅ Enhanced task prompt (${enhancedDescription.length} chars) using ${provider.name}/${model}`);

  return {
    enhancedDescription,
    originalDescription: description,
    model,
    provider: provider.id
  };
}
