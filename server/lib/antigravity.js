import { buildEffortArgs, commandBasename, extractBakedModel, hasModelFlag, resolveCliEffort, resolveCliModel, splitAntigravityModel, stripBrokenModelFlags } from './providerModels.js';

export const ANTIGRAVITY_CLI_ID = 'antigravity-cli';
export const ANTIGRAVITY_TUI_ID = 'antigravity-tui';
export const LEGACY_GEMINI_CLI_ID = 'gemini-cli';
export const LEGACY_GEMINI_TUI_ID = 'gemini-tui';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';
// The shipped executable. Exported because the reviewer vocabulary needs to map
// its `antigravity` slug to a real command (cosValidation's
// REVIEWER_CLI_BINARIES) — retyping the string there is how a rename drifts.
export const ANTIGRAVITY_COMMAND = 'agy';

// Match by normalized binary basename (like isGrokCommand/isOpencodeCommand) so
// a path- or `.exe`-configured provider (`/opt/homebrew/bin/agy`, `agy.exe`) is
// still recognized. Exact-string matching here would let prepareCliPrompt fall
// through to stdin delivery for a path-configured agy — losing the prompt AND
// leaving the trailing `--print` marker dangling (buildCliArgs adds it by
// provider id, which DOES survive a path command).
export function isAntigravityCommand(command) {
  const base = commandBasename(command);
  return base === ANTIGRAVITY_COMMAND || base === 'antigravity';
}

