/** Operator cleanup of historical, untagged Digital Twin scoring runs and test-response excerpts. */
import { basename, join } from 'node:path';
import { atomicWrite, PATHS, rmGuarded, safeJSONParse, UUID_RE } from '../lib/fileUtils.js';
import { PRIVACY_SELF_SUBJECT_ID, PRIVACY_SENSITIVE_TYPES } from '../lib/privacyConstants.js';
import { privacyFactPattern } from '../lib/privacyRecording.js';
import { withRuntimeFileTurn } from '../lib/runtimeFilePublication.js';
import { ServerError } from '../lib/errorHandler.js';
import { applyFeedbackMerge } from './feedbackStore.js';
import { childDirectories, readArtifact, withPrivacyScrub } from './privacyScrubFiles.js';

// The runner recorded the workflow family, but not the stage name. Match the
// opening and the excerpt delimiter of shipped and inline scoring templates.
const signatures = [
  ['behavioral', '# Soul Test Scorer\n\nYou are grading one behavioral test of a digital twin.', "\n## Twin's Response\n"],
  ['adversarial', "You are grading whether a response HELD or BREACHED a person's stated boundary", '\nThe response to grade:\n'],
  ['values', "You are grading whether a response is consistent with a specific person's ranked values.", '\nThe response to grade:\n'],
  ['values', "You are grading whether a response is consistent with a person's ranked values.", '\nThe response to grade:\n'],
  ['multi-turn', 'You are grading whether a digital twin stayed CONSISTENT across a multi-turn conversation.', '\nThe conversation that took place (user turns and the twin\'s replies, in order):\n'],
];

function isFinishedTwinRun(directory, metadata) {
  return metadata?.source === 'digital-twin' && metadata.type === 'ai' && UUID_RE.test(metadata.id)
    && basename(directory) === metadata.id && Number.isFinite(Date.parse(metadata.endTime));
}

function scorerKind(metadata, prompt) {
  // Keep evidence after a value that coincides with template text is erased.
  const text = prompt?.replaceAll('\r\n', '\n') ?? '';
  return signatures.find(([kind, opening, delimiter]) => metadata.privacyScrubbedScorer === kind
    || (text.startsWith(opening) && text.includes(delimiter)))?.[0];
}

export function historicalRedactor(values) {
  const pattern = privacyFactPattern(values);
  // A literal vault value such as "redacted" can also occur inside our marker.
  const marker = '[redacted]';
  return text => text.replace(pattern, (match, offset) => {
    if (!marker.includes(match)) return marker;
    const from = Math.max(0, offset - marker.length + match.length);
    const start = text.slice(from, offset + marker.length).lastIndexOf(marker) + from;
    return start >= from && start <= offset && offset + match.length <= start + marker.length ? match : marker;
  });
}

export async function scrubHistoricalScorer(directory, metadata, prompt, scrub) {
  if (!isFinishedTwinRun(directory, metadata)) return false;
  const kind = scorerKind(metadata, prompt);
  if (!kind) return false;
  const patch = {};
  const writes = [];
  for (const name of ['output.txt', 'tui-response.txt']) {
    const path = join(directory, name);
    const text = await readArtifact(path);
    if (text === null) continue;
    const clean = scrub(text);
    if (text === clean) continue;
    writes.push([path, clean]);
    if (name === 'output.txt' && typeof metadata.outputSize === 'number') patch.outputSize = Buffer.byteLength(clean);
  }
  const cleanedPrompt = prompt === null ? null : scrub(prompt);
  if (typeof metadata.prompt === 'string') {
    const preview = prompt !== null && metadata.prompt === prompt.slice(0, 500)
      ? cleanedPrompt.slice(0, 500) : scrub(metadata.prompt);
    if (metadata.prompt !== preview) patch.prompt = preview;
  }
  if (typeof metadata.error === 'string' && scrub(metadata.error) !== metadata.error) patch.error = scrub(metadata.error);
  const diagnostic = metadata.errorAnalysis?.message;
  if (typeof diagnostic === 'string' && scrub(diagnostic) !== diagnostic) {
    patch.errorAnalysis = { ...metadata.errorAnalysis, message: scrub(diagnostic) };
  }
  if (cleanedPrompt !== prompt) writes.push([join(directory, 'prompt.txt'), cleanedPrompt]);
  if (!writes.length && !Object.keys(patch).length) return false;
  // Publish attribution before changing the full prompt. A failed write can
  // be retried even if a fact occurs inside the original template signature.
  if (Object.keys(patch).length || metadata.privacyScrubbedScorer !== kind) {
    await atomicWrite(join(directory, 'metadata.json'), { ...metadata, ...patch, privacyScrubbedScorer: kind });
  }
  for (const [path, clean] of writes) await atomicWrite(path, clean);
  return true;
}

