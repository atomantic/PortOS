/**
 * Agent Content Generator Service
 *
 * Uses AI to generate posts and comments in an agent's unique voice/persona.
 * Includes recent activity context to avoid repetition.
 */

import { executeApiRun, executeCliRun, createRun } from './runner.js';
import { getActiveProvider, getProviderById } from './providers.js';
import * as agentActivity from './agentActivity.js';

/**
 * Parse JSON from AI response text (handles markdown blocks, extra text)
 */
export function parseAIJsonResponse(text) {
  let jsonStr = text.trim();

  if (!jsonStr) {
    throw new Error('AI returned empty response');
  }

  // Extract from markdown code blocks
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  // Extract just the JSON object
  const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    jsonStr = objectMatch[0];
  }

  return JSON.parse(jsonStr);
}

/**
 * Build persona system prompt from agent personality fields
 */
export function buildAgentSystemPrompt(agent, platform = 'moltbook') {
  const p = agent.personality || {};
  const introText = platform === 'moltworld'
    ? `You are ${agent.name}, an AI agent in Moltworld — a shared voxel world where AI agents move around a 480x480 grid, build structures, think out loud, and communicate with each other. You earn SIM tokens by staying online. You are openly an AI exploring and building in this virtual world.`
    : `You are ${agent.name}, an AI agent on Moltbook — a social platform where AI agents (called "molts") interact with each other. All participants are AI bots with their own personalities and perspectives. You are openly an AI and should embrace that identity naturally within your persona.`;
  const lines = [
    introText,
    p.promptPrefix && `Your persona: ${p.promptPrefix}`,
    p.style && `Communication style: ${p.style}`,
    p.tone && `Tone: ${p.tone}`,
    p.topics?.length && `Areas of interest: ${p.topics.join(', ')}`,
    p.quirks?.length && `Unique traits: ${p.quirks.join('; ')}`,
    'Write as this character naturally. Stay in character and engage with the community of fellow AI agents.'
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Fetch recent activity results to include in prompts
 */
export async function getRecentAgentContent(agentId, actionType, limit = 5) {
  const activities = await agentActivity.getActivities(agentId, {
    action: actionType,
    limit
  });

  return activities
    .filter(a => a.status === 'completed' && a.result)
    .map(a => ({
      timestamp: a.timestamp,
      ...a.result
    }));
}

/**
 * Run AI generation using the same pattern as agentPersonalityGenerator
 */
async function runAIGeneration(prompt, providerId, model, source) {
  let provider;
  if (providerId) {
    provider = await getProviderById(providerId).catch(() => null);
  }
  if (!provider) {
    provider = await getActiveProvider();
  }
  if (!provider) {
    throw new Error('No AI provider available for content generation');
  }

  const selectedModel = model || provider.defaultModel || provider.models?.[0];

  const { runId } = await createRun({
    providerId: provider.id,
    model: selectedModel,
    prompt,
    source
  });

  let responseText = '';
  const isCliProvider = provider.type === 'cli';

  await new Promise((resolve, reject) => {
    if (isCliProvider) {
      executeCliRun(
        runId,
        provider,
        prompt,
        process.cwd(),
        (text) => { responseText += text; },
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
      executeApiRun(
        runId,
        provider,
        selectedModel,
        prompt,
        process.cwd(),
        [],
        (data) => { responseText += typeof data === 'string' ? data : (data?.text || ''); },
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

  return { responseText, provider, selectedModel };
}

/**
 * Generate a Moltbook post in the agent's voice
 */
export async function generatePost(agent, context = {}, providerId = null, model = null) {
  const { submolt = 'general' } = context;

  console.log(`📝 Generating post for agent "${agent.name}" in ${submolt}`);

  const recentPosts = await getRecentAgentContent(agent.id, 'post', 5);
  const recentPostsSummary = recentPosts.length > 0
    ? recentPosts.map(p => `- "${p.title}" in ${p.submolt}`).join('\n')
    : 'No recent posts.';

  const systemPrompt = buildAgentSystemPrompt(agent);

  const prompt = `${systemPrompt}

## Task
Write a new post for the "${submolt}" submolt on Moltbook. Create an engaging title and thoughtful content that fits your persona.

## Recent Posts (avoid repeating similar topics)
${recentPostsSummary}

## Guidelines
- Title should be compelling and concise (under 100 chars)
- Content should be 2-5 paragraphs, written in markdown
- Stay in character and draw from your topics of interest
- Be original - don't rehash your recent posts
- Engage the community with a question or call to discussion

## Output Format
Respond with ONLY a valid JSON object (no markdown, no explanation):
{
  "title": "Your post title",
  "content": "Your post content in markdown"
}`;

  const { responseText, provider: usedProvider, selectedModel } = await runAIGeneration(
    prompt, providerId, model, 'agent-content-post'
  );

  const generated = parseAIJsonResponse(responseText);

  if (!generated.title || !generated.content) {
    throw new Error('Generated post missing title or content');
  }

  console.log(`✅ Generated post "${generated.title}" for ${agent.name} using ${usedProvider.name}/${selectedModel}`);

  return {
    title: generated.title,
    content: generated.content,
    submolt,
    _meta: {
      generatedBy: usedProvider.name,
      model: selectedModel,
      agentId: agent.id,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Generate a comment on a post in the agent's voice
 */
export async function generateComment(agent, post, existingComments = [], recentActivity = null, providerId = null, model = null) {
  console.log(`💬 Generating comment for agent "${agent.name}" on post "${post.title}"`);

  const recent = recentActivity || await getRecentAgentContent(agent.id, 'comment', 5);
  const recentSummary = recent.length > 0
    ? recent.map(c => `- Commented on post ${c.postId}`).join('\n')
    : 'No recent comments.';

  const commentContext = existingComments.length > 0
    ? existingComments.slice(0, 10).map(c => `- ${typeof c.author === 'object' ? c.author?.name : c.author || 'someone'}: ${(c.content || '').substring(0, 150)}`).join('\n')
    : 'No comments yet - you would be the first!';

  const systemPrompt = buildAgentSystemPrompt(agent);

  const prompt = `${systemPrompt}

## Task
Write a comment on this Moltbook post. Respond naturally as your character.

## Post
Title: ${post.title}
Author: ${typeof post.author === 'object' ? post.author?.name : post.author || 'unknown'}
Content: ${(post.content || '').substring(0, 1000)}

## Existing Comments
${commentContext}

## Your Recent Activity (avoid repetition)
${recentSummary}

## Guidelines
- Be conversational and engaging
- Add value - share perspective, ask a follow-up question, or build on the discussion
- Keep it 1-3 paragraphs
- Stay in character

## Output Format
Respond with ONLY a valid JSON object (no markdown, no explanation):
{
  "content": "Your comment in markdown"
}`;

  const { responseText, provider: usedProvider, selectedModel } = await runAIGeneration(
    prompt, providerId, model, 'agent-content-comment'
  );

  const generated = parseAIJsonResponse(responseText);

  if (!generated.content) {
    throw new Error('Generated comment missing content');
  }

  console.log(`✅ Generated comment for ${agent.name} using ${usedProvider.name}/${selectedModel}`);

  return {
    content: generated.content,
    _meta: {
      generatedBy: usedProvider.name,
      model: selectedModel,
      agentId: agent.id,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Generate a threaded reply to a specific comment
 */
export async function generateReply(agent, post, parentComment, recentActivity = null, providerId = null, model = null) {
  const parentAuthorName = typeof parentComment.author === 'object' ? parentComment.author?.name : parentComment.author;
  console.log(`↩️ Generating reply for agent "${agent.name}" to comment by ${parentAuthorName || 'someone'}`);

  const recent = recentActivity || await getRecentAgentContent(agent.id, 'comment', 5);
  const recentSummary = recent.length > 0
    ? recent.map(c => `- Replied on post ${c.postId}`).join('\n')
    : 'No recent replies.';

  const systemPrompt = buildAgentSystemPrompt(agent);

  const prompt = `${systemPrompt}

## Task
Write a reply to a specific comment on this Moltbook post.

## Post Context
Title: ${post.title}
Content: ${(post.content || '').substring(0, 500)}

## Comment You Are Replying To
Author: ${parentAuthorName || 'someone'}
Content: ${(parentComment.content || '').substring(0, 500)}

## Your Recent Activity (avoid repetition)
${recentSummary}

## Guidelines
- Directly address what the commenter said
- Be conversational and stay in character
- Keep it concise (1-2 paragraphs)

## Output Format
Respond with ONLY a valid JSON object (no markdown, no explanation):
{
  "content": "Your reply in markdown"
}`;

  const { responseText, provider: usedProvider, selectedModel } = await runAIGeneration(
    prompt, providerId, model, 'agent-content-reply'
  );

  const generated = parseAIJsonResponse(responseText);

  if (!generated.content) {
    throw new Error('Generated reply missing content');
  }

  console.log(`✅ Generated reply for ${agent.name} using ${usedProvider.name}/${selectedModel}`);

  return {
    content: generated.content,
    _meta: {
      generatedBy: usedProvider.name,
      model: selectedModel,
      agentId: agent.id,
      timestamp: new Date().toISOString()
    }
  };
}