export function isAntigravityCliProvider(provider) {
  return provider?.id === ANTIGRAVITY_CLI_ID || isAntigravityCommand(provider?.command);
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
//
// The id shape itself is the charset `validation.js#cloudModelIdString` bounds
// its Zod schemas with; it is restated here rather than imported because
// `validation.js` pulls in the whole route-schema graph, which several mocked
// suites cannot absorb.
const MODEL_ID_CHARS = '[A-Za-z0-9][A-Za-z0-9._:/-]*';
const ANTIGRAVITY_MODEL_ID = new RegExp(`^${MODEL_ID_CHARS}$`);
const ANTIGRAVITY_MODEL_LINE = new RegExp(`^(${MODEL_ID_CHARS})(?:\\t.*)?$`);

/**
 * Is this a syntactically valid agy model id? The defense-in-depth check
 * behind `agyImageModelSchema`, for spawn sites that build an `agy --model`
 * argv from a value the route schema didn't already bound.
 * @param {unknown} id
 */
export function isAntigravityModelId(id) {
  return typeof id === 'string' && ANTIGRAVITY_MODEL_ID.test(id);
}

/**
 * Parse the ids out of `agy models` output, dropping blanks, banner/status
 * prose, and the configured-default sentinel (which callers re-prepend).
 *
 * Mirrored in the vendored toolkit at
 * `server/lib/aiToolkit/internal/antigravity.js` (which must not import out of
 * its own directory) — keep the two in sync.
 *
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

// agy print flags. Unlike the old Gemini CLI (which read the prompt from stdin),
// `agy --print`/`-p`/`--prompt` takes the prompt as the flag's VALUE and does
// NOT read stdin at all. So `--print <prompt>` must be the FINAL pair in the
// argv; prepareAntigravityPrompt relocates the flag to the end and appends the
// prompt as its value at spawn time.
export const ANTIGRAVITY_PRINT_FLAGS = ['--print', '-p', '--prompt'];

/**
 * Append `--model <id>` / `--effort <level>` to an agy argv when the caller has
 * a per-run override and the provider args don't already pin one. `agy --help`
 * documents both as session-scoped flags ("Model for the current CLI session",
 * "Reasoning effort for the current CLI session (low|medium|high)"), so PortOS
 * threads the task's model/effort selection through exactly like it does for
 * claude. Configured-default sentinels resolve to null → no `--model`, i.e. agy
 * keeps using whatever model its own config selects.
 *
 * Deliberately NOT Bedrock-mapped: agy offers `claude-sonnet-4-6` /
 * `claude-opus-4-6-thinking` through Google's own gateway, so rewriting those
 * to `global.anthropic.*` on a Bedrock host would hand agy an id it can't
 * resolve.
 *
 * See `resolveAntigravityModelAndEffort` for how the two are paired.
 */
function appendAntigravityModelAndEffort(args, overrides = {}) {
  // Drop a dangling `--model` before appending: `hasModelFlag` (correctly)
  // reports a value-less flag as "not a pin", so leaving it in would hand agy
  // two `--model` occurrences.
  const out = stripBrokenModelFlags(args);
  const { model, effort, base, provider } = resolveAntigravityModelAndEffort(out, overrides);
  if (model) out.push('--model', model);
  out.push(...buildEffortArgs(effort, provider, out, base));
  return out;
}

/**
 * Pair an agy `--model` with an `--effort`, honoring a user-baked `--model` pin.
 *
 * `model` may arrive as either a BASE id (`gemini-3.6-flash` — what the pickers
 * now offer) or a legacy effort-suffixed id (`gemini-3.6-flash-high`, still what
 * older installs and federated peers have persisted). A suffixed id is split so
 * the base goes to `--model` and its baked tier becomes the `--effort` — an
 * explicitly selected `effort` wins over the baked one. That keeps a stored
 * suffixed id working unchanged (`--model X --effort high` is equivalent to
 * `--model X-high`) instead of orphaning it.
 *
 * `models` is the provider's model catalog; it narrows the effort ladder to the
 * tiers the chosen base actually offers, because agy validates the PAIR — it
 * rejects `--model gemini-3.1-pro --effort medium` outright. An unresolvable
 * effort leaves the model id untouched, so a suffix carrying the only usable
 * tier is never stripped away into an invalid invocation.
 *
 * When the saved argv already pins `--model`, that pin wins (same gate as
 * `buildCliArgs`) and `model` comes back null. The effort ladder is then read
 * off the PINNED id, and only an explicitly selected `effort` applies — a pin's
 * own baked suffix already says what it means and isn't restated as a redundant
 * `--effort`.
 *
 * @param {string[]} args - the argv built so far (post `stripBrokenModelFlags`)
 * @param {{model?:string|null, effort?:string|null, models?:unknown[]|null}} [overrides]
 * @returns {{model: string|null, effort: string|null, base: string|null, provider: object}}
 *   `model` is the id to inject (null = don't), `provider` the synthetic agy
 *   provider to hand `buildEffortArgs`.
 */
export function resolveAntigravityModelAndEffort(args = [], { model = null, effort = null, models = null } = {}) {
  const provider = { id: ANTIGRAVITY_CLI_ID, command: 'agy', models };
  const pinned = hasModelFlag(args);
  const requested = resolveCliModel(model);
  // The id agy will actually receive — a user-baked pin always wins.
  const { base, effort: bakedEffort } = splitAntigravityModel(pinned ? extractBakedModel(args) : requested);
  const effectiveEffort = resolveCliEffort(pinned ? effort : (effort || bakedEffort), provider, base);
  return {
    model: pinned ? null : (effectiveEffort ? base : requested),
    effort: effectiveEffort,
    base,
    provider,
  };
}

/**
 * @param {string[]} [args] - the provider's saved argv
 * @param {{model?:string|null, effort?:string|null, models?:unknown[]|null}} [overrides] - per-run selections
 */
export function ensureAntigravityPrintArgs(args = [], overrides = {}) {
  // Drop any bare print flag the caller baked in — we re-add exactly one as the
  // trailing marker. (PortOS always supplies the prompt itself, so a
  // user-configured print flag never carries a prompt value to preserve.)
  const stripped = stripAntigravityUnsupportedArgs(args).filter((arg) => !ANTIGRAVITY_PRINT_FLAGS.includes(arg));
  const out = appendAntigravityModelAndEffort(stripped, overrides);
  if (!out.includes('--dangerously-skip-permissions') && !out.includes('--sandbox')) {
    out.push('--dangerously-skip-permissions');
  }
  // Print flag LAST: it is a marker with no value here. A bare trailing --print
  // is NOT a runnable invocation on its own — prepareAntigravityPrompt injects
  // the prompt as its value before the process is spawned. Leaving another flag
  // (e.g. --dangerously-skip-permissions) after --print would make agy consume
  // THAT flag as the prompt text (the bug that shipped the flag name to the
  // model instead of the task — see server/lib/antigravity.js history).
  //
  // Callers may still append after this (cliProviderRun.js#runCliProviderPrompt
  // concatenates the call's `extraArgs` onto buildCliArgs' output), so "last"
  // here is only true at build time — prepareAntigravityPrompt re-anchors the
  // pair at spawn time (#4110).
  out.push('--print');
  return out;
}

const NOOP_CLEANUP = () => {};

/**
 * Spawn-time prompt delivery for the antigravity CLI: re-anchor the print flag
 * at the END of the argv and append the prompt as its VALUE (agy does not read
 * stdin). Mirrors the `{ args, useStdin, cleanup }` shape of
 * grok.js#prepareGrokPromptFile so the spawn sites can dispatch through a
 * single helper (see prepareCliPrompt).
 *
 * MOVING the flag rather than splicing after it in place is what makes this
 * correct for a non-empty `extraArgs` call (#4110):
 * `cliProviderRun.js#runCliProviderPrompt` appends extraArgs *after* the
 * trailing `--print` marker `ensureAntigravityPrintArgs` left, so an in-place
 * splice would leave `--print <prompt> <extraArg>…` and turn every extraArg into
 * a stray positional agy may reject. Relocating the pair keeps `--print
 * <prompt>` the final two tokens no matter what got concatenated on, and is a
 * no-op for the already-trailing case.
 *
 * The flag's original SPELLING is preserved (`-p` / `--prompt` / `--print`) so a
 * user-baked short form still reaches agy as they wrote it.
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
  // No print flag at all → add one. Otherwise lift the existing marker out of
  // its current position so it can be re-appended as the final pair.
  const flag = idx === -1 ? '--print' : out.splice(idx, 1)[0];
  out.push(flag, prompt);
  return { args: out, useStdin: false, cleanup: NOOP_CLEANUP };
}

// TUI mode launches the interactive bubbletea REPL (NO --print) and the prompt
// is delivered by bracketed-paste after the input-ready handshake — never as an
// argv value. So, unlike the CLI path, there is no print flag to accidentally
// swallow --dangerously-skip-permissions: the flag stays a real boolean and the
// permission auto-approval actually takes effect. Do NOT add --print here.
/**
 * Deliberately takes NO per-run model/effort overrides, unlike its `--print`
 * sibling: the TUI paths inject those via `resolveAntigravityModelAndEffort` +
 * `buildEffortArgs` (in `tuiHandshake.js#buildTuiInvocation` and
 * `agentTuiSpawning.js#buildTuiSpawnConfig`), after this normalizer has run —
 * this is only reached via the provider-agnostic `applyCommandDefaults`. It
 * still drops a dangling `--model` so that later append can't produce two.
 * @param {string[]} [args] - the provider's saved argv
 */
export function ensureAntigravityTuiArgs(args = []) {
  const out = stripBrokenModelFlags(stripAntigravityUnsupportedArgs(args));
  if (!out.includes('--dangerously-skip-permissions') && !out.includes('--sandbox')) {
    out.push('--dangerously-skip-permissions');
  }
  return out;
}

// `--yolo` is a Gemini-CLI flag agy never accepted, and `-m` / `--output-format`
// / `-o` are legacy Gemini-CLI spellings agy still rejects (it takes the long
// `--model` only, and has no output-format flag). The LONG `--model` is
// deliberately NOT stripped: agy documents it as a per-session flag, so a
// user-baked pin is a real selection to preserve — and `hasModelFlag` sees it,
// which is what suppresses PortOS's own injected `--model`.
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
