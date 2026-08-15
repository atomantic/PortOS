#!/usr/bin/env node
/**
 * Point Windows' "Default terminal application" at the classic console host so
 * programmatically-allocated consoles stop being handed off to Windows Terminal.
 *
 * Background: a console-less process (every PM2 fork, so all of PortOS) that
 * spawns a console child makes Windows allocate a new console. Under the
 * default terminal setting that allocation is COM-handed to Windows Terminal,
 * which starts `OpenConsole.exe -Embedding` plus a terminal window that takes
 * foreground focus and dies with the child. Pointing the delegation at
 * conhost.exe keeps the console headless-ish and non-stealing.
 *
 * This is the machine-wide half of the fix and helps every app on the box, not
 * just PortOS — see docs/WINDOWS_CONSOLE.md. The PortOS half (defaulting
 * `windowsHide: true` on every spawn) lives in server/lib/childProcess.js.
 *
 * Writes only HKCU\Console\%%Startup for the current user. Reversible with
 * --revert, inspectable with --show.
 */

import { execFileSync } from '../server/lib/childProcess.js';

// Console-host delegation CLSIDs. These identify which COM server Windows hands
// a newly allocated console to.
const CONHOST = '{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}'; // Windows Console Host
const LET_WINDOWS_DECIDE = '{00000000-0000-0000-0000-000000000000}'; // → Windows Terminal on Win11

const KEY = 'HKCU\\Console\\%%Startup';
const VALUES = ['DelegationConsole', 'DelegationTerminal'];

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

if (process.platform !== 'win32') {
  console.log('ℹ️  Not Windows — nothing to do (the console handoff is Windows-only)');
  process.exit(0);
}

/**
 * Read both delegation values in one `reg query`. Values are absent entirely on
 * a machine that has never changed the setting, which reads the same as "Let
 * Windows decide" and is reported as such.
 * @returns {Record<string, string|null>}
 */
function readValues() {
  // try/catch is required: `reg query` exits non-zero when the key does not
  // exist, which is a normal state, not an error. This runs outside Express, so
  // an uncaught throw would take the process down rather than reach middleware.
  let out = '';
  try {
    out = execFileSync('reg', ['query', KEY], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    out = '';
  }
  return Object.fromEntries(
    VALUES.map((name) => {
      const match = out.match(new RegExp(`${name}\\s+REG_SZ\\s+(\\{[0-9A-Fa-f-]+\\})`, 'i'));
      return [name, match ? match[1].toUpperCase() : null];
    })
  );
}

/**
 * @param {string} name
 * @param {string} guid
 */
function writeValue(name, guid) {
  execFileSync('reg', ['add', KEY, '/v', name, '/t', 'REG_SZ', '/d', guid, '/f'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

/**
 * Human-readable name for a delegation CLSID.
 * @param {string|null} guid
 * @returns {string}
 */
function describe(guid) {
  if (guid === null) return 'not set (Windows default → Windows Terminal)';
  if (guid === CONHOST) return 'Windows Console Host (conhost.exe)';
  if (guid === LET_WINDOWS_DECIDE) return 'Let Windows decide (→ Windows Terminal on Windows 11)';
  return `${guid} (a third-party terminal)`;
}

function report(label) {
  const values = readValues();
  console.log(`📋 ${label}:`);
  for (const name of VALUES) console.log(`   ${name} = ${describe(values[name])}`);
}

if (has('--show')) {
  report('Default terminal application');
  process.exit(0);
}

const revert = has('--revert');
const target = revert ? LET_WINDOWS_DECIDE : CONHOST;

report('Before');
for (const name of VALUES) writeValue(name, target);
report('After');

if (revert) {
  console.log('↩️  Reverted to "Let Windows decide" — console windows may flash and steal focus again');
} else {
  console.log('✅ Default terminal set to Windows Console Host');
  console.log('   New console apps stop handing off to Windows Terminal. Already-running');
  console.log('   processes keep their current console; restart PortOS (or PM2) to apply.');
  console.log('   You can still open Windows Terminal yourself — this only changes what');
  console.log('   happens when a program allocates a console on its own.');
}
