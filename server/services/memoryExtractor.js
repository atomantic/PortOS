/**
 * Memory Extractor Service
 *
 * Extracts memories from agent output and task completion.
 * Supports structured MEMORY blocks and pattern-based extraction.
 */

import { createMemory } from './memory.js';
import { generateMemoryEmbedding } from './memoryEmbeddings.js';
import { cosEvents } from './cos.js';

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
 * Looks for common patterns that indicate learnings/observations
 */
function extractPatterns(output) {
  const memories = [];

  // Pattern: "I learned that..." or "I discovered that..."
  const learnedRegex = /(?:I\s+)?(?:learned|discovered|found out|realized|noticed)\s+that\s+(.+?)(?:\.|$)/gi;
  let match;
  while ((match = learnedRegex.exec(output)) !== null) {
    memories.push({
      type: 'learning',
      content: match[1].trim(),
      confidence: 0.6,
      category: 'other',
      tags: []
    });
  }

  // Pattern: "The codebase uses..." or "This project uses..."
  const usesRegex = /(?:The\s+)?(?:codebase|project|app|system)\s+uses\s+(.+?)(?:\.|$)/gi;
  while ((match = usesRegex.exec(output)) !== null) {
    memories.push({
      type: 'fact',
      content: `The codebase uses ${match[1].trim()}`,
      confidence: 0.7,
      category: 'codebase',
      tags: ['architecture']
    });
  }

  // Pattern: "User prefers..." or "The user wants..."
  const prefersRegex = /(?:The\s+)?user\s+(?:prefers|wants|likes|requested)\s+(.+?)(?:\.|$)/gi;
  while ((match = prefersRegex.exec(output)) !== null) {
    memories.push({
      type: 'preference',
      content: `User prefers ${match[1].trim()}`,
      confidence: 0.8,
      category: 'preferences',
      tags: ['user-preference']
    });
  }

  // Pattern: "I decided to..." or "We should..."
  const decidedRegex = /(?:I\s+)?(?:decided|chose)\s+to\s+(.+?)\s+because\s+(.+?)(?:\.|$)/gi;
  while ((match = decidedRegex.exec(output)) !== null) {
    memories.push({
      type: 'decision',
      content: `Decided to ${match[1].trim()} because ${match[2].trim()}`,
      confidence: 0.7,
      category: 'workflow',
      tags: ['decision']
    });
  }

  // Pattern: "Note:" or "Important:"
  const noteRegex = /(?:Note|Important|Remember):\s*(.+?)(?:\.|$)/gi;
  while ((match = noteRegex.exec(output)) !== null) {
    memories.push({
      type: 'context',
      content: match[1].trim(),
      confidence: 0.65,
      category: 'other',
      tags: ['note']
    });
  }

  return memories;
}

/**
 * Extract task-related context
 */
function extractTaskContext(task, output, success) {
  const memories = [];

  if (success && task.description) {
    // Successful task completion - extract what was done
    const summary = output.length > 500 ? output.substring(0, 500) + '...' : output;

    // Look for completion summary at end of output
    const summaryMatch = output.match(/(?:Summary|Done|Completed):\s*(.+?)(?:\n\n|$)/is);
    if (summaryMatch) {
      memories.push({
        type: 'learning',
        content: `Task "${task.description.substring(0, 100)}": ${summaryMatch[1].trim()}`,
        confidence: 0.75,
        category: 'workflow',
        tags: ['task-completion']
      });
    }
  }

  return memories;
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
 */
export async function extractAndStoreMemories(agentId, taskId, output, task = null) {
  const allMemories = [];

  // Parse structured memory blocks
  const structured = parseMemoryBlocks(output);
  allMemories.push(...structured);

  // Extract patterns from text
  const patterns = extractPatterns(output);
  allMemories.push(...patterns);

  // Extract task context
  if (task) {
    const taskContext = extractTaskContext(task, output, true);
    allMemories.push(...taskContext);
  }

  // Deduplicate
  const unique = deduplicateMemories(allMemories);

  // Filter by confidence
  const highConfidence = unique.filter(m => m.confidence >= 0.8);
  const mediumConfidence = unique.filter(m => m.confidence >= 0.5 && m.confidence < 0.8);

  const created = [];

  // Auto-save high confidence memories
  for (const mem of highConfidence) {
    const embedding = await generateMemoryEmbedding(mem);
    const memory = await createMemory({
      ...mem,
      sourceAgentId: agentId,
      sourceTaskId: taskId
    }, embedding);
    created.push(memory);
  }

  // Queue medium confidence for approval (just emit event for now)
  if (mediumConfidence.length > 0) {
    console.log(`🧠 ${mediumConfidence.length} memories pending approval`);
    cosEvents.emit('memory:approval-needed', {
      agentId,
      taskId,
      memories: mediumConfidence.map(m => ({
        type: m.type,
        content: m.content.substring(0, 200),
        confidence: m.confidence
      }))
    });
  }

  console.log(`🧠 Extracted ${created.length} memories from agent ${agentId}`);
  cosEvents.emit('memory:extracted', {
    agentId,
    taskId,
    count: created.length,
    pendingApproval: mediumConfidence.length
  });

  return {
    created: created.length,
    pendingApproval: mediumConfidence.length,
    memories: created
  };
}

/**
 * Manual extraction endpoint (for API)
 */
export async function extractFromOutput(agentId, taskId, output) {
  return extractAndStoreMemories(agentId, taskId, output);
}
