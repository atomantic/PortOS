import { commandBasename } from './providerModels.js';

export const ANTIGRAVITY_CLI_ID = 'antigravity-cli';
export const ANTIGRAVITY_TUI_ID = 'antigravity-tui';
export const LEGACY_GEMINI_CLI_ID = 'gemini-cli';
export const LEGACY_GEMINI_TUI_ID = 'gemini-tui';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';

// Match by normalized binary basename (like isGrokCommand/isOpencodeCommand) so
// a path- or `.exe`-configured provider (`/opt/homebrew/bin/agy`, `agy.exe`) is
// still recognized. Exact-string matching here would let prepareCliPrompt fall
// through to stdin delivery for a path-configured agy — losing the prompt AND
// leaving the trailing `--print` marker dangling (buildCliArgs adds it by
// provider id, which DOES survive a path command).
export function isAntigravityCommand(command) {
  const base = commandBasename(command);
  return base === 'agy' || base === 'antigravity';
}

export function isAntigravityCliProvider(provider) {
  return provider?.id === ANTIGRAVITY_CLI_ID || isAntigravityCommand(provider?.command);
}

// agy print flags. Unlike the old Gemini CLI (which read the prompt from stdin),
// `agy --print`/`-p`/`--prompt` takes the prompt as the flag's VALUE and does
// NOT read stdin at all. So the print flag must be the FINAL token, with the
// prompt spliced in right after it at spawn time by prepareAntigravityPrompt.
export const ANTIGRAVITY_PRINT_FLAGS = ['--print', '-p', '--prompt'];

export function ensureAntigravityPrintArgs(args = []) {
  // Drop any bare print flag the caller baked in — we re-add exactly one as the
  // trailing marker. (PortOS always supplies the prompt itself, so a
  // user-configured print flag never carries a prompt value to preserve.)
  const out = stripAntigravityUnsupportedArgs(args).filter((arg) => !ANTIGRAVITY_PRINT_FLAGS.includes(arg));
  if (!out.includes('--dangerously-skip-permissions') && !out.includes('--sandbox')) {
    out.push('--dangerously-skip-permissions');
  }
  // Print flag LAST: it is a marker with no value here. A bare trailing --print
  // is NOT a runnable invocation on its own — prepareAntigravityPrompt injects
  // the prompt as its value before the process is spawned. Leaving another flag
  // (e.g. --dangerously-skip-permissions) after --print would make agy consume
  // THAT flag as the prompt text (the bug that shipped the flag name to the
  // model instead of the task — see server/lib/antigravity.js history).
  out.push('--print');
  return out;
}

const NOOP_CLEANUP = () => {};

/**
 * Spawn-time prompt delivery for the antigravity CLI: splice the prompt in as
 * the VALUE of the trailing print flag (agy does not read stdin). Mirrors the
 * `{ args, useStdin, cleanup }` shape of grok.js#prepareGrokPromptFile so the
 * spawn sites can dispatch through a single helper (see prepareCliPrompt).
 *
 * @param {string[]} args - argv as built by ensureAntigravityPrintArgs
 * @param {string} prompt - the full prompt text
 * @returns {{ args: string[], useStdin: false, cleanup: () => void }}
 */
export function prepareAntigravityPrompt(args = [], prompt = '') {
  const out = [...args];
  // Find the LAST print flag so the prompt lands as its value even if the argv
  // carries stray tokens (it shouldn't, post-ensureAntigravityPrintArgs).
  let idx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (ANTIGRAVITY_PRINT_FLAGS.includes(out[i])) { idx = i; break; }
  }
  if (idx === -1) {
    out.push('--print', prompt);
  } else {
    out.splice(idx + 1, 0, prompt);
  }
  return { args: out, useStdin: false, cleanup: NOOP_CLEANUP };
}

// TUI mode launches the interactive bubbletea REPL (NO --print) and the prompt
// is delivered by bracketed-paste after the input-ready handshake — never as an
// argv value. So, unlike the CLI path, there is no print flag to accidentally
// swallow --dangerously-skip-permissions: the flag stays a real boolean and the
// permission auto-approval actually takes effect. Do NOT add --print here.
export function ensureAntigravityTuiArgs(args = []) {
  const out = stripAntigravityUnsupportedArgs(args);
  if (!out.includes('--dangerously-skip-permissions') && !out.includes('--sandbox')) {
    out.push('--dangerously-skip-permissions');
  }
  return out;
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
