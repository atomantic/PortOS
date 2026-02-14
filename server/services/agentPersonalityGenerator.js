/**
 * Agent Personality Generator Service
 *
 * Uses AI to generate unique agent personalities based on a name or brief description.
 * Generates style, tone, topics, quirks, and prompt prefix for social platform agents.
 */

import { executeApiRun, executeCliRun, createRun } from './runner.js';
import { getActiveProvider, getProviderById } from './providers.js';

const GENERATION_PROMPT = `You are creating a unique AI agent personality for a social media platform where AI agents interact with each other and humans.

## Input
{inputSection}

## Your Task
Generate a complete, unique personality profile for this agent. The personality should feel authentic, consistent, and engaging for social interactions.

## Output Format
Respond with ONLY a valid JSON object (no markdown, no explanation) with this exact structure:

{
  "name": "A creative, memorable name for this agent (2-3 words max)",
  "description": "A 1-2 sentence description of who this agent is and what they're about",
  "personality": {
    "style": "One of: professional, casual, witty, academic, creative",
    "tone": "A phrase describing their communication tone (e.g., 'warm and encouraging', 'dry and sarcastic', 'enthusiastic but precise')",
    "topics": ["topic1", "topic2", "topic3"],
    "quirks": ["unique behavior 1", "unique behavior 2"],
    "promptPrefix": "Instructions for how this agent should communicate. Include their perspective, what they care about, how they engage with content."
  },
  "avatar": {
    "emoji": "A single emoji that represents this agent",
    "color": "#HEXCOLOR"
  }
}

## Guidelines
- Make the personality distinctive and memorable
- The name should be creative and fit the personality (e.g., "Captain Clarity", "Zen Master Zara", "Tech Whisperer")
- Topics should be 3-5 specific areas of expertise or interest
- Quirks should be 2-3 unique communication habits (e.g., "uses nautical metaphors", "asks follow-up questions", "includes relevant quotes")
- The promptPrefix should be 2-4 sentences that would help an AI embody this personality
- Choose a color that matches the personality's vibe
- Be creative but coherent - all elements should work together

Generate the personality now:`;

/**
 * Generate a complete agent personality using AI
 *
 * @param {Object} seed - Seed data with any pre-filled fields
 * @param {string} seed.name - Optional agent name
 * @param {string} seed.description - Optional description
 * @param {Object} seed.personality - Optional personality fields
 * @param {Object} seed.avatar - Optional avatar fields
 * @param {string} providerId - Optional specific provider to use
 * @param {string} model - Optional specific model to use
 * @returns {Promise<Object>} Generated personality data including name
 */
export async function generateAgentPersonality(seed = {}, providerId = null, model = null) {
  const { name = '', description = '', personality = {}, avatar = {} } = seed;
  const hasName = name && name.trim().length > 0;
  const hasDescription = description && description.trim().length > 0;

  console.log(`🎨 Generating personality${hasName ? ` for "${name}"` : ' (full generation)'}`);

  // Get provider
  let provider;
  if (providerId) {
    provider = await getProviderById(providerId).catch(() => null);
  }
  if (!provider) {
    provider = await getActiveProvider();
  }

  if (!provider) {
    throw new Error('No AI provider available for personality generation');
  }

  // Determine model
  const selectedModel = model || provider.defaultModel || provider.models?.[0];

  // Build the input section based on what's provided as seed content
  const seedLines = [];

  if (hasName) {
    seedLines.push(`Name: ${name.trim()}`);
  } else {
    seedLines.push('Name: (generate a creative name)');
  }

  if (hasDescription) {
    seedLines.push(`Description: ${description.trim()}`);
  }

  if (personality.style && personality.style !== 'casual') {
    seedLines.push(`Style: ${personality.style} (use this style)`);
  }

  if (personality.tone) {
    seedLines.push(`Tone: ${personality.tone} (build on this tone)`);
  }

  if (personality.topics?.length > 0) {
    seedLines.push(`Topics: ${personality.topics.join(', ')} (include these and add more)`);
  }

  if (personality.quirks?.length > 0) {
    seedLines.push(`Quirks: ${personality.quirks.join(', ')} (include these and add more)`);
  }

  if (personality.promptPrefix) {
    seedLines.push(`Prompt Prefix hint: ${personality.promptPrefix}`);
  }

  if (avatar.emoji) {
    seedLines.push(`Emoji: ${avatar.emoji} (use this emoji)`);
  }

  if (avatar.color && avatar.color !== '#3b82f6') {
    seedLines.push(`Color: ${avatar.color} (use this color)`);
  }

  const inputSection = seedLines.length > 1
    ? seedLines.join('\n')
    : 'No seed content provided - create a completely unique and creative agent personality!';

  // Build the prompt
  const fullPrompt = GENERATION_PROMPT.replace('{inputSection}', inputSection);

  // Create a run for this generation
  const { runId } = await createRun({
    providerId: provider.id,
    model: selectedModel,
    prompt: fullPrompt,
    source: 'agent-personality-generation'
  });

  // Collect the response
  let responseText = '';

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
          responseText += text;
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
        selectedModel,
        fullPrompt,
        process.cwd(),
        [],
        (data) => {
          responseText += typeof data === 'string' ? data : (data?.text || '');
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

  // Parse the JSON response
  responseText = responseText.trim();

  // Check for empty response
  if (!responseText) {
    console.error('❌ AI returned empty response for personality generation');
    throw new Error('AI returned empty response. The provider may be unavailable - try a different provider or try again.');
  }

  // Extract JSON from response (handle markdown code blocks if present)
  let jsonStr = responseText;
  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  // Also try to extract just the object if there's extra text
  const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    jsonStr = objectMatch[0];
  }

  let generated;
  try {
    generated = JSON.parse(jsonStr);
  } catch (parseError) {
    console.error(`❌ Failed to parse generated personality: ${parseError.message}`);
    console.error(`Response was: ${responseText.substring(0, 500)}`);
    throw new Error('Failed to parse AI response as JSON. Please try again.');
  }

  // Validate required fields
  if (!generated.personality?.style || !generated.personality?.tone) {
    throw new Error('Generated personality missing required fields. Please try again.');
  }

  // Use provided name or generated name
  const finalName = hasName ? name.trim() : (generated.name || 'Unnamed Agent');

  // Ensure arrays exist
  generated.personality.topics = generated.personality.topics || [];
  generated.personality.quirks = generated.personality.quirks || [];
  generated.personality.promptPrefix = generated.personality.promptPrefix || '';

  // Ensure avatar exists
  generated.avatar = generated.avatar || { emoji: '🤖', color: '#3b82f6' };

  // Set the name in the response
  generated.name = finalName;

  console.log(`✅ Generated personality for "${finalName}" using ${provider.name}/${selectedModel}`);

  return {
    ...generated,
    _meta: {
      generatedBy: provider.name,
      model: selectedModel,
      timestamp: new Date().toISOString()
    }
  };
}
