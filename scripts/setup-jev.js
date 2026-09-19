#!/usr/bin/env node
/** Non-interactive, machine-readable access to the same installer as the UI. */
import { getJevStatus, installJev } from '../server/services/jev.js';

const mode = process.argv[2];
if (!['--status', '--install'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: node scripts/setup-jev.js --status | --install');
  process.exit(2);
}

const result = await (mode === '--status'
  ? getJevStatus()
  : installJev({ onEvent: (event) => console.error(JSON.stringify(event)) }));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ready === true ? 0 : 1);
