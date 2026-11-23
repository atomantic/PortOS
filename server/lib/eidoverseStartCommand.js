// Builds and upgrades the managed Eidoverse start command so it always loads the loopback preload.
import { fileURLToPath } from 'node:url';
import { parseCommandArgs } from './commandSecurity.js';

const PRELOAD_FILE = 'eidoverseLoopbackPreload.js';
export const EIDOVERSE_LOOPBACK_PRELOAD = fileURLToPath(new URL(`./${PRELOAD_FILE}`, import.meta.url));

const baseName = (token) => String(token ?? '').split(/[\\/]/).at(-1);
const isBun = (token) => /^bun(?:\.exe)?$/i.test(baseName(token));
const isPortosPreload = (token) => baseName(token) === PRELOAD_FILE;

// parseCommandArgs has no escape syntax, so quote with whichever quote is free.
const quoteToken = (token) => {
  if (token && !/[\s'"]/.test(token)) return token;
  return token.includes('"') ? `'${token}'` : `"${token}"`;
};

const bunCommand = (bun, args) => [bun, '--preload', EIDOVERSE_LOOPBACK_PRELOAD, ...args].map(quoteToken).join(' ');

/** The start command PortOS registers for a Bun executable. */
export const eidoverseStartCommand = (bun) => bunCommand(bun, ['--env-file=.env.portos', 'server/server.ts']);

/**
 * Put the loopback preload into a stored start command, keeping the operator's
 * Bun path and flags and replacing a preload path from an older install root.
 * Returns null when the command does not run Bun directly, so the preload cannot
 * be placed and the caller must fall back to `eidoverseStartCommand`.
 */
export function withLoopbackPreload(command) {
  const [bun, ...args] = parseCommandArgs(String(command ?? '').trim());
  if (!isBun(bun)) return null;
  const kept = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--preload' && isPortosPreload(args[i + 1])) i += 1;
    else if (!(args[i].startsWith('--preload=') && isPortosPreload(args[i]))) kept.push(args[i]);
  }
  return bunCommand(bun, kept);
}

/** Whether PM2's recorded args (array, or a string from older entries) load the current preload. */
export function hasLoopbackPreload(args) {
  const tokens = Array.isArray(args) ? args : parseCommandArgs(String(args ?? ''));
  return tokens[0] === '--preload' && tokens[1] === EIDOVERSE_LOOPBACK_PRELOAD;
}
