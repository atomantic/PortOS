/**
 * Shared child-process and gallery lifecycle for the CLI image adapters.
 * Adapters supply invocation, output discovery, and provider metadata.
 */

import { open, stat } from 'fs/promises';
import { isAbsolute, join, resolve, sep } from 'path';
import { finishedImageAdmission } from '../../lib/backupPublicationWait.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { bufferedSpawn, killProcessTree, prepareCliSpawn } from '../../lib/bufferedSpawn.js';
import { spawn } from '../../lib/childProcess.js';
import { atomicWrite, copyFileGuarded, PATHS, rmGuarded, sleep, unlinkGuarded } from '../../lib/fileUtils.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { createMediaJobPreparation } from '../../lib/mediaJobPreparation.js';
import { detectImageFormat } from '../../lib/mimeTypes.js';
import { renderTimingFields } from '../../lib/renderTiming.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';
import { attachSseClient, broadcastSse, closeJobAfterDelay, createJobFailureFinalizer, dispatchTerminalEvent } from '../../lib/sseUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { checkFabrication } from './fabricationGuard.js';
import { rejectDegenerateFrame } from './frameGuard.js';

const VERSION_RE = /(\d+\.\d+\.\d+)/;
const hasExited = (proc) => typeof proc.exitCode === 'number' || typeof proc.signalCode === 'string';

export async function checkCliVersionConnection({ bin, mode, label, modelPrefix, versionRegex, env }) {
  const { command, args } = prepareCliSpawn(bin, ['--version']);
  const result = await bufferedSpawn(command, args, { timeoutMs: 15_000, shell: false, ...(env ? { env } : {}) });
  if (result.error) {
    return { connected: false, mode, reason: `${label} CLI not found (${result.error?.message || String(result.error)})` };
  }
  if (result.timedOut) return { connected: false, mode, reason: `${mode} --version timed out` };
  if (result.code !== 0) return { connected: false, mode, reason: `${mode} --version exited ${result.code}` };

  const output = `${result.stdout}${result.stderr}`;
  const version = (versionRegex && output.match(versionRegex)) || output.match(VERSION_RE);
  return { connected: true, mode, model: version ? `${modelPrefix} ${version[1]}` : modelPrefix };
}

// A nonempty file can appear before its signature is fully written. Keep polling
// until the bytes identify a supported format or the flush window elapses.
export async function harvestStagedImage(stagingPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawInvalid = false;
  while (Date.now() < deadline) {
    const fileStat = await stat(stagingPath).catch(() => null);
    if (fileStat?.size > 0) {
      const head = Buffer.alloc(16);
      const handle = await open(stagingPath, 'r').catch(() => null);
      if (handle) {
        const { bytesRead } = await handle.read(head, 0, 16, 0).catch(() => ({ bytesRead: 0 }));
        await handle.close().catch(() => {});
        const detected = detectImageFormat(head.subarray(0, bytesRead));
        if (detected) return { found: true, invalid: false, format: detected.format };
        sawInvalid = true;
      }
    }
    const remainingMs = Math.max(1, deadline - Date.now());
    await sleep(Math.min(250, remainingMs));
  }
  return { found: false, invalid: sawInvalid };
}

