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

import { execFileSync } from 'node:child_process';

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
 * Read one delegation value, or null when the key/value does not exist yet
 * (a machine that has never changed the setting has no key at all).
 * @param {string} name
 * @returns {string|null}
 */
function readValue(name) {
  // try/catch is required here: `reg query` exits non-zero for "value not set",
  // which is a normal state, not an error. This runs outside Express, so an
  // uncaught throw would take the process down rather than reach middleware.
  try {
    const out = execFileSync('reg', ['query', KEY, '/v', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const match = out.match(/REG_SZ\s+(\{[0-9A-Fa-f-]+\})/);
    return match ? match[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} name
 * @param {string} guid
 */
function writeValue(name, guid) {
  execFileSync('reg', ['add', KEY, '/v', name, '/t', 'REG_SZ', '/d', guid, '/f'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
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
  console.log(`📋 ${label}:`);
  for (const name of VALUES) console.log(`   ${name} = ${describe(readValue(name))}`);
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
