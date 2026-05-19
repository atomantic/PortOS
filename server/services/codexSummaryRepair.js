// Lazy repair for agent task summaries that were saved before the
// `extractCodexAssistantTail` fix (commit 73c59162). Pre-fix Codex agents
// had their entire transcript persisted into metadata.json.taskSummary
// (often hundreds of KB to megabytes). When such an agent is loaded for
// display, this module re-extracts the real assistant tail from the
// matching output.txt and rewrites metadata.json in place.

import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tryReadFile } from '../lib/fileUtils.js';
import { extractCodexAssistantTail } from '../lib/codexAssistantExtract.js';

// Any taskSummary above this size is almost certainly a transcript dump —
// real assistant summaries are typically a few KB at most.
const WONKY_TASKSUMMARY_THRESHOLD = 20_000;

export function isWonkyTaskSummary(summary) {
  return typeof summary === 'string' && summary.length >= WONKY_TASKSUMMARY_THRESHOLD;
}

// Reads output.txt, re-extracts the Codex tail, and rewrites metadata.json.
// Returns the repaired summary string when a repair was applied, or null
// when no repair was needed/possible (also a no-op on non-Codex output).
// Also clears any wonky `simplifySummary` — Codex CLI cannot execute the
// `/simplify` slash command, so any pre-fix split was a false positive.
export async function repairCodexTaskSummary(agentDir, agent) {
  const storedTask = agent?.metadata?.taskSummary;
  const storedSimplify = agent?.metadata?.simplifySummary;
  const taskWonky = isWonkyTaskSummary(storedTask);
  const simplifyWonky = isWonkyTaskSummary(storedSimplify);
  if (!taskWonky && !simplifyWonky) return null;

  const outputFile = join(agentDir, 'output.txt');
  if (!existsSync(outputFile)) return null;

  const fullOutput = await tryReadFile(outputFile);
  if (!fullOutput) return null;

  const repaired = extractCodexAssistantTail(fullOutput);
  if (!repaired) return null;
  if (repaired === storedTask && !simplifyWonky) return null;

  const metaPath = join(agentDir, 'metadata.json');
  const rawContent = await tryReadFile(metaPath);
  if (!rawContent) return null;
  const raw = JSON.parse(rawContent);
  raw.metadata = { ...(raw.metadata || {}), taskSummary: repaired, simplifySummary: null };
  await writeFile(metaPath, JSON.stringify(raw, null, 2));

  const beforeSize = (storedTask?.length || 0) + (storedSimplify?.length || 0);
  console.log(`🔧 Repaired Codex task summary for ${agent.id} (${beforeSize} → ${repaired.length} chars)`);
  return repaired;
}
