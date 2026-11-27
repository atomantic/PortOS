/**
 * Real-ESRGAN local runtime (#19985): the install target, its read-only
 * readiness check, and the explicit install action.
 *
 * The runtime is the official `realesrgan-ncnn-vulkan` release from
 * xinntao/Real-ESRGAN: one self-contained GPU binary (Vulkan, MoltenVK on
 * macOS) plus the bundled weights. Nothing here is fetched implicitly:
 *
 *  - `describeRealesrganRuntime` only stats files and reads the install
 *    receipt, so the plan endpoint and project loads stay free of downloads,
 *    process spawns and provider access.
 *  - `streamRealesrganInstall` is the ONLY path that downloads. It pins the
 *    archive by SHA-256, unpacks just the binary and the weights PortOS runs,
 *    and then proves the install works on this machine's GPU by running every
 *    selectable weight over a tiny synthetic frame. The receipt records which
 *    weights passed, and readiness requires that receipt.
 */

import { existsSync } from 'fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { streamResumableDownload } from '../../lib/downloadPreflight.js';
import { readZipArchive, unsafeZipEntryName } from '../../lib/zipArchive.js';
import { createInstallLogger } from '../../lib/installLogger.js';
import { findFfmpeg, probeVideoStreamInfo, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { REALESRGAN_MODELS, REALESRGAN_RUNTIME_ID } from './upscalePlan.js';

const RELEASE_TAG = 'v0.2.5.0';
const RELEASE_BUILD = '20220424';
const RELEASE_BASE_URL = `https://github.com/xinntao/Real-ESRGAN/releases/download/${RELEASE_TAG}`;
export const REALESRGAN_RELEASE_PAGE = `https://github.com/xinntao/Real-ESRGAN/releases/tag/${RELEASE_TAG}`;
export const REALESRGAN_LABEL = 'Real-ESRGAN (ncnn Vulkan)';
const RECEIPT_FILE = 'portos-install.json';
const RECEIPT_VERSION = 1;
const SELF_TEST_TIMEOUT_MS = 2 * 60 * 1000;

// One archive per host class. Digests were taken from the published release
// assets; a mismatch deletes the download rather than unpacking it. The Linux
// and Windows builds are x86-64 only, while the macOS build is universal.
const RELEASE_ASSETS = Object.freeze({
  darwin: Object.freeze({
    archive: `realesrgan-ncnn-vulkan-${RELEASE_BUILD}-macos.zip`,
    sha256: 'e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a',
    sizeBytes: 51817124,
    binary: 'realesrgan-ncnn-vulkan',
    support: [],
    arches: null,
  }),
  win32: Object.freeze({
    archive: `realesrgan-ncnn-vulkan-${RELEASE_BUILD}-windows.zip`,
    sha256: 'abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d',
    sizeBytes: 45474481,
    binary: 'realesrgan-ncnn-vulkan.exe',
    // The OpenMP runtime the Windows binary links against ships beside it.
    support: ['vcomp140.dll'],
    arches: ['x64'],
  }),
  linux: Object.freeze({
    archive: `realesrgan-ncnn-vulkan-${RELEASE_BUILD}-ubuntu.zip`,
    sha256: 'e5aa6eb131234b87c0c51f82b89390f5e3e642b7b70f2b9bbe95b6a285a40c96',
    sizeBytes: 46931474,
    binary: 'realesrgan-ncnn-vulkan',
    support: [],
    arches: ['x64'],
  }),
});

export const realesrganRoot = () => join(homedir(), '.portos', 'realesrgan-ncnn-vulkan');
const installDirFor = () => join(realesrganRoot(), RELEASE_BUILD);

/** What this host would install, or `{ supported: false, reason }`. Pure: no I/O. */
export function realesrganInstallTarget({ platform = process.platform, arch = process.arch } = {}) {
  const asset = RELEASE_ASSETS[platform];
  if (!asset) return { supported: false, reason: `Real-ESRGAN has no published ncnn build for ${platform}.` };
  if (asset.arches && !asset.arches.includes(arch)) {
    return { supported: false, reason: `The published Real-ESRGAN ${platform} build is x86-64 only; this host is ${arch}.` };
  }
  const installDir = installDirFor();
  return {
    supported: true,
    version: RELEASE_TAG,
    build: RELEASE_BUILD,
    archive: asset.archive,
    url: `${RELEASE_BASE_URL}/${asset.archive}`,
    releasePage: REALESRGAN_RELEASE_PAGE,
    sha256: asset.sha256,
    sizeBytes: asset.sizeBytes,
    installDir,
    binaryPath: join(installDir, asset.binary),
    modelDir: join(installDir, 'models'),
    asset,
  };
}

const readReceipt = async (installDir) => {
  const raw = await readFile(join(installDir, RECEIPT_FILE), 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    const receipt = JSON.parse(raw);
    return receipt && typeof receipt === 'object' ? receipt : null;
  } catch {
    return null;
  }
};

const modelFilesPresent = (modelDir, model) => model.files.every((file) => existsSync(join(modelDir, file)));

/**
 * Readiness for `modelId` on this host. Read-only: stats the binary and model
 * files and parses the install receipt; it never spawns the binary or fetches.
 */
export async function describeRealesrganRuntime(modelId) {
  const model = REALESRGAN_MODELS[modelId] || null;
  const target = realesrganInstallTarget();
  const base = { id: REALESRGAN_RUNTIME_ID, label: REALESRGAN_LABEL };
  const installTarget = target.supported ? {
    version: target.version,
    archive: target.archive,
    url: target.url,
    releasePage: target.releasePage,
    sha256: target.sha256,
    sizeBytes: target.sizeBytes,
    installDir: target.installDir,
  } : null;
  const modelInfo = model ? { id: model.id, label: model.label, nativeScale: model.nativeScale } : null;
  if (!target.supported) {
    return { ...base, supported: false, installed: false, verified: false, reason: target.reason, installTarget, model: modelInfo };
  }
  const receipt = await readReceipt(target.installDir);
  const binaryPresent = existsSync(target.binaryPath);
  const receiptCurrent = receipt?.receiptVersion === RECEIPT_VERSION && receipt.version === target.version && receipt.sha256 === target.sha256;
  const modelReady = !!model && modelFilesPresent(target.modelDir, model);
  const verified = !!model && receiptCurrent && Array.isArray(receipt.verifiedModels) && receipt.verifiedModels.includes(model.id);
  const installed = binaryPresent && receiptCurrent;
  const reason = !model
    ? `Unknown Real-ESRGAN weights '${modelId}'.`
    : !installed
      ? `${REALESRGAN_LABEL} is not installed on this machine. Install it (${Math.round(target.sizeBytes / 1e6)} MB download) to use it.`
      : !modelReady
        ? `The ${model.label} weights are missing from the install. Reinstall Real-ESRGAN to repair it.`
        : !verified
          ? `The ${model.label} weights did not pass the install check on this GPU. Reinstall Real-ESRGAN to recheck.`
          : null;
  return {
    ...base,
    supported: true,
    installed: installed && modelReady && verified,
    binaryPresent,
    verified,
    reason,
    installTarget,
    gpu: receiptCurrent ? receipt.gpu ?? null : null,
    verifiedAt: receiptCurrent ? receipt.verifiedAt ?? null : null,
    model: modelInfo,
  };
}

/** The binary invocation for a READY install, or a refusal naming what is missing. */
export async function resolveRealesrganInvocation(modelId) {
  const runtime = await describeRealesrganRuntime(modelId);
  if (!runtime.installed) {
    throw new ServerError(runtime.reason || `${REALESRGAN_LABEL} is not ready.`, { status: 400, code: 'REALESRGAN_NOT_READY' });
  }
  const target = realesrganInstallTarget();
  const model = REALESRGAN_MODELS[modelId];
  return { bin: target.binaryPath, modelDir: target.modelDir, network: model.network, nativeScale: model.nativeScale };
}

/** argv for one Real-ESRGAN pass over `input` (a file or a directory of frames). */
export const realesrganArgs = ({ input, output, modelDir, network, nativeScale }) => [
  '-i', input,
  '-o', output,
  '-n', network,
  '-s', String(nativeScale),
  '-m', modelDir,
  '-f', 'png',
];

// The archive members PortOS keeps: the binary, its support libraries and the
// selectable weights. Demo media and readmes are left behind.
const wantedMembers = (asset) => new Set([
  asset.binary,
  ...asset.support,
  ...Object.values(REALESRGAN_MODELS).flatMap((model) => model.files.map((file) => `models/${file}`)),
]);

async function unpackArchive(archivePath, stagingDir, asset) {
  const entries = readZipArchive(await readFile(archivePath));
  const wanted = wantedMembers(asset);
  const found = new Set();
  for (const entry of entries) {
    if (entry.isDirectory || !wanted.has(entry.name)) continue;
    const problem = unsafeZipEntryName(entry.name);
    if (problem || entry.isSymlink) throw new ServerError(`Refusing archive member ${entry.name}: ${problem || 'symlink'}`, { status: 502, code: 'REALESRGAN_ARCHIVE_INVALID' });
    const dest = join(stagingDir, ...entry.name.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, entry.read());
    found.add(entry.name);
  }
  const missing = [...wanted].filter((name) => !found.has(name));
  if (missing.length) throw new ServerError(`The Real-ESRGAN archive is missing ${missing.join(', ')}`, { status: 502, code: 'REALESRGAN_ARCHIVE_INVALID' });
  if (process.platform !== 'win32') await chmod(join(stagingDir, asset.binary), 0o755);
}

const GPU_LINE_RE = /^\[\d+\s+([^\]]+)\]/m;

