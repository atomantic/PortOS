import { safeParse } from '../lib/streamJsonParser.js';

/**
 * Read a single Claude Code child pipe. Splash reports thinking counts in the
 * raw Messages delta, which Claude Code's final result does not carry. Keep
 * only the terminal answer and a counts-only verdict from the first turn.
 */
export function createClaudeCodeMessages() {
  let pending = '';
  let sessionId;
  let terminal;
  let ambiguous = false;
  let turns = 0;
  let active = false;
  let answerText = false;
  let thinking = false;
  let stopSeen = false;
  let limit;

  const readLine = (line) => {
    if (!line.trim()) return;
    const row = safeParse(line);
    if (!row || typeof row.type !== 'string') { ambiguous = true; return; }

    if (row.type === 'system' && row.subtype === 'init') {
      if (sessionId || typeof row.session_id !== 'string' || !row.session_id) ambiguous = true;
      sessionId = row.session_id;
      return;
    }
    if (row.type === 'result') {
      if (terminal) { ambiguous = true; return; }
      terminal = { sessionId: row.session_id, text: typeof row.result === 'string' ? row.result : '', success: row.subtype === 'success' && row.is_error === false };
      return;
    }
    if (row.parent_tool_use_id != null) return;
    if (row.type === 'assistant' && turns === 0) ambiguous = true;
    if (row.type !== 'stream_event') return;
    if (!sessionId || row.session_id !== sessionId || terminal) { ambiguous = true; return; }

    const event = row.event;
    if (event?.type === 'message_start') {
      if (active) ambiguous = true;
      active = true;
      turns += 1;
    } else if (event?.type === 'message_stop') {
      if (!active || (turns === 1 && !stopSeen)) ambiguous = true;
      active = false;
    } else if (turns === 1 && active) {
      if (event?.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'thinking' || block?.type === 'redacted_thinking') thinking = true;
        else if (block?.type === 'text' && typeof block.text === 'string') answerText ||= block.text.length > 0;
        else ambiguous = true;
      }
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        if (typeof event.delta.text === 'string') answerText ||= event.delta.text.length > 0;
        else ambiguous = true;
      }
      if (event?.type === 'message_delta' && event.delta?.stop_reason != null) {
        if (stopSeen) ambiguous = true;
        stopSeen = true;
        const outputTokens = event.usage?.output_tokens;
        const thinkingTokens = event.usage?.output_tokens_details?.thinking_tokens;
        if (event.delta.stop_reason === 'max_tokens' && Number.isSafeInteger(outputTokens)
          && Number.isSafeInteger(thinkingTokens) && thinkingTokens > 0 && thinkingTokens <= outputTokens) {
          limit = { stopReason: 'max_tokens', outputTokens, thinkingTokens };
        }
      }
    } else if (!active) {
      ambiguous = true;
    }
  };

  return {
    push(chunk) {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) readLine(line);
    },
    finish() {
      readLine(pending);
      const attributable = !ambiguous && !active && thinking && !answerText && terminal?.success
        && terminal.sessionId === sessionId;
      return { text: terminal?.text ?? '', reasoningOutputLimit: attributable ? limit : undefined };
    },
  };
}