export function createCliImageJobRunner({ mode, provider, logName = provider, defaultBin, timeoutMs, failedPayloadExtras }) {
  const jobs = new Map();
  const activeProcs = new Map();
  const activeJobs = new Map();
  const preparations = createMediaJobPreparation();

  const terminate = (jobId, proc) => {
    if (hasExited(proc)) return;
    // A Windows .cmd wrapper can own a still-running provider process.
    if (process.platform === 'win32') return killProcessTree(proc);
    killWithEscalation(proc, {
      label: `${mode} child`, delayMs: 5000,
      stillRunning: () => activeProcs.get(jobId) === proc,
    });
  };

  const cancel = (jobId) => {
    if (!jobId) throw new Error(`${mode}.cancel requires a jobId — use ${mode}.cancelAll() to terminate every in-flight render`);
    const pending = preparations.cancel(jobId);
    if (pending) return pending;
    const proc = activeProcs.get(jobId);
    if (!proc) return false;
    const job = jobs.get(jobId);
    if (job) job.canceled = true;
    terminate(jobId, proc);
    return true;
  };

  const cancelAll = () => {
    const ids = [...preparations.ids(), ...activeProcs.keys()];
    for (const id of ids) cancel(id);
    return ids.length > 0;
  };

  const finalizeJobFailure = createJobFailureFinalizer({
    jobs, activeJobs, activeSlots: activeProcs, label: `${mode} image generation`, events: imageGenEvents,
    failedPayload: (jobId, reason, proc) => ({
      mode, generationId: jobId, error: reason,
      ...failedPayloadExtras?.(jobs.get(jobId)),
      inputProcessSettled: !proc || !proc.pid || hasExited(proc),
    }),
  });

  const removeScratchDirectory = async (scratchDir, extraCleanup) => {
    try {
      await maintenance.continueSettlement(async () => {
        try {
          await extraCleanup?.();
        } finally {
          await rmGuarded(scratchDir, { recursive: true, force: true });
        }
      });
    } catch (err) {
      maintenance.markCurrentUnsettled();
      console.error(`❌ ${logName} scratch cleanup failed: ${err.message}`);
    }
  };

  const registerJob = async ({ meta, renderStartedAtMs, scratchDir, referenceEventFields }) => {
    const { id: jobId } = meta;
    const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
    const previousJob = jobs.get(jobId);
    const previousActive = activeJobs.get(jobId);
    try {
      jobs.set(jobId, job);
      activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0, currentImage: null });
      console.log(`🎨 Generating image [${jobId.slice(0, 8)}] ${mode}`);
      imageGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...referenceEventFields });
      broadcastSse(job, { type: 'status', message: `Spawning ${mode}…` });
      return job;
    } catch (err) {
      if (previousJob) jobs.set(jobId, previousJob);
      else jobs.delete(jobId);
      if (previousActive) activeJobs.set(jobId, previousActive);
      else activeJobs.delete(jobId);
      await removeScratchDirectory(scratchDir);
      throw err;
    }
  };

  const discoverStagedImage = async ({ stagingPath, harvestTimeoutMs, scratchDir, toolName, noImageReason, stdoutTail }) => {
    const harvested = await harvestStagedImage(stagingPath, harvestTimeoutMs);
    if (!harvested.found) {
      const prefix = harvested.invalid ? `${provider} wrote a non-image file at the directed path. ` : '';
      return { error: `${prefix}${noImageReason(stdoutTail)}` };
    }
    // A valid signature alone does not prove the agent used the image tool.
    const fabricated = await checkFabrication(scratchDir, toolName);
    if (fabricated) return { error: `${fabricated} ${noImageReason(stdoutTail)}` };
    return { path: stagingPath, format: harvested.format };
  };

  const publishStagedImage = async (job, image, { meta, cleanC2PA, denoise, conformAspect, recordUsage }) => {
    const { id: jobId, filename } = meta;
    const outputPath = join(PATHS.images, filename);
    const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
    try {
      if (image.buffer) {
        await atomicWrite(outputPath, image.buffer);
      } else if (image.format === 'png') {
        await copyFileGuarded(image.path, outputPath);
      } else {
        const { default: sharp } = await import('sharp');
        await atomicWrite(outputPath, await sharp(image.path).png().toBuffer());
      }
      const emptyFrame = await rejectDegenerateFrame(outputPath);
      if (emptyFrame) return emptyFrame;

      const aspectConformed = await conformAspect?.(outputPath, meta.width, meta.height);
      if (aspectConformed) console.log(`✂️ Conformed ${mode} frame [${jobId.slice(0, 8)}] ${aspectConformed.from} → ${aspectConformed.to}`);
      const renderMeta = {
        ...meta, ...image.sidecarFields, ...(aspectConformed ? { aspectConformed } : {}),
        ...renderTimingFields(job.renderStartedAtMs),
      };
      await atomicWrite(sidecar, renderMeta);
      await autoCleanGeneratedImage({ cleanC2PA, denoise, pngPath: outputPath, sidecarPath: sidecar, mode });
      try {
        await recordUsage?.(renderMeta);
      } catch (err) {
        console.error(`❌ Failed to record ${provider} image usage [${jobId.slice(0, 8)}]: ${err.message}`);
      }
      return null;
    } catch (err) {
      await Promise.all([outputPath, sidecar].map(path => unlinkGuarded(path).catch(() => {})));
      throw err;
    }
  };

  function launch(job, bin, args, scratchDir, { env, stdin, onStderr }) {
    const jobId = job.id;
    // Resolve path-shaped overrides against the server cwd before switching
    // to scratch. Bare executable names still use PATH.
    const resolvedBin = !isAbsolute(bin) && (bin.includes('/') || bin.includes(sep)) ? resolve(bin) : bin;
    const prepared = prepareCliSpawn(resolvedBin, args);
    const proc = spawn(prepared.command, prepared.args, {
      cwd: scratchDir, env: withSpawnCwdEnv(env ?? process.env, scratchDir), shell: false,
      stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    activeProcs.set(jobId, proc);

    const exited = new Promise((resolveExit) => {
      let stdoutTail = '';
      let stderrTail = '';
      let timer;
      let setupError;
      let processError;
      proc.on('error', (err) => {
        processError = err;
        // An error on a live child can be a failed signal, so keep its scratch
        // and slot until close. A failed spawn has no live process to wait for.
        if (!proc.pid) {
          clearTimeout(timer);
          resolveExit({ spawnError: err });
        }
      });
      proc.once('close', (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal, setupError, processError, stdoutTail, stderrTail });
      });

      // Error and close already own settlement if any part of setup throws.
      try {
        timer = setTimeout(() => {
          if (activeProcs.get(jobId) !== proc) return;
          console.log(`⏱️ ${mode} timed out after ${timeoutMs}ms [${jobId.slice(0, 8)}]`);
          terminate(jobId, proc);
        }, timeoutMs);
        proc.stdout.on('data', (chunk) => {
          stdoutTail = `${stdoutTail}${chunk}`.slice(-8192);
          broadcastSse(job, { type: 'status', message: 'Running…' });
        });
        proc.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          onStderr?.(text);
          stderrTail = `${stderrTail}${text}`.slice(-32768);
        });
        if (stdin != null) {
          // Grok consumes its prompt from stdin on POSIX. Close owns the real
          // failure if the child exits before reading it.
          proc.stdin.on('error', () => {});
          proc.stdin.write(stdin);
          proc.stdin.end();
        }
      } catch (err) {
        setupError = err;
        clearTimeout(timer);
        terminate(jobId, proc);
      }
    });
    return { proc, exited };
  }

  async function run(job, { bin = defaultBin, args, scratchDir, prepareAttempt, ...publication }) {
    const { id: jobId, filename } = job;
    const { referenceEventFields } = publication;
    let proc = null;
    let extraCleanup;

    // Keep the scratch settlement owned before the terminal event can release
    // the queue's admission. Successful events still run within the backup
    // lease so gallery listeners can acquire their own publication leases.
    const finish = async ({ image, error, canceled }) => {
      if (job.status !== 'running') return;
      try {
        if (image) {
          // Once the gallery commit starts, the exited child can no longer accept cancellation.
          if (activeProcs.get(jobId) === proc) activeProcs.delete(jobId);
          error = await publishStagedImage(job, image, publication);
        }
      } catch (err) {
        error = `${provider} post-exit handler failed: ${err?.message || err}`;
      } finally {
        void removeScratchDirectory(scratchDir, extraCleanup);
      }
      if (canceled || job.canceled) return finalizeJobFailure.canceled(job, jobId, proc);
      if (error) return finalizeJobFailure(job, jobId, proc, error);

      job.status = 'complete';
      activeJobs.delete(jobId);
      console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename} (${mode})`);
      const result = { filename, path: `/data/images/${filename}` };
      dispatchTerminalEvent(
        jobId,
        () => broadcastSse(job, { type: 'complete', result }),
        () => imageGenEvents.emit('completed', { mode, generationId: jobId, inputProcessSettled: true, ...result, ...referenceEventFields }),
      );
      closeJobAfterDelay(jobs, jobId);
    };

    if (preparations.take(jobId)) return finish({ canceled: true });
    // Each discovery returns an image, an error, or a retry. Retries share the
    // job and scratch directory but start with fresh child state.
    for (let attempt = 0; ; attempt += 1) {
      if (job.canceled) return finish({ canceled: true });
      let invocation;
      let exited;
      try {
        invocation = prepareAttempt();
        extraCleanup = invocation.cleanup ?? extraCleanup;
        ({ proc, exited } = launch(job, bin, invocation.args ?? args, scratchDir, invocation));
      } catch (err) {
        return finish({ error: `Failed to spawn ${bin}: ${err?.message || err}` });
      }
      const { code, signal, setupError, processError, spawnError, stdoutTail, stderrTail } = await exited;
      if (job.canceled) return finish({ canceled: true });
      if (spawnError) return finish({ error: `Failed to spawn ${bin}: ${spawnError.message}` });

      if (setupError) {
        return finish({ error: `${provider} launch setup failed: ${setupError?.message || setupError}` });
      }
      if (code !== 0 || processError) {
        const reason = processError?.message || (signal ? `Killed by signal ${signal}` : `Exit code ${code}`);
        const tail = stderrTail.trim().split('\n').slice(-6).join('\n');
        return finish({ error: `${provider} generation failed: ${reason}\n${tail}` });
      }

      const retry = await withBackupAssetPublication(async () => {
        if (job.canceled) return finish({ canceled: true });
        let image;
        try {
          image = await invocation.discover({ attempt, stdoutTail, stderrTail });
        } catch (err) {
          return finish({ error: `${provider} post-exit handler failed: ${err?.message || err}` });
        }
        if (job.canceled) return finish({ canceled: true });
        if (image.retry) return true;
        return finish(image.error ? { error: image.error } : { image });
      }, finishedImageAdmission(imageGenEvents, jobId)).catch(err => finish({ error: `${provider} publication admission failed: ${err?.message || err}` }));
      if (!retry) return;
    }
  }

  return {
    preparations,
    getActiveJob: () => [...activeJobs.values()].at(-1) ?? null,
    getActiveJobs: () => [...activeJobs.values()],
    attachSseClient: (jobId, res) => attachSseClient(jobs, jobId, res),
    cancel, cancelAll, registerJob, removeScratchDirectory, discoverStagedImage,
    run: (...args) => {
      run(...args).catch(err => console.error(`❌ ${provider} image run failed: ${err.message}`));
    },
  };
}
