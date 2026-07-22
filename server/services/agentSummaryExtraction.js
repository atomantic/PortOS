/**
 * Agent output summary extraction.
 *
 * Pure, dependency-light helpers that turn a raw agent output buffer into the
 * human-readable summary the UI shows. Extracted from `agentLifecycle.js` as a
 * leaf so BOTH the finalize path (`agentFinalization.js`) and the lifecycle
 * orchestrator can use them without either importing the other (issue #2837).
 */

import { extractCodexAssistantTail } from '../lib/codexAssistantExtract.js';

/**
 * Extract the final summary section from agent output.
 * Walks backwards from the end to find the last block of non-tool-call content.
 */
export function extractFinalSummary(outputBuffer) {
  if (!outputBuffer) return null;

  const codexTail = extractCodexAssistantTail(outputBuffer);
  if (codexTail) return codexTail;

  const lines = outputBuffer.split('\n');
  const contentLines = [];
  let foundContent = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const isTool = line.startsWith('🔧') || line.startsWith('  →') || line.startsWith('  ↳') || line.startsWith('[stderr]');

    if (!isTool && line.trim()) {
      contentLines.unshift(line);
      foundContent = true;
    } else if (foundContent && isTool) {
      break;
    }
  }

  const summary = contentLines.join('\n').trim();
  return summary || null;
}

const RE_SIMPLIFY_MARKER = /\/simplify/;
const RE_SIMPLIFY_ACTION = /\b(run|running|launch|now)\b/i;

export function extractSimplifySummaries(outputBuffer) {
  if (!outputBuffer) return null;

  // Codex CLI cannot execute slash commands like /simplify, so any match
  // inside its output is from a diff/grep dump that quotes source code.
  // Treat the assistant tail as the task summary and skip the simplify split.
  const codexTail = extractCodexAssistantTail(outputBuffer);
  if (codexTail) return { taskSummary: codexTail, simplifySummary: null };

  const lines = outputBuffer.split('\n');
  let simplifyIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (RE_SIMPLIFY_MARKER.test(lines[i]) && RE_SIMPLIFY_ACTION.test(lines[i])) {
      simplifyIdx = i;
      break;
    }
  }
  if (simplifyIdx < 0) return null;

  const taskSummary = extractFinalSummary(lines.slice(0, simplifyIdx).join('\n'));
  const simplifySummary = extractFinalSummary(lines.slice(simplifyIdx + 1).join('\n'));
  return { taskSummary, simplifySummary };
}
