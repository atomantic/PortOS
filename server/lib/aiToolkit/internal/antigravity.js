/** Shared Antigravity CLI provider constants, argument helpers, and catalog parsing. */

import { commandBasename } from './commandBasename.js';

export const ANTIGRAVITY_CLI_ID = 'antigravity-cli';
export const ANTIGRAVITY_TUI_ID = 'antigravity-tui';
export const LEGACY_GEMINI_CLI_ID = 'gemini-cli';
export const LEGACY_GEMINI_TUI_ID = 'gemini-tui';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';
export const ANTIGRAVITY_COMMAND = 'agy';

// Match by normalized binary basename so a path- or `.exe`-configured provider
// (`/opt/homebrew/bin/agy`, `agy.exe`) is still recognized.
export function isAntigravityCommand(command) {
  const base = commandBasename(command);
  return base === ANTIGRAVITY_COMMAND || base === 'antigravity';
}

// `agy models` prints one row per model on stdout (its "Fetching available
// models…" banner goes to stderr, so it never reaches this parser). Older
// builds printed a bare id per line; agy 2026-08 prints `<id>\t<Label>`:
//
//   gemini-3.6-flash-high\tGemini 3.6 Flash (High)
//   claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
//
// Both shapes are accepted — other installs run older agy builds, and a
// whole-line id match is what every previously-persisted catalog was parsed
// with. The label is anchored on a TAB rather than "first whitespace token" on
// purpose: a prose line ("Available models") would otherwise surrender a
// regex-valid first word and get persisted as a model id.
// Share the id charset with spawn-time validation. It matches cloudModelIdString
// without pulling host schema dependencies into the toolkit.
const MODEL_ID_CHARS = '[A-Za-z0-9][A-Za-z0-9._:/-]*';
const ANTIGRAVITY_MODEL_ID = new RegExp(`^${MODEL_ID_CHARS}$`);
const ANTIGRAVITY_MODEL_LINE = new RegExp(`^(${MODEL_ID_CHARS})(?:\\t.*)?$`);

/**
 * Validate a model id before a caller uses it in argv.
 * @param {unknown} id
 */
export function isAntigravityModelId(id) {
  return typeof id === 'string' && ANTIGRAVITY_MODEL_ID.test(id);
}

/**
 * Parse the ids out of `agy models` output, dropping blanks, banner/status
 * prose, and the configured-default sentinel (which the caller re-prepends).
 * @param {string} stdout - raw stdout from `agy models`
 * @returns {string[]} deduped ids, in the order the binary listed them
 */
export function parseAntigravityModelList(stdout) {
  const ids = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = ANTIGRAVITY_MODEL_LINE.exec(line.trim());
    if (match && match[1] !== ANTIGRAVITY_CONFIGURED_DEFAULT) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

export function isAntigravityCliProvider(provider) {
  return provider?.id === ANTIGRAVITY_CLI_ID || isAntigravityCommand(provider?.command);
}

// `--yolo` is a Gemini-CLI flag agy never accepted, and `-m` /
// `--output-format` / `-o` are legacy Gemini-CLI spellings agy still rejects (it
// takes the long `--model` only, and has no output-format flag). The LONG
// `--model` is deliberately NOT stripped — agy documents it as a per-session
// flag, so a user-baked pin is a real selection to preserve.
export function stripAntigravityUnsupportedArgs(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yolo') continue;
    if (arg === '-m' || arg === '--output-format' || arg === '-o') {
      i += 1;
      continue;
    }
    if (
      typeof arg === 'string'
      && (arg.startsWith('-m=') || arg.startsWith('--output-format=') || arg.startsWith('-o='))
    ) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

// `agy --print`/`-p`/`--prompt` takes the prompt as the flag's VALUE and does
// NOT read stdin. The host places the prompt immediately after the trailing
// flag at spawn time, after it applies per-run model and effort selections.
export const ANTIGRAVITY_PRINT_FLAGS = ['--print', '-p', '--prompt'];

// Both builders normalize stored argv for the legacy Gemini provider migration.
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
