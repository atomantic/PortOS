/**
 * Memory Extractor Service
 *
 * Extracts memories from agent output and task completion.
 * Supports structured MEMORY blocks and pattern-based extraction.
 */

import { createMemory, searchMemories, getMemories } from './memoryBackend.js';
import { generateMemoryEmbedding } from './memoryEmbeddings.js';
import { cosEvents } from './cosEvents.js';
import * as notifications from './notifications.js';
import { classifyMemories, isAvailable as isClassifierAvailable } from './memoryClassifier.js';

const DEDUP_SIMILARITY_THRESHOLD = 0.82;

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

const normalizeText = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Deduplicate memories within a single extraction batch
 */
function deduplicateMemories(memories) {
  const unique = [];
  const seen = new Set();

  for (const memory of memories) {
    const key = `${memory.type}:${normalizeText(memory.content).substring(0, 100)}`;

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(memory);
    }
  }

  return unique;
}

/**
 * Check if a proposed memory duplicates an existing active or pending memory.
 * Uses vector similarity for active memories and text prefix matching for pending.
 */
async function findExistingDuplicate(embedding, content, pendingMemories) {
  if (embedding) {
    const results = await searchMemories(embedding, {
      minRelevance: DEDUP_SIMILARITY_THRESHOLD,
      limit: 3
    }).catch(err => {
      console.log(`⚠️ Dedup vector search failed: ${err.message}`);
      return { memories: [] };
    });

    if (results.memories.length > 0) {
      return results.memories[0];
    }
  }

  // Also check pending_approval memories (searchMemories only returns active)
  if (pendingMemories.length > 0) {
    const normalizedContent = normalizeText(content).substring(0, 80);
    for (const mem of pendingMemories) {
      if (normalizeText(mem.content).substring(0, 80) === normalizedContent) {
        return mem;
      }
    }
  }

  return null;
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

  const sourceAppId = task?.metadata?.app || null;

  // Pre-fetch pending memories once for dedup checks across both loops
  const pendingForDedup = await getMemories({ status: 'pending_approval' })
    .catch(err => {
      console.log(`⚠️ Failed to load pending memories for dedup: ${err.message}`);
      return { memories: [] };
    });

  let skippedDuplicates = 0;

  async function dedupAndCreate(mem, extraFields = {}) {
    const embedding = await generateMemoryEmbedding(mem);
    const existing = await findExistingDuplicate(embedding, mem.content, pendingForDedup.memories);
    if (existing) {
      console.log(`🧠 Skipping duplicate memory (similar to "${normalizeText(existing.content).substring(0, 60)}…")`);
      skippedDuplicates++;
      return null;
    }
    return createMemory({
      ...mem, sourceAgentId: agentId, sourceTaskId: taskId, sourceAppId, ...extraFields
    }, embedding);
  }

  const created = [];
  for (const mem of highConfidence) {
    const memory = await dedupAndCreate(mem);
    if (memory) created.push(memory);
  }

  const pendingMemories = [];
  for (const mem of mediumConfidence) {
    const memory = await dedupAndCreate(mem, { status: 'pending_approval' });
    if (memory) pendingMemories.push(memory);
  }

  if (pendingMemories.length > 0) {
    console.log(`🧠 ${pendingMemories.length} memories pending approval`);
    cosEvents.emit('memory:approval-needed', {
      agentId,
      taskId,
      memories: pendingMemories.map(m => ({
        id: m.id,
        type: m.type,
        content: (m.content || '').slice(0, 500),
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
          description: (mem.summary || mem.content || '').slice(0, 300),
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

  if (skippedDuplicates > 0) {
    console.log(`🧠 Skipped ${skippedDuplicates} duplicate memories from agent ${agentId}`);
  }
  console.log(`🧠 Extracted ${created.length} memories from agent ${agentId}`);
  cosEvents.emit('memory:extracted', {
    agentId,
    taskId,
    count: created.length,
    pendingApproval: pendingMemories.length,
    skippedDuplicates
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
