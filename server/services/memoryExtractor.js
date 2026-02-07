/**
 * Memory Extractor Service
 *
 * Extracts memories from agent output and task completion.
 * Supports structured MEMORY blocks and pattern-based extraction.
 */

import { createMemory } from './memory.js';
import { generateMemoryEmbedding } from './memoryEmbeddings.js';
import { cosEvents } from './cosEvents.js';
import * as notifications from './notifications.js';
import { classifyMemories, isAvailable as isClassifierAvailable } from './memoryClassifier.js';

/**
 * Parse structured MEMORY blocks from agent output
 * Format:
 * <MEMORY type="learning" category="codebase" confidence="0.9">
 * Content here
 * Tags: tag1, tag2
 * </MEMORY>
 */
function parseMemoryBlocks(output) {
  const memories = [];
  const memoryRegex = /<MEMORY\s+([^>]*)>([\s\S]*?)<\/MEMORY>/gi;

  let match;
  while ((match = memoryRegex.exec(output)) !== null) {
    const attrs = match[1];
    const content = match[2].trim();

    // Parse attributes
    const type = attrs.match(/type="([^"]+)"/)?.[1] || 'observation';
    const category = attrs.match(/category="([^"]+)"/)?.[1] || 'other';
    const confidence = parseFloat(attrs.match(/confidence="([^"]+)"/)?.[1] || '0.8');

    // Extract tags from content
    const tagsMatch = content.match(/Tags?:\s*(.+)$/mi);
    const tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()) : [];
    const cleanContent = content.replace(/Tags?:\s*.+$/mi, '').trim();

    memories.push({
      type,
      category,
      confidence,
      content: cleanContent,
      tags,
      structured: true
    });
  }

  return memories;
}

/**
 * Extract implicit patterns from agent output
 * Focuses on user preferences and values — not implementation details
 */
