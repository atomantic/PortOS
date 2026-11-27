/** Execute built-in CLI runs and stop registered process handles. */
import { runOwnership, runChildIdentity } from './runOwnership.js';
import { atomicWrite } from './atomicWrite.js';
import { spawn, ChildProcess } from 'child_process';
import { analyzeError, ERROR_CATEGORIES } from '../errorDetection.js';
import { resolveWindowsExecutable, prepareWindowsSafeSpawn } from './windowsSafeSpawn.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { safeJsonParse } from './runStore.js';
import { safeSettle } from './runCallbacks.js';

// Windows process-tree teardown stays local; command preparation uses the shared leaf.
const IS_WIN32 = process.platform === 'win32';

// On Windows, taskkill (used below) runs in a separate detached process that
// never touches the original ChildProcess object — `.killed` is set
// synchronously here (mirroring what Node's own `child.kill()` does on the
// POSIX branch) so callers elsewhere that gate re-entrant kill handling on
// `.killed` actually engage on Windows. A plain SIGTERM kills the cmd.exe
// wrapper but orphans the real child, so the whole process tree is taken
// down via `taskkill /T /F` there; SIGTERM is sufficient elsewhere.
//
// The win32 branch is gated on `instanceof ChildProcess`: stopRun/deleteRun
// below call this with whatever was registered via registerExternalRun,
// which can be a node-pty `IPty` TUI session (server/services/tuiPromptRunner.js,
// via the host's registerActiveRun) — it also exposes `.kill()`/`.pid`, but
// a raw `taskkill` against its pid bypasses node-pty's own Windows teardown
// (releasing its native ConPTY handle), leaking it. Any non-ChildProcess
// killable always uses its own `.kill()` instead, on every platform.
//
// On Windows node-pty additionally throws `Signals not supported on windows.`
// for any signal argument — so a signalled kill there killed nothing and threw
// past this function, and stopping a TUI run silently left it running. The
// signal is therefore offered first and the signal-free form used only for a
// handle that refuses it (retrying is harmless — the first attempt did nothing);
// dropping it unconditionally would downgrade other signal-forwarding killables.
// Mirrors server/lib/bufferedSpawn.js (this directory stays self-contained).
export function killProcessTree(child) {
  const isChildProcess = child instanceof ChildProcess;
  if (IS_WIN32 && child.pid && isChildProcess) {
    child.killed = true;
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
      .on('error', () => {})
      .unref();
  } else if (IS_WIN32 && !isChildProcess) {
    try { child.kill('SIGTERM'); }
    catch { child.kill(); }
  } else {
    child.kill('SIGTERM');
  }
}

