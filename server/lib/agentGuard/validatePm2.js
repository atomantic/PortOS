import { validatePm2Command } from '../commandSecurity.js';

const result = validatePm2Command(process.argv.slice(2));
if (!result.valid) {
  console.error(`🛑 PortOS agent guard: ${result.error}`);
  process.exitCode = 1;
}