function extractPatterns(output) {
  const memories = [];
  let match;

  // Pattern: "User prefers..." or "The user wants..." or "User values..."
  const prefersRegex = /(?:The\s+)?user\s+(?:prefers|wants|likes|requested|values|cares about|insists on|prioritizes|expects)\s+(.+?)(?:\.|$)/gi;
  while ((match = prefersRegex.exec(output)) !== null) {
    const content = match[1].trim();
    // Only keep if substantive (not just a single word or implementation detail)
    if (content.length >= 15 && !isImplementationDetail(content)) {
      memories.push({
        type: 'preference',
        content: `User prefers ${content}`,
        confidence: 0.8,
        category: 'preferences',
        tags: ['user-preference']
      });
    }
  }

  // Pattern: User pushed back on something (reveals values)
  const pushbackRegex = /user\s+(?:pushed back on|rejected|didn't like|asked (?:us|me) to (?:change|redo|fix))\s+(.+?)(?:\.|$)/gi;
  while ((match = pushbackRegex.exec(output)) !== null) {
    const content = match[1].trim();
    if (content.length >= 15 && !isImplementationDetail(content)) {
      memories.push({
        type: 'preference',
        content: `User pushed back on: ${content}`,
        confidence: 0.8,
        category: 'values',
        tags: ['user-feedback', 'values']
      });
    }
  }

  return memories;
}

/**
 * Check if content is an implementation detail rather than a user insight
 */
function isImplementationDetail(content) {
  const lower = content.toLowerCase();

  // File paths, function names, component references
  if (/\.(jsx?|tsx?|css|json|md|py|sh|yml)\b/i.test(content)) return true;
  if (/(?:function|class|component|const|import|export|require)\s/i.test(content)) return true;

  // Specific code references (line numbers, variable names with dots)
  if (/\b(?:line\s+\d+|\.js\b|\.ts\b)/i.test(content)) return true;
  if (/[a-z]+\.[a-z]+\(/i.test(content)) return true;

  // CSS/styling specifics
  if (/\b(?:\d+px|#[0-9a-f]{3,8}|p[xytblr]-\d|sm:|md:|lg:)\b/i.test(content)) return true;

  // Package/dependency names
  if (/\b(?:npm|yarn|package\.json|node_modules|import\s+\{)\b/i.test(content)) return true;

  // Port numbers, URLs, endpoints
  if (/(?:port\s+\d{4}|localhost|\/api\/|endpoint)/i.test(content)) return true;

  // Architecture descriptions (easily discoverable)
  if (/\b(?:uses?\s+(?:express|react|vite|pm2|socket\.io|zod))\b/i.test(lower)) return true;
  if (/\b(?:monorepo|middleware|route\s+handler|service\s+layer)\b/i.test(lower)) return true;

  return false;
}

/**
 * Extract task-related context
 * Only extracts if the output reveals something about user preferences
 */
function extractTaskContext(_task, _output, _success) {
  // Task completion summaries are not useful memories — they're git history.
  // Only the LLM classifier should extract user-insight memories from task output.
  return [];
}

/**
 * Deduplicate memories by content similarity
 * Uses simple string comparison for now
 */
function deduplicateMemories(memories) {
  const unique = [];
  const seen = new Set();

  for (const memory of memories) {
    // Normalize content for comparison
    const normalized = memory.content.toLowerCase().replace(/\s+/g, ' ').trim();
    const key = `${memory.type}:${normalized.substring(0, 100)}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(memory);
    }
  }

  return unique;
}

/**
 * Main extraction function
 * Processes agent output and creates memories
 *
 * Uses LLM-based classification when available, falls back to pattern matching.
 */
export async function extractAndStoreMemories(agentId, taskId, output, task = null) {
  const allMemories = [];
  let usedLLM = false;

  // Try LLM-based classification first (if available)
  const classifierAvailable = await isClassifierAvailable().catch(() => false);

  if (classifierAvailable && task) {
    const llmResult = await classifyMemories(task, output).catch(err => {
      console.log(`⚠️ LLM memory classification failed: ${err.message}`);
      return null;
    });

    if (llmResult?.memories?.length > 0) {
      usedLLM = true;
      console.log(`🧠 LLM classified ${llmResult.memories.length} memories`);

      // Convert LLM results to our format
      for (const mem of llmResult.memories) {
        allMemories.push({
          type: mem.type || 'observation',
          category: mem.category || 'other',
          content: mem.content,
          confidence: mem.confidence || 0.7,
          tags: mem.tags || [],
          reasoning: mem.reasoning
        });
      }
    }
  }

  // Fall back to pattern-based extraction if LLM didn't produce results
  if (!usedLLM) {
    // Parse structured memory blocks
    const structured = parseMemoryBlocks(output);
    allMemories.push(...structured);

    // Extract patterns from text
    const patterns = extractPatterns(output);
    allMemories.push(...patterns);

    // Extract task context (but only if meaningful, not just task echoes)
    if (task) {
      const taskContext = extractTaskContext(task, output, true);
      // Filter out low-quality task context memories
      const filtered = taskContext.filter(m => {
        // Reject memories that just echo the task description
        if (m.content.startsWith(`Task "${task.description.substring(0, 50)}`)) return false;
        // Reject memories that are just "## Summary" or similar
        if (/^(##?\s*)?Summary\s*$/i.test(m.content)) return false;
        // Reject very short memories
        if (m.content.length < 30) return false;
        return true;
      });
      allMemories.push(...filtered);
    }
  }

  // Deduplicate
  const unique = deduplicateMemories(allMemories);

  // Filter by confidence — only high-quality memories pass through
  const highConfidence = unique.filter(m => m.confidence >= 0.85);
  const mediumConfidence = unique.filter(m => m.confidence >= 0.7 && m.confidence < 0.85);

  const created = [];

  // Extract appId from task metadata if available
  const sourceAppId = task?.metadata?.app || null;

  // Auto-save high confidence memories
  for (const mem of highConfidence) {
    const embedding = await generateMemoryEmbedding(mem);
    const memory = await createMemory({
      ...mem,
      sourceAgentId: agentId,
      sourceTaskId: taskId,
      sourceAppId
    }, embedding);
    created.push(memory);
  }

  // Store medium confidence memories as pending_approval
  const pendingMemories = [];
  for (const mem of mediumConfidence) {
    const embedding = await generateMemoryEmbedding(mem);
    const memory = await createMemory({
      ...mem,
      sourceAgentId: agentId,
      sourceTaskId: taskId,
      sourceAppId,
      status: 'pending_approval'
    }, embedding);
    pendingMemories.push(memory);
  }

  if (pendingMemories.length > 0) {
    console.log(`🧠 ${pendingMemories.length} memories pending approval`);
    cosEvents.emit('memory:approval-needed', {
      agentId,
      taskId,
      memories: pendingMemories.map(m => ({
        id: m.id,
        type: m.type,
        content: m.content.substring(0, 200),
        confidence: m.confidence
      }))
    });

    // Create notification for user
    for (const mem of pendingMemories) {
      const alreadyExists = await notifications.exists(
        notifications.NOTIFICATION_TYPES.MEMORY_APPROVAL,
        'memoryId',
        mem.id
      );
      if (!alreadyExists) {
        await notifications.addNotification({
          type: notifications.NOTIFICATION_TYPES.MEMORY_APPROVAL,
          title: `Memory needs approval`,
          description: mem.summary || mem.content.substring(0, 100),
          priority: notifications.PRIORITY_LEVELS.MEDIUM,
          link: '/cos/memory',
          metadata: {
            memoryId: mem.id,
            memoryType: mem.type,
            agentId,
            taskId
          }
        });
      }
    }
  }

  console.log(`🧠 Extracted ${created.length} memories from agent ${agentId}`);
  cosEvents.emit('memory:extracted', {
    agentId,
    taskId,
    count: created.length,
    pendingApproval: pendingMemories.length
  });

  return {
    created: created.length,
    pendingApproval: pendingMemories.length,
    memories: created,
    pendingMemories
  };
}

/**
 * Manual extraction endpoint (for API)
 */
export async function extractFromOutput(agentId, taskId, output) {
  return extractAndStoreMemories(agentId, taskId, output);
}
