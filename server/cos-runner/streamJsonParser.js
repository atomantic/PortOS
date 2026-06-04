/**
 * CoS Runner — Stream-JSON parsing layer
 *
 * Self-contained — no imports, pure functions only — so the isolated
 * `portos-cos` PM2 process stays standalone.
 * NOTE: an equivalent parser also lives in server/services/agentCliSpawning.js
 * for the in-process spawn path; the two are intentionally separate copies
 * because cos-runner must not pull in the main server's dependency graph.
 */

/**
 * Summarize tool input into a concise description for display.
 */
export function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  const shorten = (p) => {
    if (!p || typeof p !== 'string') return '';
    const parts = p.split('/').filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
  };
  switch (toolName) {
    case 'Read':
      return shorten(input.file_path);
    case 'Edit':
      return shorten(input.file_path);
    case 'Write':
      return shorten(input.file_path);
    case 'Glob':
      return input.pattern || '';
    case 'Grep':
      return `"${(input.pattern || '').substring(0, 60)}"${input.path ? ` in ${shorten(input.path)}` : ''}`;
    case 'Bash': {
      const cmd = input.command || input.description || '';
      return cmd.substring(0, 80);
    }
    case 'Task':
      return input.description || '';
    case 'WebFetch':
      return shorten(input.url || '');
    case 'WebSearch':
      return `"${(input.query || '').substring(0, 60)}"`;
    case 'TodoWrite':
      return input.todos?.length ? `${input.todos.length} items` : '';
    case 'NotebookEdit':
      return shorten(input.notebook_path);
    case 'Skill':
      return input.skill || '';
    default:
      return '';
  }
}

export function safeParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * Create a Claude stream-json parser that extracts human-readable text from JSON stream events.
 * Returns a stateful parser with a `processChunk(data)` method that returns extracted text lines.
 */
export function createStreamJsonParser() {
  let lineBuffer = '';
  let finalResult = '';
  let textBuffer = '';
  // Track text across all conversation turns so multi-step agents (e.g., task + /simplify)
  // preserve all summaries instead of only the final one
  const textSections = [];
  let currentTextSection = '';
  const activeTools = new Map();

  // Commit accumulated text as a section (called at result events and stream end).
  // The committed section represents an agent turn's final wrap-up.
  const commitSection = () => {
    const section = currentTextSection.trim();
    if (section) {
      textSections.push(section);
      currentTextSection = '';
    }
  };

  // At a tool-call boundary the accumulated text is interim narration ("Now let me…")
  // that gets superseded by whatever the agent says after the tool returns. Discard it
  // so only the final post-last-tool wrap-up survives into textSections.
  const discardSection = () => { currentTextSection = ''; };

  const processChunk = (rawData) => {
    const lines = [];
    lineBuffer += rawData;

    const parts = lineBuffer.split('\n');
    lineBuffer = parts.pop() || '';

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;

      let parsed;
      parsed = safeParse(trimmed);
      if (!parsed) continue;

      if (parsed.type === 'stream_event') {
        const event = parsed.event;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = event.delta.text;
          textBuffer += text;
          currentTextSection += text;
          const textLines = textBuffer.split('\n');
          textBuffer = textLines.pop() || '';
          for (const tl of textLines) {
            lines.push(tl);
          }
        }
        // Accumulate tool input JSON deltas
        if (event?.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
          const idx = event.index;
          const tool = activeTools.get(idx);
          if (tool) {
            tool.inputJson += event.delta.partial_json || '';
          }
        }
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const toolName = event.content_block.name || 'unknown';
          const idx = event.index;
          activeTools.set(idx, { name: toolName, inputJson: '' });
          lines.push(`🔧 Using ${toolName}...`);
          discardSection();
        }
        // Emit detailed summary when tool input is complete
        if (event?.type === 'content_block_stop') {
          const idx = event.index;
          const tool = activeTools.get(idx);
          if (tool) {
            if (tool.inputJson) {
              const input = safeParse(tool.inputJson);
              if (input) {
                const detail = summarizeToolInput(tool.name, input);
                if (detail) {
                  lines.push(`  → ${detail}`);
                }
              }
            }
            activeTools.delete(idx);
          }
        }
      }

      if (parsed.type === 'assistant') {
        const content = parsed.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && typeof block.content === 'string') {
              const firstLine = block.content.split('\n')[0]?.substring(0, 200);
              if (firstLine) {
                lines.push(`  ↳ ${firstLine}`);
              }
            }
          }
        }
      }

      if (parsed.type === 'result') {
        if (textBuffer) {
          lines.push(textBuffer);
          textBuffer = '';
        }
        commitSection();
        finalResult = parsed.result || '';
      }
    }

    return lines;
  };

  const flush = () => {
    const lines = [];
    if (textBuffer) {
      lines.push(textBuffer);
      textBuffer = '';
    }
    commitSection();
    return lines;
  };

  // Multi-section: return all text turns combined (e.g., task summary + simplify summary)
  // Single-section: return the CLI result field (cleaner, no tool call noise)
  const getFinalResult = () => {
    if (textSections.length > 1) {
      return textSections.join('\n\n');
    }
    return finalResult;
  };

  return { processChunk, flush, getFinalResult };
}
