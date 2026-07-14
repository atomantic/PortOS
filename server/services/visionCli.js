/**
 * Vision via CLI providers (codex / claude-code with vision).
 *
 * The API-provider vision path (`describeImageDataUrlDetailed` in
 * `visionTest.js`) POSTs a base64 `image_url` block to an OpenAI-compatible
 * `/chat/completions`. CLI providers have no such endpoint — they read a prompt
 * from stdin and (for the vision-capable ones) an image from a FILE. So this
 * module decodes the in-memory data URL to a temp PNG, attaches it the way each
 * CLI expects, spawns the provider, and returns the model's text in the SAME
 * `{ text, finishReason, usage, reasoning }` shape the API path returns — so
 * `loraDatasetCaption.js` consumes either provider type uniformly.
 *
 * Attachment conventions (mirrors `imageGen/codex.js` for codex):
 *   - codex:  `codex exec -i <file> '<prompt>'` — the `-i` flag feeds the file
 *     to the model; the prompt is a positional arg.
 *   - others (claude-code): the image is written into a fresh temp dir that
 *     becomes the spawn cwd, and the prompt (over stdin) references it by
 *     basename so the CLI can read it with its file tools in print mode.
 *
 * CLI providers don't report `finish_reason` / token usage / reasoning, so
 * those come back null/'' — the caption diagnostics degrade gracefully (an
 * empty CLI reply is reported as a plain refusal rather than a token-budget
 * guess).
 */

import { spawn } from 'child_process';
import { writeFile, rm, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCliArgs } from '../lib/cliProviderArgs.js';
import { prepareGrokPromptFile } from '../lib/grok.js';
import { resolveCliModel, isCodexProvider, buildCodexStartupArgs } from '../lib/providerModels.js';
import { extractCodexAssistant, extractCodexAssistantTail } from '../lib/codexAssistantExtract.js';
import { killProcessTree, resolveWindowsExecutable, prepareWindowsSafeSpawn } from '../lib/bufferedSpawn.js';

const CLI_VISION_TIMEOUT_MS = 120000;
const IMAGE_BASENAME = 'vision-input.png';

// Codex matches on id OR command basename (via the shared isCodexProvider) so a
// renamed/duplicated/path-configured codex provider still takes the `-i` path.
// Everything else uses the cwd-local-file convention.

/**
 * Decode a `data:image/...;base64,...` URL to raw bytes. Throws on a malformed
 * URL (same contract as the API path's up-front data-URL check). Pure —
 * exported for tests.
 */
export function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('dataUrl must be a base64 image data URL');
  }
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  if (!base64) throw new Error('dataUrl has no base64 payload');
  return Buffer.from(base64, 'base64');
}

/**
 * Build the spawn invocation (command, argv, stdin, cwd) for a vision CLI call.
 * `imageDir` is the temp dir holding `IMAGE_BASENAME`. Pure — exported so the
 * per-provider attachment convention is unit-testable without spawning.
 *
 * @returns {{ command: string, args: string[], stdin: string|null, cwd: string }}
 */
export function buildCliVisionInvocation(provider, model, imageDir, prompt) {
  const imagePath = join(imageDir, IMAGE_BASENAME);
  if (isCodexProvider(provider)) {
    const baseArgs = Array.isArray(provider.args) ? provider.args : [];
    const hasExec = baseArgs.includes('exec');
    // Resolve the codex sentinel (`codex-configured-default`) to null so we omit
    // `-m` and let codex fall back to ~/.codex/config.toml — passing the
    // sentinel verbatim makes `codex exec` try a non-existent model. Same
    // resolution buildCliArgs applies on the normal CLI run path.
    const codexModel = resolveCliModel(model);
    const args = [
      ...(hasExec ? baseArgs : [...baseArgs, 'exec']),
      '--skip-git-repo-check',
      // Disable codex's startup update check (see buildCodexStartupArgs): this
      // path runs under a hard vision timeout, so an update-check network stall
      // or an unattended `brew upgrade` would blow the caption call. No-op when
      // the user pinned the key in provider.args.
      ...buildCodexStartupArgs(baseArgs),
      '-i', imagePath,
      ...(codexModel ? ['-m', String(codexModel)] : []),
      prompt,
    ];
    return { command: provider.command || 'codex', args, stdin: null, cwd: imageDir };
  }

  // Claude Code (and any other stdin CLI): buildCliArgs gives the `-p -`
  // stdin convention + `--model`; the image rides in the spawn cwd so the CLI
  // can open it by basename with its file tools.
  const args = buildCliArgs({ ...provider, defaultModel: model });
  const stdin = `${prompt}\n\nThe image to analyze is the file "${IMAGE_BASENAME}" in the current directory.`;
  return { command: provider.command, args, stdin, cwd: imageDir };
}