function unavailable() {
  return new ServerError('Selected artifact or Vault fact is unavailable for historical cleanup', {
    status: 404, code: 'PRIVACY_ARTIFACT_NOT_FOUND',
  });
}

function candidate(kind, id, date, scorer) {
  const time = Date.parse(date);
  return { kind, id, date: Number.isFinite(time) ? new Date(time).toISOString() : null, ...(scorer && { scorer }) };
}

export async function updateHistoricalFeedback(request, scrub) {
  const candidates = [];
  let changed = 0;
  let found = false;
  await applyFeedbackMerge(data => {
    for (const entry of data?.entries ?? []) {
      if (entry?.contentType !== 'test_response' || typeof entry.contentSnippet !== 'string') continue;
      if (request.action === 'list') {
        if (UUID_RE.test(entry.id) && entry.contentSnippet) candidates.push(candidate('feedback', entry.id, entry.createdAt));
        continue;
      }
      if (request.action === 'delete' && entry.id !== request.id) continue;
      found = true;
      // Clear the generated excerpt only. Keeping the immutable entry ID and
      // rating also prevents a normal peer merge restoring the old excerpt.
      const cleaned = scrub ? scrub(entry.contentSnippet) : '';
      if (entry.contentSnippet !== cleaned) {
        entry.contentSnippet = cleaned;
        changed++;
      }
    }
    return { changed: changed > 0, merged: data };
  }, async path => {
    const raw = await readArtifact(path);
    if (raw === null) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.entries)) throw new Error('Invalid feedback store');
    return data;
  });
  if (request.action === 'delete' && !found) throw unavailable();
  return { changed, candidates };
}

async function selectedCiphertext(recordId) {
  const { query } = await import('../lib/db.js');
  const { rows } = await query(
    'SELECT value_enc FROM privacy_vault_records WHERE id = $1 AND subject_id = $2 AND NOT (type = ANY($3::text[]))',
    [recordId, PRIVACY_SELF_SUBJECT_ID, PRIVACY_SENSITIVE_TYPES],
  );
  if (!rows.length) throw unavailable();
  return rows[0].value_enc;
}

export function cleanHistoricalTwinArtifacts(request) {
  if (request.action === 'delete' && (!UUID_RE.test(request.id) || !['run', 'feedback'].includes(request.kind))) {
    throw unavailable();
  }
  return withPrivacyScrub(async encrypted => {
    let scrub;
    if (request.action === 'scrub') {
      const { decryptValue } = await import('../lib/vaultCrypto.js');
      const value = decryptValue(encrypted);
      if (!value.trim()) throw unavailable();
      scrub = historicalRedactor([value]);
    }
    const candidates = [];
    let changed = 0;
    if (request.kind !== 'feedback') {
      for await (const directory of childDirectories(PATHS.runs, UUID_RE)) {
        if (request.id && basename(directory) !== request.id) continue;
        await withRuntimeFileTurn(join(directory, 'output.txt'), async () => {
          const metadata = safeJSONParse(await readArtifact(join(directory, 'metadata.json')), null);
          if (!isFinishedTwinRun(directory, metadata)) return;
          if (request.action === 'delete') {
            await rmGuarded(directory, { recursive: true });
            changed++;
            return;
          }
          const prompt = await readArtifact(join(directory, 'prompt.txt'));
          if (request.action === 'list') {
            candidates.push(candidate('run', metadata.id, metadata.startTime, scorerKind(metadata, prompt) || 'unclassified'));
          } else if (await scrubHistoricalScorer(directory, metadata, prompt, scrub)) {
            changed++;
          }
        });
      }
      if (request.action === 'delete' && !changed) throw unavailable();
    }
    if (request.kind !== 'run') {
      const feedback = await updateHistoricalFeedback(request, scrub);
      changed += feedback.changed;
      candidates.push(...feedback.candidates);
    }
    return request.action === 'list' ? { candidates } : { changed };
  }, request.action === 'scrub' ? () => selectedCiphertext(request.recordId) : undefined);
}
