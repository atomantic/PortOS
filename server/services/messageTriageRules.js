import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';

const RULES_FILE = join(PATHS.messages, 'triage-rules.json');

async function loadRules() {
  await ensureDir(PATHS.messages);
  const content = await readFile(RULES_FILE, 'utf-8').catch(() => null);
  if (!content) return { rules: [] };
  return safeJSONParse(content, { rules: [] }, { context: 'triage-rules' });
}

async function saveRules(data) {
  await ensureDir(PATHS.messages);
  await writeFile(RULES_FILE, JSON.stringify(data, null, 2));
}

/**
 * Get all triage rules for injection into the LLM prompt.
 */
export async function getTriageRules() {
  const { rules } = await loadRules();
  return rules;
}

/**
 * Record a user correction: when they take a different action than the AI recommended.
 * Deduplicates by pattern — if the same sender/pattern already has a rule, update it.
 */
export async function recordCorrection({ from, subject, triaged, corrected }) {
  const data = await loadRules();
  // Build a pattern from the sender — strip email-specific parts for generalization
  const senderPattern = from || 'Unknown';
  // Check if we already have a rule for this sender+action combo
  const existing = data.rules.find(r =>
    r.senderPattern === senderPattern && r.correctedAction === corrected
  );
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.lastSeen = new Date().toISOString();
    existing.exampleSubject = subject;
  } else {
    data.rules.push({
      senderPattern,
      exampleSubject: subject || '',
      originalAction: triaged,
      correctedAction: corrected,
      count: 1,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    });
  }
  await saveRules(data);
  console.log(`📧 Triage rule recorded: "${senderPattern}" ${triaged} -> ${corrected}`);
}

/**
 * Build a prompt section describing user triage preferences.
 */
export async function buildRulesPromptSection() {
  const rules = await getTriageRules();
  if (!rules.length) return '';

  const lines = rules.map(r =>
    `- Emails from "${r.senderPattern}" should be "${r.correctedAction}" (not "${r.originalAction}"). Example subject: "${r.exampleSubject}"`
  );
  return `\n\nUser triage preferences (ALWAYS follow these rules — they override your default judgment):\n${lines.join('\n')}\n`;
}

/**
 * Delete a specific rule by index.
 */
export async function deleteRule(index) {
  const data = await loadRules();
  if (index < 0 || index >= data.rules.length) return false;
  data.rules.splice(index, 1);
  await saveRules(data);
  return true;
}

/**
 * Get all rules (for UI display).
 */
export async function listRules() {
  const { rules } = await loadRules();
  return rules;
}
