/**
 * Task Enhancer Service
 *
 * Uses AI to enhance task descriptions/prompts to be more detailed,
 * actionable, and comprehensive for agent execution.
 *
 * Uses the 'cos-task-enhance' prompt stage for provider/model configuration.
 */

import { executeApiRun, executeCliRun, createRun } from './runner.js';
import { getActiveProvider, getProviderById } from './providers.js';
import { getStage, buildPrompt } from './promptService.js';

const STAGE_NAME = 'cos-task-enhance';

/**
 * Fallback enhancement prompt template (used if stage template not found)
 */
const FALLBACK_PROMPT = `You are a task prompt enhancer for an AI agent system. Your job is to take a brief task description, research the relevant parts of the codebase, and produce a comprehensive, codebase-informed prompt that an AI coding agent can execute effectively.

## Process

### Step 1: Research the Codebase

Before writing the enhanced prompt, investigate the codebase to understand:
- Which files and directories are relevant to this task
- Existing patterns, conventions, and code structure in those areas
- Related functionality that may be affected
- Any tests, configs, or documentation that should be updated

Use your tools to search for files, read relevant code, and understand the current state. Focus your research on what's directly relevant to the task.

### Step 2: Plan the Approach

Based on your research, determine:
- The specific files that need to be created or modified
- The order of changes and any dependencies between them
- Patterns to follow from existing code
- Tests that should be run or written
- Potential pitfalls or edge cases specific to this codebase

### Step 3: Write the Enhanced Prompt

Produce a detailed prompt that gives the executing agent everything it needs to complete the task without redundant exploration. Include:
- Specific file paths discovered during research
- Code patterns and conventions to follow (with examples from the codebase)
- Step-by-step implementation plan grounded in the actual code structure
- Success criteria and verification steps
- Any caveats or constraints discovered during research

## Original Task Description
{description}

{contextSection}

## Your Enhanced Prompt

Research the codebase, then provide an enhanced version of this task that an AI agent can execute. The prompt should be grounded in actual file paths, existing patterns, and codebase structure — not generic advice. Output ONLY the enhanced prompt text, nothing else. Do not include any preamble like "Here is the enhanced prompt:" - just output the prompt itself.`;

/**
 * Enhance a task prompt using AI
 *
 * @param {string} description - The original task description
 * @param {string} context - Optional additional context
 * @returns {Promise<{enhancedDescription: string, originalDescription: string, model: string, provider: string}>}
 */
export async function enhanceTaskPrompt(description, context = '') {
  console.log(`✨ Enhancing task prompt: "${description.substring(0, 50)}..."`);

  // Get prompt stage configuration for cos-task-enhance
  const stage = getStage(STAGE_NAME);

  // Determine provider and model from stage config or fallback
  let provider;
  let model;

  if (stage?.provider) {
    // Use stage-configured provider
    provider = await getProviderById(stage.provider).catch(() => null);
    model = stage.model || provider?.defaultModel;
  }

  // Fallback to active provider if stage provider not available
  if (!provider) {
    provider = await getActiveProvider();
    model = stage?.model || provider?.defaultModel || provider?.models?.[0];
  }

  if (!provider) {
    throw new Error('No AI provider available for enhancement');
  }

  // Build the enhancement prompt using stage template or fallback
  let fullPrompt;
  const templatePrompt = await buildPrompt(STAGE_NAME, { description, context }).catch(() => null);

  if (templatePrompt) {
    fullPrompt = templatePrompt;
  } else {
    // Fallback to hardcoded template
    const contextSection = context ? `## Additional Context\n${context}` : '';
    fullPrompt = FALLBACK_PROMPT
      .replace('{description}', description)
      .replace('{contextSection}', contextSection);
  }

  // Create a run for this enhancement
  const { runId } = await createRun({
    providerId: provider.id,
    model,
    prompt: fullPrompt,
    source: 'task-enhancement'
  });

  // Collect the response
  let enhancedDescription = '';

  // Use appropriate execution method based on provider type
  const isCliProvider = provider.type === 'cli';

  await new Promise((resolve, reject) => {
    if (isCliProvider) {
      // CLI providers use executeCliRun
      executeCliRun(
        runId,
        provider,
        fullPrompt,
        process.cwd(),
        (text) => {
          enhancedDescription += text;
        },
        (result) => {
          if (result?.error || result?.success === false) {
            reject(new Error(result?.error || 'CLI execution failed'));
          } else {
            resolve(result);
          }
        },
        provider.timeout || 300000
      );
    } else {
      // API providers use executeApiRun
      executeApiRun(
        runId,
        provider,
        model,
        fullPrompt,
        process.cwd(),
        [], // No screenshots needed
        (data) => {
          enhancedDescription += typeof data === 'string' ? data : (data?.text || '');
        },
        (result) => {
          if (result?.error) {
            reject(new Error(result.error));
          } else {
            resolve(result);
          }
        }
      );
    }
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

  // Fall back to original description if enhancement returned empty
  if (!enhancedDescription) {
    console.warn(`⚠️ Task enhancement returned empty result from ${provider.name}/${model}, using original`);
    return {
      enhancedDescription: description,
      originalDescription: description,
      model,
      provider: provider.id,
      fallback: true
    };
  }

  console.log(`✅ Enhanced task prompt (${enhancedDescription.length} chars) using ${provider.name}/${model}`);

  return {
    enhancedDescription,
    originalDescription: description,
    model,
    provider: provider.id
  };
}
