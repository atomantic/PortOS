#!/usr/bin/env node
/** Real runtime acceptance of the bundled starter; no settings/provider/history writes. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderBlenderSequence } from '../server/services/codeAnimation/blenderRender.js';
import { getBlenderStarterPackage } from '../server/services/codeAnimation/blenderStarter.js';
import { runContainedWorker, runTrustedLocalWorker } from '../server/services/codeAnimation/containedWorker.js';
import { codeAnimationManifestSchema } from '../server/lib/codeAnimationPackage.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function parseAcceptanceArgs(args) {
  const { values } = parseArgs({ args, options: {
    executable: { type: 'string' }, out: { type: 'string' }, mode: { type: 'string', default: 'contained' },
    phase: { type: 'string', default: 'pilot' }, engine: { type: 'string', default: 'CYCLES' }, backend: { type: 'string' }, times: { type: 'string', default: '1,5,9' },
    repeat: { type: 'boolean', default: false }, 'cancel-after': { type: 'string' },
    size: { type: 'string', default: '1920x1080' }, seconds: { type: 'string', default: '10' },
  } });
  if (!values.executable || !values.out || !['contained', 'trusted-local'].includes(values.mode)
    || !['pilot', 'final', 'style'].includes(values.phase) || !['CYCLES', 'BLENDER_EEVEE_NEXT'].includes(values.engine)
    || (values.engine === 'CYCLES' ? values.backend !== undefined : !['METAL', 'OPENGL', 'VULKAN'].includes(values.backend)) || !/^\d+x\d+$/.test(values.size)) {
    throw new Error('Usage: --executable <Blender 4.2.0> --out <new directory> [--mode contained|trusted-local] [--phase pilot|final|style] [--engine CYCLES|BLENDER_EEVEE_NEXT --backend METAL|OPENGL|VULKAN]');
  }
  const [width, height] = values.size.split('x').map(Number);
  const format = codeAnimationManifestSchema.shape.format.parse({ width, height, fps: 24, durationSeconds: Number(values.seconds) });
  const count = format.durationSeconds * format.fps;
  const times = values.times.split(',').map(value => value.trim() ? Number(value) : NaN);
  const cancelAfter = values['cancel-after'] === undefined ? null : Number(values['cancel-after']);
  if (!Number.isInteger(count) || times.length === 0 || times.some(t => !Number.isFinite(t) || t < 0 || Math.round(t * 24) >= count)
    || new Set(times.map(t => Math.round(t * 24))).size !== times.length
    || (cancelAfter !== null && (!Number.isFinite(cancelAfter) || cancelAfter <= 0)) || (cancelAfter !== null && values.repeat)) {
    throw new Error('Duration must land on the frame grid; sample times must be distinct in-range frames; cancellation needs positive seconds and cannot combine with --repeat');
  }
  return { ...values, format, times, cancelAfter };
}

/** Injectable renderer lets tests pin false-success verdicts, not simulate native acceptance. */
export async function runAcceptance(options, { render = renderBlenderSequence } = {}) {
  const out = resolve(options.out);
  // Refuse reuse so an earlier run cannot masquerade as current evidence.
  await mkdir(out, { recursive: false });
  const pkg = await getBlenderStarterPackage();
  pkg.manifest.format = options.format;
  const revision = { manifest: pkg.manifest, files: pkg.files, entryPath: 'scene.py' };
  const provenance = { binding: 'acceptance-script', version: '4.2.0', engine: options.engine, device: options.engine === 'CYCLES' ? 'CPU' : 'GPU',
    backend: options.engine === 'CYCLES' ? 'CPU' : options.backend, executionMode: options.mode, contained: options.mode === 'contained' };
  const nativeWorker = options.mode === 'contained' ? runContainedWorker : runTrustedLocalWorker;
  const workerRuns = [];
  const worker = async request => {
    const result = await nativeWorker({ ...request, workspaceRoot: join(out, 'workers') });
    workerRuns.push({ status: result.status, reason: result.reason, signal: result.signal,
      durationMs: result.durationMs, processGroupClear: result.processGroupClear });
    return result;
  };
  const resolveRuntime = async () => ({ executable: resolve(options.executable), worker, provenance });
  const retained = [];
  const evidence = { script: 'code-animation-blender-acceptance', startedAt: new Date().toISOString(),
    mode: options.mode, engine: options.engine, format: options.format, phase: options.phase,
    sourceHash: sha(pkg.files[0].content), workerRuns, accepted: false };
  async function run(label, { phase, times = [], captureTimes = [], signal } = {}) {
    const runDir = join(out, label);
    await mkdir(runDir);
    const retain = async (_project, _run, name, bytes) => {
      const file = name.replace(/^[a-z]+-[0-9a-f-]{36}-/, '');
      await writeFile(join(runDir, file), bytes, { flag: 'wx' });
      retained.push({ label, file, bytes: bytes.length });
      return { relativePath: join('acceptance', label, file), bytes: bytes.length, sha256: sha(bytes) };
    };
    const started = Date.now();
    const result = await render({ revision, runtime: provenance, projectId: 'acceptance', runId: label, signal,
      reserve: async () => {}, phase, times, captureTimes, diskBytes: 8 * 1024 ** 3, wallSeconds: 6 * 3600 }, { resolveRuntime, retain });
    const elapsedMs = Date.now() - started;
    console.log(`✅ ${label}: ${result.samples.length} sampled frames, ${result.artifacts.length} artifacts in ${(elapsedMs / 1000).toFixed(1)}s`);
    return { result, elapsedMs };
  }
  try {
    // Fingerprint bytes, never publish a machine-local executable path.
    evidence.executableHash = sha(await readFile(options.executable));
    await writeFile(join(out, 'scene.py'), pkg.files[0].content, { flag: 'wx' });
    await writeFile(join(out, 'manifest.json'), JSON.stringify(pkg.manifest, null, 2), { flag: 'wx' });
    if (options.cancelAfter !== null) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.cancelAfter * 1000);
      const started = Date.now();
      let error;
      try { await run('cancel', { phase: options.phase, signal: controller.signal }); } catch (failure) { error = failure; }
      finally { clearTimeout(timer); }
      evidence.cancel = { aborted: controller.signal.aborted, rejected: Boolean(error), abortError: error?.name === 'AbortError',
        afterMs: Date.now() - started, artifactsRetainedAfterCancel: retained.filter(item => item.label === 'cancel').length };
      evidence.accepted = evidence.cancel.aborted && evidence.cancel.abortError && evidence.cancel.artifactsRetainedAfterCancel === 0
        && workerRuns.length === 1 && workerRuns[0].processGroupClear === true && workerRuns[0].reason === 'canceled';
    } else if (options.repeat) {
      const first = await run('sample-a', { phase: 'style', times: options.times, captureTimes: options.times });
      const second = await run('sample-b', { phase: 'style', times: options.times, captureTimes: options.times });
      const pairs = first.result.samples.map((sample, index) => ({ t: sample.t, a: sample.renderHash, b: second.result.samples[index]?.renderHash,
        identical: sample.t === second.result.samples[index]?.t && sample.renderHash === second.result.samples[index]?.renderHash }));
      evidence.repeat = { samples: pairs, allIdentical: pairs.length === options.times.length
        && second.result.samples.length === pairs.length && pairs.every(pair => pair.identical),
        elapsedMs: [first.elapsedMs, second.elapsedMs], renderer: first.result.renderer };
      evidence.accepted = evidence.repeat.allIdentical;
    } else {
      const { result, elapsedMs } = await run(options.phase, { phase: options.phase,
        times: options.phase === 'style' ? options.times : [], captureTimes: options.phase === 'style' ? options.times : [] });
      evidence.sequence = { elapsedMs, contract: result.contract, geometry: result.sequence?.geometry ?? null,
        video: result.sequence?.artifact ? { file: 'sequence.mp4', bytes: result.sequence.artifact.bytes, sha256: result.sequence.artifact.sha256 } : null,
        renderer: result.renderer, frameHashes: result.samples.map(sample => ({ t: sample.t, sha256: sample.renderHash })) };
      evidence.accepted = options.phase === 'style' ? result.samples.length === options.times.length : Boolean(result.sequence);
    }
  } catch (error) {
    // Detailed exceptions can contain private paths; retain only bounded failure identity.
    evidence.error = { name: error.name, code: error.code ?? null };
  }
  evidence.retainedBytes = retained.reduce((sum, item) => sum + item.bytes, 0);
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(`${evidence.accepted ? '✅' : '❌'} Acceptance ${evidence.accepted ? 'passed' : 'failed'}; evidence.json written`);
  return evidence;
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    const options = parseAcceptanceArgs(process.argv.slice(2));
    if (options.mode === 'trusted-local') console.log('⚠️ Explicit trusted-local acceptance: bundled scene code has host filesystem/network access; no containment.');
    const evidence = await runAcceptance(options);
    process.exitCode = evidence.accepted ? 0 : 1;
  } catch (error) {
    console.error(`❌ Acceptance refused (${error.code || error.name})`);
    process.exitCode = 2;
  }
}
