/**
 * Scrub revoked vault values from local Digital Twin and CoS run artifacts before forgetting their ciphertext.
 */

import { basename, join } from 'path';
import { atomicWrite, PATHS, safeJSONParse } from '../lib/fileUtils.js';
import { COS_AGENT_ID_RE, COS_ARCHIVE_DATE_RE } from '../lib/peerSyncValidation.js';
import { hasStoredPrivacyFacts, redactActivePrivateOutput, redactStoredPrivacyPrompt } from '../lib/privacyPrompt.js';
import { withRuntimeFileTurn } from '../lib/runtimeFilePublication.js';
import { scrubAgentRecordings } from './cos/cosAgentStorage.js';
import { childDirectories, readArtifact, withPrivacyScrub } from './privacyScrubFiles.js';
import { historicalRedactor, scrubHistoricalScorer, updateHistoricalFeedback } from './privacyTwinHistory.js';
import { withStateLock } from './cos/cosState.js';

async function* agentDirectories(root) {
  for await (const path of childDirectories(root, COS_AGENT_ID_RE)) {
    if (COS_ARCHIVE_DATE_RE.test(basename(path))) {
      yield* childDirectories(path, COS_AGENT_ID_RE);
    } else {
      yield path;
    }
  }
}

async function scrubDirectory(directory, scrubValue, privateAgentIds, values) {
  const promptPath = join(directory, 'prompt.txt');
  const prompt = await readArtifact(promptPath);
  const promptHasFacts = prompt !== null && hasStoredPrivacyFacts(prompt);
  const metadataPath = join(directory, 'metadata.json');
  const metadata = values ? null : safeJSONParse(await readArtifact(metadataPath), null);
  const preview = typeof metadata?.prompt === 'string' ? metadata.prompt : null;
  const previewHasFacts = preview !== null && hasStoredPrivacyFacts(preview);
  const outputPath = join(directory, 'output.txt');
  const activePrivateOutput = redactActivePrivateOutput(outputPath, scrubValue);
  if (!activePrivateOutput && !promptHasFacts && !previewHasFacts && !privateAgentIds.has(metadata?.agentId)) {
    if (!values) return scrubHistoricalScorer(directory, metadata, prompt, scrubValue);
    return;
  }

  if (values) {
    privateAgentIds.add(basename(directory));
    await scrubAgentRecordings(directory, values);
  }
  const stored = promptHasFacts ? redactStoredPrivacyPrompt(prompt) : prompt;
  const output = await readArtifact(outputPath);
  const metadataPatch = {};
  if (output !== null) {
    const cleaned = scrubValue(output);
    if (cleaned !== output) await atomicWrite(outputPath, cleaned);
    const size = Buffer.byteLength(cleaned);
    if (typeof metadata?.outputSize === 'number' && size !== metadata.outputSize) metadataPatch.outputSize = size;
  }
  if (previewHasFacts || (promptHasFacts && preview !== null)) {
    const storedPreview = (promptHasFacts ? stored : redactStoredPrivacyPrompt(preview)).slice(0, 500);
    if (storedPreview !== preview) metadataPatch.prompt = storedPreview;
  }
  if (Object.keys(metadataPatch).length) await atomicWrite(metadataPath, { ...metadata, ...metadataPatch });
  // Preserve the provenance marker after the rewrite so later vault
  // revocations can still find outputs from the same historical request.
  if (stored !== prompt) await atomicWrite(promptPath, stored);
  if (!values) await scrubHistoricalScorer(directory, { ...metadata, ...metadataPatch }, stored, scrubValue);
}

export async function scrubRevokedPrivacyFacts(encryptedValues) {
  if (encryptedValues.length === 0) return;
  // Keep ciphertext only while waiting for the scrub turn. Convert any failure
  // to a fixed error so paths, parse excerpts and values cannot reach a log.
  await withPrivacyScrub(async () => {
    const { decryptValue } = await import('../lib/vaultCrypto.js');
    const values = [...new Set(encryptedValues.map(decryptValue).filter(value => value.trim()))];
    if (values.length === 0) return;
    const scrubValue = historicalRedactor(values);
    const privateAgentIds = new Set();
    await withStateLock(async () => {
      for await (const directory of agentDirectories(PATHS.cosAgents)) {
        await scrubDirectory(directory, scrubValue, privateAgentIds, values);
      }
    });
    for await (const directory of childDirectories(PATHS.runs, COS_AGENT_ID_RE)) {
      await withRuntimeFileTurn(join(directory, 'output.txt'), () => scrubDirectory(directory, scrubValue, privateAgentIds));
    }
    await updateHistoricalFeedback({ action: 'scrub' }, scrubValue);
  });
}
