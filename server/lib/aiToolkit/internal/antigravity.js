/**
 * Antigravity provider constants and argument helpers for the aiToolkit.
 *
 * Duplicated from server/lib/antigravity.js so the toolkit stays self-contained
 * (no imports out to sibling PortOS modules). Keep in sync with upstream.
 */

export const ANTIGRAVITY_CLI_ID = 'antigravity-cli';
export const ANTIGRAVITY_TUI_ID = 'antigravity-tui';
export const LEGACY_GEMINI_CLI_ID = 'gemini-cli';
export const LEGACY_GEMINI_TUI_ID = 'gemini-tui';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';

// Match by normalized binary basename so a path- or `.exe`-configured provider
// (`/opt/homebrew/bin/agy`, `agy.exe`) is still recognized. Inlined (not the
// shared commandBasename) to keep the vendored toolkit self-contained. Keep in
// sync with server/lib/antigravity.js#isAntigravityCommand.
export function isAntigravityCommand(command) {
  if (typeof command !== 'string' || command === '') return false;
  const base = command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  return base === 'agy' || base === 'antigravity';
}

export function isAntigravityCliProvider(provider) {
  return provider?.id === ANTIGRAVITY_CLI_ID || isAntigravityCommand(provider?.command);
}

export function stripAntigravityUnsupportedArgs(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yolo') continue;
    if (arg === '--model' || arg === '-m' || arg === '--output-format' || arg === '-o') {
      i += 1;
      continue;
    }
    if (
      typeof arg === 'string'
      && (arg.startsWith('--model=') || arg.startsWith('-m=') || arg.startsWith('--output-format=') || arg.startsWith('-o='))
    ) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

// `agy --print`/`-p`/`--prompt` takes the prompt as the flag's VALUE and does
// NOT read stdin. So the print flag must be the FINAL token (a marker); the host
// runner splices the prompt in right after it at spawn time. Keep in sync with
// server/lib/antigravity.js#ensureAntigravityPrintArgs — the host overrides the
// runner (setCliRunner), so the prompt injection itself lives host-side.
const ANTIGRAVITY_PRINT_FLAGS = ['--print', '-p', '--prompt'];

export function ensureAntigravityPrintArgs(args = []) {
  const out = stripAntigravityUnsupportedArgs(args).filter((arg) => !ANTIGRAVITY_PRINT_FLAGS.includes(arg));
  if (!out.includes('--dangerously-skip-permissions') && !out.includes('--sandbox')) {
    out.push('--dangerously-skip-permissions');
  }
  out.push('--print');
  return out;
}

export function ensureAntigravityTuiArgs(args = []) {
  const out = stripAntigravityUnsupportedArgs(args);
  if (!out.includes('--dangerously-skip-permissions') && !out.includes('--sandbox')) {
    out.push('--dangerously-skip-permissions');
  }
  return out;
}