export function createCliExecutor({ runsPath, patchRunMetadata, activeRuns, hooks, handleProviderError, withAssetPublication }) {
  return async function executeCliRun(opts) {
    const { runId, provider, prompt, workspacePath, onData, onComplete, timeout, beforeExecute } = opts;
    await patchRunMetadata(runId, runOwnership('cli'));
    const runDir = join(runsPath, runId);
    const outputPath = join(runDir, 'output.txt');
    const metadataPath = join(runDir, 'metadata.json');

    const startTime = Date.now();
    let output = '';

    // Pass the prompt via stdin (not argv) and run without a shell so that
    // user-configurable `provider.command` cannot inject extra commands via
    // shell metacharacters, and so the full prompt isn't visible in
    // process listings as a single command-line argument. On Windows,
    // resolve+wrap a .cmd/.bat target instead of enabling a shell — see
    // internal/windowsSafeSpawn.js for why shell:true is unsafe here.
    const args = [...(provider.args || [])];
    console.log(`🚀 Executing CLI: ${provider.command} ${args.join(' ')} (${prompt.length} chars via stdin)`);

    // Pin PWD to the spawn cwd — `spawn({ cwd })` does not rewrite the
    // inherited PWD, and OpenCode resolves its project root as
    // `process.env.PWD ?? process.cwd()`, so it would run wherever the host
    // process was started instead of in `workspacePath`. Deliberately mirrors
    // PortOS's `withSpawnCwdEnv` line for line rather than importing it: this
    // toolkit is vendored and must not import out to other PortOS modules.
    // (PortOS overrides `executeCliRun` via `setCliRunner`, so this particular
    // spawn is dormant here — the copy keeps the vendored toolkit correct
    // standalone.) The case-insensitive delete matters on Windows, where a
    // spread of `process.env` can surface the variable as `Pwd`/`pwd`.
    const childEnv = { ...process.env, ...provider.envVars };
    if (workspacePath) {
      for (const key of Object.keys(childEnv)) if (/^pwd$/i.test(key)) delete childEnv[key];
      childEnv.PWD = workspacePath;
    }
    // Resolved against `childEnv` (not bare process.env) so a
    // provider-configured PATH override is honored.
    const resolvedCommand = resolveWindowsExecutable(provider.command, undefined, childEnv) || provider.command;
    const { command: spawnCommand, args: spawnArgs } = prepareWindowsSafeSpawn(resolvedCommand, args, undefined, childEnv);
    if (beforeExecute) {
      try { await beforeExecute(); }
      catch {
        const metadata = { ...safeJsonParse(await readFile(metadataPath, 'utf8').catch(() => '{}')),
          endTime: new Date().toISOString(), duration: Date.now() - startTime,
          success: false, canceled: true, completionReason: 'canceled', error: 'CLI run canceled', errorCategory: ERROR_CATEGORIES.CANCELED };
        await atomicWrite(metadataPath, metadata);
        safeSettle(() => hooks.onRunCanceled?.({ runId }), `Run ${runId} onRunCanceled hook`);
        safeSettle(() => onComplete?.(metadata), `Run ${runId} onComplete`);
        return runId;
      }
    }
    const childProcess = spawn(spawnCommand, spawnArgs, {
      cwd: workspacePath,
      env: childEnv,
      windowsHide: true
    });

    // Same tick as spawn. Node emits 'error' (ENOENT, EACCES, EMFILE) and
    // does not follow it with 'close' when the process never starts; an
    // unlistened 'error' is an uncaught exception that exits the server.
    // A child that dies before reading stdin emits EPIPE on the pipe — that
    // stream error is the same crash if nobody is listening. 'close' and
    // 'error' share one settlement so a race cannot double-fire hooks.
    const childIdentitySaved = patchRunMetadata(runId, { executionChild: runChildIdentity(childProcess.pid) });
    let settled = false;
    let timeoutHandle = null;
    const releaseRun = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      activeRuns.delete(runId);
    };

    childProcess.stdin?.on('error', () => {});
    childProcess.on('error', (err) => {
      if (settled) return;
      settled = true;
      releaseRun();
      const message = err?.message || 'CLI spawn failed';
      console.error(`❌ Run ${runId} spawn error: ${message}`);
      void (async () => {
        // The 'error' event is the classification: a missing binary's message
        // matches SPAWN_ERROR, but EACCES/EMFILE do not, and a null category
        // is read as an unknown provider failure. Keep the raw message — the
        // pattern's extracted text drops the spawn detail callers match on.
        const errorAnalysis = analyzeError(message, -1);
        errorAnalysis.category = ERROR_CATEGORIES.SPAWN_ERROR;
        errorAnalysis.hasError = true;
        errorAnalysis.requiresFallback = true;
        errorAnalysis.message = message;
        const failMetadata = {
          endTime: new Date().toISOString(),
          duration: Date.now() - startTime,
          exitCode: -1,
          success: false,
          error: message,
          errorCategory: ERROR_CATEGORIES.SPAWN_ERROR,
          errorAnalysis,
          outputSize: Buffer.byteLength(output),
        };
        try {
          await childIdentitySaved;
          let metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
          Object.assign(metadata, failMetadata);
          await withAssetPublication(async () => {
            await atomicWrite(outputPath, output);
            await atomicWrite(metadataPath, metadata);
          });
          Object.assign(failMetadata, metadata);
        } catch (writeErr) {
          console.error(`❌ Run ${runId} spawn-error finalization failed: ${writeErr.message}`);
        }
        safeSettle(() => hooks.onRunFailed?.(failMetadata, failMetadata.error, output), `Run ${runId} onRunFailed hook`);
        safeSettle(() => onComplete?.(failMetadata), `Run ${runId} onComplete`);
      })();
    });

    if (childProcess.stdin) {
      childProcess.stdin.write(prompt);
      childProcess.stdin.end();
    }

    activeRuns.set(runId, childProcess);
    hooks.onRunStarted?.({ runId, provider: provider.name, model: provider.defaultModel });

    if (timeout > 0) timeoutHandle = setTimeout(() => {
      if (childProcess && !childProcess.killed) {
        console.log(`⏱️ Run ${runId} timed out after ${timeout}ms`);
        killProcessTree(childProcess);
      }
    }, timeout);

    childProcess.stdout?.on('data', (data) => {
      const text = data.toString();
      output += text;
      onData?.(text);
    });

    childProcess.stderr?.on('data', (data) => {
      const text = data.toString();
      output += text;
      onData?.(text);
    });

    childProcess.on('close', async (code) => {
      if (settled) return;
      settled = true;
      // Runs outside the request lifecycle — an uncaught throw from
      // atomicWrite/handleProviderError/hooks would surface as an unhandled
      // rejection and crash the process, so guard the body and still settle
      // the caller on failure.
      try {
        await childIdentitySaved;
        releaseRun();

        const metadata = await withAssetPublication(async () => {
          await atomicWrite(outputPath, output);
          const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
          metadata.endTime = new Date().toISOString();
          metadata.duration = Date.now() - startTime;
          metadata.exitCode = code;
          metadata.success = code === 0;
          metadata.outputSize = Buffer.byteLength(output);
          if (!metadata.success) {
            const errorAnalysis = analyzeError(output, code, { prompt });
            metadata.error = errorAnalysis.message || `Process exited with code ${code}`;
            metadata.errorCategory = errorAnalysis.category;
            metadata.errorAnalysis = errorAnalysis;
          }
          await atomicWrite(metadataPath, metadata);
          return metadata;
        });
        const errorAnalysis = metadata.errorAnalysis;
        if (errorAnalysis?.hasError &&
            (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT ||
             errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT)) {
          await handleProviderError(provider.id, errorAnalysis, output);
        }

        // Isolate the completion hooks + onComplete from the outer catch — a
        // throwing onRunCompleted must NOT be reinterpreted as a finalization
        // failure that flips a successful run to success:false for the caller.
        if (metadata.success) {
          safeSettle(() => hooks.onRunCompleted?.(metadata, output), `Run ${runId} onRunCompleted hook`);
        } else {
          safeSettle(() => hooks.onRunFailed?.(metadata, metadata.error, output), `Run ${runId} onRunFailed hook`);
        }
        safeSettle(() => onComplete?.(metadata), `Run ${runId} onComplete`);
      } catch (err) {
        console.error(`❌ Run ${runId} close handler error: ${err.message}`);
        const failMetadata = {
          endTime: new Date().toISOString(),
          duration: Date.now() - startTime,
          exitCode: code,
          success: false,
          error: `Run finalization failed: ${err.message}`,
          outputSize: Buffer.byteLength(output),
        };
        safeSettle(() => hooks.onRunFailed?.(failMetadata, failMetadata.error, output), `Run ${runId} onRunFailed hook`);
        safeSettle(() => onComplete?.(failMetadata), `Run ${runId} onComplete`);
      }
    });

    return runId;
  };
}
