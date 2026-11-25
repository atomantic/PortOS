/**
 * Scrub revoked vault values from local Digital Twin and CoS run artifacts before forgetting their ciphertext.
 */

import { lstat, readdir, readFile } from 'fs/promises';
import { basename, join } from 'path';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { atomicWrite, PATHS, safeJSONParse } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { COS_AGENT_ID_RE, COS_ARCHIVE_DATE_RE } from '../lib/peerSyncValidation.js';
import { hasStoredPrivacyFacts, redactActivePrivateOutput, redactStoredPrivacyPrompt } from '../lib/privacyPrompt.js';
import { privacyFactPattern } from '../lib/privacyRecording.js';
import { ServerError } from '../lib/errorHandler.js';
import { withRuntimeFileTurn } from '../lib/runtimeFilePublication.js';
import { scrubAgentRecordings } from './cos/cosAgentStorage.js';
import { withStateLock } from './cos/cosState.js';

const scrubQueue = createFileWriteQueue();

async function missingAsNull(work) {
  return work.catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function readArtifact(path) {
  const stat = await missingAsNull(lstat(path));
  if (!stat?.isFile()) return null;
  return missingAsNull(readFile(path, 'utf8'));
}

async function* childDirectories(root, pattern) {
  const entries = await missingAsNull(readdir(root, { withFileTypes: true }));
  for (const entry of entries || []) {
    if (entry.isDirectory() && pattern.test(entry.name)) yield join(root, entry.name);
  }
}

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
  if (!activePrivateOutput && !promptHasFacts && !previewHasFacts && !privateAgentIds.has(metadata?.agentId)) return;

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
}

export async function scrubRevokedPrivacyFacts(encryptedValues) {
  if (encryptedValues.length === 0) return;
  // Keep ciphertext only while waiting for the scrub turn. Convert any failure
  // to a fixed error so paths, parse excerpts and values cannot reach a log.
  await scrubQueue(() => withBackupAssetPublication(async () => {
    const { decryptValue } = await import('../lib/vaultCrypto.js');
    const values = [...new Set(encryptedValues.map(decryptValue).filter(value => value.trim()))];
    if (values.length === 0) return;
    const pattern = privacyFactPattern(values);
    const scrubValue = text => text.replace(pattern, '[redacted]');
    const privateAgentIds = new Set();
    await withStateLock(async () => {
      for await (const directory of agentDirectories(PATHS.cosAgents)) {
        await scrubDirectory(directory, scrubValue, privateAgentIds, values);
      }
    });
    for await (const directory of childDirectories(PATHS.runs, COS_AGENT_ID_RE)) {
      await withRuntimeFileTurn(join(directory, 'output.txt'), () => scrubDirectory(directory, scrubValue, privateAgentIds));
    }
  })).catch(() => {
    throw new ServerError('Could not scrub local Digital Twin run artifacts', {
      status: 500, code: 'PRIVACY_RUN_SCRUB_FAILED',
    });
  });
}
