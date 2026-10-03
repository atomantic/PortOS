#!/usr/bin/env node
// CLI face of server/lib/voiceModelAssets.js for scripts/setup-voice.sh and
// setup-voice.ps1, so the shell and PowerShell installers share one completion
// contract (receipt format, sidecar validation, hash check) instead of each
// re-implementing it.
//
//   voice-asset.js state <whisper|piper> <primary-path>   print verified|unverified|incomplete|missing
//                                                         (re-hashes a receipted asset)
//   voice-asset.js receipt <whisper|piper> <primary-path> record completion after promotion
//   voice-asset.js check-config <piper-config.json>       exit 0 when a usable Piper config

import { readFileSync } from 'fs';
import {
  isValidPiperConfig, verifyVoiceAssetHashes, writeVoiceAssetReceipt,
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
  console.error('usage: voice-asset.js state|receipt <whisper|piper> <path> | check-config <file>');
  return 2;
};

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => { console.error(`❌ voice-asset ${command}: ${err.message}`); process.exitCode = 1; });
