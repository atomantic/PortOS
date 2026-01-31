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
 * Looks for common patterns that indicate learnings/observations
 */
function extractPatterns(output) {
  const memories = [];
  let match;

  // Pattern: "I learned that..." or "I discovered that..."
  const learnedRegex = /(?:I\s+)?(?:learned|discovered|found out|realized|noticed)\s+that\s+(.+?)(?:\.|$)/gi;
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

  // Pattern: "No Issues Found" / "No issues detected" / "No fixes required"
  // High confidence - this is a clear finding that something is working well
  const noIssuesRegex = /\*\*(?:No\s+(?:Issues?|Problems?|Errors?|Bugs?)\s+Found|No\s+(?:fixes?|changes?)\s+(?:required|needed|necessary))\*\*/gi;
  if (noIssuesRegex.test(output)) {
    memories.push({
      type: 'observation',
      content: 'Analysis found no issues requiring fixes',
      confidence: 0.85,
      category: 'codebase',
      tags: ['audit-result', 'no-action-needed']
    });
  }

  // Pattern: "already well-optimized" / "already has excellent" / "already implemented"
  // Exclude colons to prevent truncated memories like "Already has excellent responsive design:"
  const alreadyWorkingRegex = /(?:already|currently)\s+(?:has\s+)?(?:excellent|good|great|proper|well[- ]?optimized|well[- ]?implemented|working\s+well|fully\s+implemented)\s+([^\n.:]+)/gi;
  while ((match = alreadyWorkingRegex.exec(output)) !== null) {
    const captured = match[1].trim();
    // Skip if capture is too short or empty
    if (captured.length < 5) continue;
    memories.push({
      type: 'fact',
      content: `Already has excellent ${captured}`,
      confidence: 0.85,
      category: 'codebase',
      tags: ['existing-feature', 'no-action-needed']
    });
  }

  // Pattern: Conclusion sections - extract the actual conclusion content
  const conclusionRegex = /#{1,3}\s*Conclusion\s*\n+(.+?)(?:\n\n|\n#|$)/gis;
  while ((match = conclusionRegex.exec(output)) !== null) {
    const conclusion = match[1].trim().replace(/\n/g, ' ').substring(0, 300);
    if (conclusion.length > 20) {
      memories.push({
        type: 'learning',
        content: conclusion,
        confidence: 0.85,
        category: 'codebase',
        tags: ['conclusion', 'audit-result']
      });
    }
  }

  // Pattern: "The application/UI/system is..." followed by positive assessment
  const assessmentRegex = /(?:The\s+)?(?:application|app|UI|system|codebase|code)\s+(?:is|has)\s+(?:already\s+)?(?:well[- ]?(?:optimized|designed|structured|implemented)|properly\s+(?:configured|set up)|fully\s+(?:functional|working))/gi;
  while ((match = assessmentRegex.exec(output)) !== null) {
    memories.push({
      type: 'observation',
      content: match[0].trim(),
      confidence: 0.8,
      category: 'codebase',
      tags: ['assessment', 'status']
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

  // Filter by confidence
  const highConfidence = unique.filter(m => m.confidence >= 0.8);
  const mediumConfidence = unique.filter(m => m.confidence >= 0.5 && m.confidence < 0.8);

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
