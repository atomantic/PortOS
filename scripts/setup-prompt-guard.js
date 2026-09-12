#!/usr/bin/env node
/** Non-interactive, machine-readable access to the same installer as the UI. */
import { getModelAbuseGuardStatus, installModelAbuseGuard } from '../server/services/modelAbuseGuard.js';

const mode = process.argv[2];
if (!['--status', '--install'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: node scripts/setup-prompt-guard.js --status | --install');
  process.exit(2);
}

const result = await (mode === '--status'
  ? getModelAbuseGuardStatus()
  : installModelAbuseGuard({ onEvent: (event) => console.error(JSON.stringify(event)) }));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ready === true ? 0 : 1);