/**
 * Run a vision prompt against a CLI provider and resolve with the model's text
 * in the API-compatible diagnostic shape. `spawnImpl` is injectable for tests.
 *
 * @param {object} opts
 * @param {object} opts.provider — a CLI-type provider object
 * @param {string} opts.dataUrl  — base64 image data URL
 * @param {string} opts.prompt   — what to ask about the image
 * @param {string} [opts.model]  — model override (defaults to provider.defaultModel)
 * @param {number} [opts.timeout]
 * @param {Function} [opts.spawnImpl] — child_process.spawn replacement (tests)
 * @returns {Promise<{ text:string, finishReason:null, usage:null, reasoning:string }>}
 */
export async function describeImageViaCli({
  provider, dataUrl, prompt, model, timeout = CLI_VISION_TIMEOUT_MS, spawnImpl = spawn,
}) {
  const visionModel = model || provider?.defaultModel || null;
  const bytes = decodeImageDataUrl(dataUrl);

  // Fresh per-call temp dir so concurrent caption runs never collide on the
  // image file, and cleanup is a single recursive rm.
  const dir = await mkdtemp(join(tmpdir(), 'portos-vision-'));
  // Grok's Windows prompt-file temp (no-op elsewhere); cleaned in the finally.
  let cleanupPromptFile = () => {};
  try {
    await writeFile(join(dir, IMAGE_BASENAME), bytes);
    const { command, args, stdin, cwd } = buildCliVisionInvocation(provider, visionModel, dir, prompt);
    // Grok reads its prompt from --prompt-file /dev/stdin (fed via stdin on
    // POSIX); on Windows it's rewritten to a temp file (writePromptToStdin=false).
    // No-op for every other provider.
    const { args: deliveredArgs, useStdin: writePromptToStdin, cleanup } = prepareGrokPromptFile(args, stdin);
    cleanupPromptFile = cleanup;

    const childEnv = { ...process.env, ...provider?.envVars };
    delete childEnv.CLAUDECODE;

    // npm-installed CLI providers are .cmd/.bat shims on Windows; resolve+wrap
    // (cmd.exe /c) instead of enabling a shell. This matters even more here
    // than at other call sites: the codex branch of buildCliVisionInvocation
    // puts the free-text `prompt` directly into `args` (see above), and
    // shell:true + an args array does NOT escape arguments (DEP0190) — any
    // prompt containing a space would silently mis-split into extra shell
    // tokens, corrupting or shell-injecting the invocation. The cmd.exe
    // wrapper instead relies on Node's own correct non-shell argv escaping,
    // which DOES preserve spaces within each arg as a single token. Resolved
    // against `childEnv` so a provider-configured PATH override is honored.
    // See resolveWindowsExecutable/prepareWindowsSafeSpawn in
    // server/lib/bufferedSpawn.js.
    const resolvedCommand = resolveWindowsExecutable(command, undefined, childEnv) || command;
    const { command: spawnCommand, args: spawnArgs } = prepareWindowsSafeSpawn(resolvedCommand, deliveredArgs);

    const text = await new Promise((resolve, reject) => {
      const child = spawnImpl(spawnCommand, spawnArgs, {
        cwd,
        env: childEnv,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let killTimer = null;
      // On timeout, SIGTERM the child AND reject now — don't wait on `close`. A
      // wedged CLI that ignores SIGTERM would otherwise never emit `close`, so
      // the promise would hang forever and the temp dir (cleaned in `finally`)
      // would leak. Escalate to SIGKILL on a short grace timer.
      const timer = timeout > 0 ? setTimeout(() => {
        if (!child.killed) killProcessTree(child);
        killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
        killTimer?.unref?.();
        reject(new Error(`${command} vision call timed out after ${timeout}ms`));
      }, timeout) : null;
      timer?.unref?.();
      const clearTimers = () => { if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer); };

      child.on('error', (e) => { clearTimers(); reject(new Error(`Failed to spawn ${command}: ${e.message}`)); });
      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.stderr?.on('data', (d) => { err += d.toString(); });
      child.on('close', (code) => {
        clearTimers();
        // `codex exec` prints the whole session transcript (banner, echoed
        // prompt, tool sections, `tokens used` footer) to stdout — carve out
        // the assistant reply so captioning doesn't persist the transcript as
        // the caption. Newer Codex emits the final reply AFTER the `tokens used`
        // footer (extractCodexAssistantTail), older versions before it
        // (extractCodexAssistant); try tail first, then the legacy extractor,
        // both no-ops for non-codex output (tail → null, legacy → input).
        if (code === 0) return resolve((extractCodexAssistantTail(out) ?? extractCodexAssistant(out)).trim());
        const tail = err.trim().split('\n').slice(-4).join('\n');
        reject(new Error(`${command} vision call exited ${code}${tail ? `: ${tail}` : ''}`));
      });

      // When grok is delivered via a Windows temp file the prompt is already on
      // disk (writePromptToStdin=false) — just close stdin.
      if (writePromptToStdin && stdin != null) {
        child.stdin?.write(stdin);
        child.stdin?.end();
      } else {
        child.stdin?.end();
      }
    });

    return { text, finishReason: null, usage: null, reasoning: '' };
  } finally {
    cleanupPromptFile();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
