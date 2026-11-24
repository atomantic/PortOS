#!/usr/bin/env node
// CLI face of server/lib/voiceModelAssets.js for scripts/setup-voice.sh and
// setup-voice.ps1, so the shell and PowerShell installers share one completion
// contract (receipt format, sidecar validation, hash check, pinned HF URLs)
// instead of each re-implementing it.
//
//   voice-asset.js state <whisper|piper> <primary-path>   print verified|unverified|incomplete|missing
//                                                         (re-hashes a receipted asset)
//   voice-asset.js receipt <whisper|piper> <primary-path> record completion after promotion
//   voice-asset.js check-config <piper-config.json>       exit 0 when a usable Piper config
//   voice-asset.js url <whisper|piper> <name>             print pinned HuggingFace URL (base URL for piper)
//   voice-asset.js verify-archive <archive-name> <file>   exit 0 only when the file matches the pinned Piper archive sha256
//   voice-asset.js verify-model <asset-name> <file>       exit 0 when a curated catalog asset matches its pinned sha256 (or is custom)

import { readFileSync } from 'fs';
import {
  isValidPiperConfig,
  piperVoiceBaseUrl,
  verifyVoiceArchiveSha256,
  verifyVoiceAssetHashes,
  verifyVoiceModelSha256,
  whisperModelUrl,
  writeVoiceAssetReceipt,
} from '../server/lib/voiceModelAssets.js';

const [command, ...args] = process.argv.slice(2);

const main = async () => {
  if (command === 'state') {
    const { state, reason } = await verifyVoiceAssetHashes(args[0], args[1]);
    console.log(state);
    if (reason) console.error(`ℹ️  ${args[1]}: ${reason}`);
    return 0;
  }
  if (command === 'receipt') {
    await writeVoiceAssetReceipt(args[0], args[1]);
    return 0;
  }
  if (command === 'check-config') {
    return isValidPiperConfig(readFileSync(args[0], 'utf8')) ? 0 : 1;
  }
  if (command === 'url') {
    if (args[0] === 'whisper') {
      console.log(whisperModelUrl(args[1]));
      return 0;
    }
    if (args[0] === 'piper') {
      console.log(piperVoiceBaseUrl(args[1]));
      return 0;
    }
    throw new Error(`unknown url kind: ${args[0] ?? ''}`);
  }
  if (command === 'verify-archive') {
    // Test runners stub the download, so they may swap the digest table; a real run never can.
    const table = process.env.VITEST && process.env.PORTOS_TEST_ARCHIVE_SHA256
      ? JSON.parse(process.env.PORTOS_TEST_ARCHIVE_SHA256) : undefined;
    await verifyVoiceArchiveSha256(args[0], args[1], table);
    return 0;
  }
  if (command === 'verify-model') {
    // Test runners stub the download, so they may swap the digest table; a real run never can.
    const table = process.env.VITEST && process.env.PORTOS_TEST_MODEL_SHA256
      ? JSON.parse(process.env.PORTOS_TEST_MODEL_SHA256) : undefined;
    await verifyVoiceModelSha256(args[0], args[1], table);
    return 0;
  }
  console.error('usage: voice-asset.js state|receipt|url <whisper|piper> <arg> | check-config <file> | verify-archive|verify-model <name> <file>');
  return 2;
};

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => { console.error(`❌ voice-asset ${command}: ${err.message}`); process.exitCode = 1; });