/**
 * Run every selectable weight over a tiny synthetic frame and check the output
 * is the network's scale. This is what proves the binary loads on this GPU;
 * a host with no Vulkan device fails here, at install, rather than in a job.
 */
async function verifyInstall({ stagingDir, asset, signal, log }) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg is required to check the Real-ESRGAN install', { status: 500, code: 'FFMPEG_MISSING' });
  const scratch = join(tmpdir(), `portos-realesrgan-check-${randomUUID()}`);
  await mkdir(scratch, { recursive: true });
  try {
    const input = join(scratch, 'input.png');
    const made = await runFfmpegProcess({
      bin: ffmpeg, signal, timeoutMs: SELF_TEST_TIMEOUT_MS,
      args: ['-f', 'lavfi', '-i', 'testsrc2=size=32x24', '-frames:v', '1', '-y', input],
    });
    if (!made.ok) throw new ServerError(`Could not make the install check frame: ${made.reason}`, { status: 500, code: 'REALESRGAN_VERIFY_FAILED' });
    const verifiedModels = [];
    let gpu = null;
    for (const model of Object.values(REALESRGAN_MODELS)) {
      const output = join(scratch, `${model.id}.png`);
      log(`▸ Checking ${model.label} on this GPU…`);
      const ran = await runFfmpegProcess({
        bin: join(stagingDir, asset.binary),
        label: 'Real-ESRGAN',
        signal,
        timeoutMs: SELF_TEST_TIMEOUT_MS,
        returnStderr: true,
        stderrTailBytes: 8000,
        args: realesrganArgs({ input, output, modelDir: join(stagingDir, 'models'), network: model.network, nativeScale: model.nativeScale }),
      });
      if (!ran.ok) throw new ServerError(`${model.label} failed its install check: ${ran.reason}`, { status: 500, code: 'REALESRGAN_VERIFY_FAILED' });
      gpu ??= GPU_LINE_RE.exec(ran.stderr || '')?.[1]?.trim() || null;
      const measured = existsSync(output) ? await probeVideoStreamInfo(output) : {};
      if (measured.width !== 32 * model.nativeScale || measured.height !== 24 * model.nativeScale) {
        throw new ServerError(
          `${model.label} produced ${measured.width ?? '?'}×${measured.height ?? '?'} instead of ${32 * model.nativeScale}×${24 * model.nativeScale}`,
          { status: 500, code: 'REALESRGAN_VERIFY_FAILED' },
        );
      }
      verifiedModels.push(model.id);
    }
    return { verifiedModels, gpu };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

let installInFlight = null;

/**
 * Download, verify, unpack and self-test the runtime. `onEvent` receives the
 * SSE frames (`log`, `progress`, `stage`); resolves the receipt. `fetchImpl`
 * and `target` exist for tests, which install a stand-in archive.
 */
export async function installRealesrganRuntime({ onEvent = () => {}, signal, fetchImpl = fetch, target = realesrganInstallTarget() } = {}) {
  if (!target.supported) throw new ServerError(target.reason, { status: 501, code: 'REALESRGAN_UNSUPPORTED' });
  if (installInFlight) throw new ServerError('A Real-ESRGAN install is already running.', { status: 409, code: 'REALESRGAN_INSTALL_IN_FLIGHT' });
  const claim = {};
  installInFlight = claim;
  const log = (message) => onEvent({ type: 'log', message });
  const archivePath = join(realesrganRoot(), 'downloads', target.archive);
  const stagingDir = join(realesrganRoot(), `.staging-${randomUUID()}`);
  // One progress frame per whole percent, not one per network chunk.
  let lastPercent = -1;
  const onBytes = (received, total) => {
    const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
    if (percent === lastPercent) return;
    lastPercent = percent;
    onEvent({ type: 'progress', progress: percent / 100, received, total });
  };
  try {
    onEvent({ type: 'stage', stage: 'download', message: `Downloading ${target.archive} from the Real-ESRGAN ${target.version} release` });
    await streamResumableDownload({
      url: target.url,
      destPath: archivePath,
      fetchImpl,
      signal,
      isCancelled: () => signal?.aborted === true,
      expectedSha256: target.sha256,
      onBytes,
    });
    log(`✓ SHA-256 verified (${target.sha256.slice(0, 12)}…)`);
    onEvent({ type: 'stage', stage: 'unpack', message: 'Unpacking the binary and weights' });
    await mkdir(stagingDir, { recursive: true });
    await unpackArchive(archivePath, stagingDir, target.asset);
    onEvent({ type: 'stage', stage: 'verify', message: 'Checking every weight on this GPU' });
    const { verifiedModels, gpu } = await verifyInstall({ stagingDir, asset: target.asset, signal, log });
    const receipt = {
      receiptVersion: RECEIPT_VERSION,
      runtime: REALESRGAN_RUNTIME_ID,
      version: target.version,
      sha256: target.sha256,
      platform: process.platform,
      arch: process.arch,
      verifiedModels,
      gpu,
      verifiedAt: new Date().toISOString(),
    };
    await writeFile(join(stagingDir, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`);
    // Swap the verified tree in whole, so a reader never sees a half-written install.
    await rm(target.installDir, { recursive: true, force: true });
    await rename(stagingDir, target.installDir);
    await rm(archivePath, { force: true }).catch(() => {});
    return receipt;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (installInFlight === claim) installInFlight = null;
  }
}

/** SSE transport around `installRealesrganRuntime`; the caller supplies the stream callbacks. */
export async function streamRealesrganInstall({ send, safeEnd, onDisconnect }) {
  const controller = new AbortController();
  const target = realesrganInstallTarget();
  const installLog = createInstallLogger({ installer: REALESRGAN_LABEL, target: target.installDir || REALESRGAN_RUNTIME_ID });
  let finished = false;
  onDisconnect(() => {
    if (finished) return;
    installLog.cancel();
    controller.abort();
  });
  const emit = (event) => {
    installLog.onEvent(event);
    send(event);
  };
  installLog.start();
  try {
    const receipt = await installRealesrganRuntime({ onEvent: emit, signal: controller.signal });
    emit({ type: 'complete', message: `${REALESRGAN_LABEL} ready${receipt.gpu ? ` on ${receipt.gpu}` : ''}`, receipt });
  } catch (err) {
    if (!controller.signal.aborted) emit({ type: 'error', message: err?.message || 'Real-ESRGAN install failed' });
  } finally {
    finished = true;
    safeEnd();
  }
}

/** Test-only: forget an install claim a failed test left behind. */
export const __resetRealesrganInstallForTests = () => { installInFlight = null; };
