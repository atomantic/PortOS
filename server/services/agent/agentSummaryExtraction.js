/**
 * Agent output summary extraction.
 *
 * Pure, dependency-light helpers that turn a raw agent output buffer into the
 * human-readable summary the UI shows. Extracted from `agentLifecycle.js` as a
 * leaf so BOTH the finalize path (`agentFinalization.js`) and the lifecycle
 * orchestrator can use them without either importing the other (issue #2837).
 */

import { SENTINEL_COMPLETION_MARKER, stripLifecycleLines } from '../../lib/agent/agentOutputMarkers.js';
import { extractCodexAssistantTail } from '../../lib/codexAssistantExtract.js';

// The run-scoped sentinel is authoritative across TUI providers. Select it
// before transcript heuristics, which can mistake thinking or quoted commands
// for an assistant reply or a /simplify boundary.
function extractSentinelSummary(outputBuffer) {
  const lines = outputBuffer.split('\n');
  const markerIndex = lines.findLastIndex(line => line.trim() === SENTINEL_COMPLETION_MARKER);
  if (markerIndex < 0) return null;
  return stripLifecycleLines(lines.slice(markerIndex + 1)).join('\n').trim() || null;
}

/**
 * Extract the final summary section from agent output.
 * Walks backwards from the end to find the last block of non-tool-call content.
 */
export function extractFinalSummary(outputBuffer) {
  if (!outputBuffer) return null;

  const sentinelSummary = extractSentinelSummary(outputBuffer);
  if (sentinelSummary) return sentinelSummary;

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
