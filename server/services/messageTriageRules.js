import { join } from 'path';
import { z } from 'zod';
import { ServerError } from '../lib/errorHandler.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { atomicWrite, ensureDir, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';

const RULES_FILE = join(PATHS.messages, 'triage-rules.json');
const MISSING_STORE = Symbol('missing triage rules');
const rulesStoreSchema = z.object({
  rules: z.array(z.object({
    senderPattern: z.string(),
    correctedAction: z.string(),
    count: z.number().int().positive().optional()
  }).passthrough())
}).passthrough();

// One tail for the shared rules file: each load→mutate→save cycle must see the
// previous cycle's result or overlapping corrections/deletions drop writes.
const queueWrite = createFileWriteQueue();

async function loadRules() {
  await ensureDir(PATHS.messages);
  const { ok, value } = await readJSONFileStrict(RULES_FILE, MISSING_STORE, { logError: false });
  if (ok && value === MISSING_STORE) return { rules: [] };
  if (!ok || !rulesStoreSchema.safeParse(value).success) {
    throw new ServerError('Message triage rules storage is unavailable or invalid; original data preserved', {
      status: 503, code: 'MESSAGE_TRIAGE_RULES_UNAVAILABLE'
    });
  }
  return value;
}

async function saveRules(data) {
  await ensureDir(PATHS.messages);
  await atomicWrite(RULES_FILE, data);
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
export function recordCorrection({ from, subject, triaged, corrected }) {
  return queueWrite(() => applyCorrection({ from, subject, triaged, corrected }));
}

async function applyCorrection({ from, subject, triaged, corrected }) {
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
 * Delete a specific rule by index.
 */
export function deleteRule(index) {
  return queueWrite(async () => {
    const data = await loadRules();
    if (index < 0 || index >= data.rules.length) return false;
    data.rules.splice(index, 1);
    await saveRules(data);
    return true;
  });
}

/**
 * Get all rules (for UI display).
 */
export async function listRules() {
  const { rules } = await loadRules();
  return rules;
}
