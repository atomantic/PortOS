import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { mkdir, mkdtemp, readdir, readFile, writeFile, appendFile, rename, rm, stat, statfs } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/paths.js';
import { safeUnder, runFfmpegProcess, findFfprobe } from '../../lib/ffmpeg.js';
import { broadcastSse, attachSseClient, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { trackedRenderMap } from '../renderActivity.js';
import { requireProject } from './requireProject.js';
import { mutateProjectRecord } from './projects.js';
import { assertRenderCleanupIdle } from './renderCleanupActivity.js';
import { inspectDcpReadiness, dcpSourceProblems, locateDcpTool, probeDcpSource, dcpSourceDigest } from './dcpPreflight.js';

const exec = promisify(execFile);
const jobs = new Map();
const active = trackedRenderMap('music-video-dcp', { noun: 'cinema package export', link: id => `/music-video/${encodeURIComponent(id)}` });
const failure = (message, code = 'DCP_UNAVAILABLE', status = 409) => new ServerError(message, { status, code });
export const isDcpActive = id => active.has(id);
export const activeDcp = id => {
  const jobId = active.get(id);
  return jobId && jobs.get(jobId)?.status === 'running' ? { jobId } : null;
};
export const attachDcp = (id, res) => attachSseClient(jobs, id, res);
export function cancelDcp(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running' || job.committing) return false;
  job.abort.abort();
  return true;
}


async function command(bin, args, signal, label, env) {
  if (signal.aborted) throw new Error('Export cancelled');
  const result = await runFfmpegProcess({ bin, args, signal, env });
  if (!result.ok) throw new Error(`${label} failed: ${result.reason}`);
}

async function assertConstantFrameTiming(path, signal) {
  const bin = await findFfprobe();
  const result = await exec(bin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', path], safeChildProcessOptions({ signal, timeout: 120000, maxBuffer: 32 * 1024 * 1024 }));
  const frames = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => Number(line.split(',')[0]));
  if (frames.length < 24 || frames.some((time, index) => !Number.isFinite(time) || (index && Math.abs((time - frames[index - 1]) - 1 / 24) > 0.002))) {
    throw new Error('The source does not have stable 24 fps frame timing. Prepare a constant-frame-rate master before export.');
  }
  return frames.length;
}

function validateFilmMetadata(xml, grade, source, frameCount) {
  const section = (text, tag) => {
    const matches = [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))];
    if (matches.length !== 1) throw new Error(`DCP project has unexpected ${tag} settings.`);
    return matches[0][1];
  };
  const check = (text, values) => {
    for (const [key, value] of Object.entries(values)) if (section(text, key) !== String(value)) throw new Error(`DCP project settings do not match the requested format (${key}).`);
  };
  const metadata = section(xml, 'Metadata');
  const playlist = section(metadata, 'Playlist');
  const filmFields = metadata.replace(/<Playlist>[\s\S]*?<\/Playlist>/, '');
  check(filmFields, { Container: '185', Resolution: '2K', VideoFrameRate: '24', AudioChannels: '6', ThreeD: '0', Interop: '0', Encrypted: '0', EncryptPicture: '0', EncryptSound: '0', EncryptText: '0', AudioFrameRate: '48000', VideoEncoding: 'jpeg2000' });
  const content = section(playlist, 'Content');
  const conversion = section(content, 'ColourConversion');
  const audio = section(content, 'AudioStream');
  const mapping = section(audio, 'Mapping');
  check(content, { VideoWidth: source.width, VideoHeight: source.height, VideoLength: frameCount, VideoFrameRate: '24', VideoFrameType: '2d', SampleAspectRatio: '1', LeftCrop: '0', RightCrop: '0', TopCrop: '0', BottomCrop: '0', TrimStart: '0', TrimEnd: '0', Position: '0', Use: '1', Range: 'video', VideoFadeIn: '0', VideoFadeOut: '0', AudioFadeIn: '0', AudioFadeOut: '0', AudioDelay: '0', AudioGain: '0' });
  check(conversion, { YUVToRGB: '1', RedX: '0.64', RedY: '0.33', GreenX: '0.3', GreenY: '0.6', BlueX: '0.15', BlueY: '0.06', WhiteX: '0.3127', WhiteY: '0.329', OutputGamma: '2.6' });
  check(section(conversion, 'InputTransferFunction'), { Type: 'Gamma', Gamma: grade === 'rec709' ? '2.2' : '2.4' });
  check(mapping, { InputChannels: '2', OutputChannels: '16' });
  const gains = [...mapping.matchAll(/<Gain input="(\d+)" output="(\d+)">([^<]+)<\/Gain>/g)];
  if (gains.length !== 32) throw new Error('DCP project has unexpected audio routing.');
  const seen = new Set();
  for (const [, input, output, value] of gains) {
    const key = `${input}:${output}`;
    if (seen.has(key) || Number(input) > 1 || Number(output) > 15 || Number(value) !== (input === output ? 1 : 0)) throw new Error('DCP project has unexpected audio routing.');
    seen.add(key);
  }
}

export async function startDcp(projectId, { grade, renderHistoryId, sourceSha256 }) {
  assertRenderCleanupIdle(projectId);
  if (active.has(projectId)) throw new ServerError('A cinema package export is already running.', { status: 409, code: 'DCP_IN_PROGRESS', context: activeDcp(projectId) || undefined });
  if (!['rec709', 'rec1886'].includes(grade)) throw failure('Select the grading conversion used for this source.', 'DCP_GRADE_REQUIRED');
  const jobId = `mvdcp-${randomUUID()}`;
  active.set(projectId, jobId);
  const job = { id: jobId, status: 'running', clients: [], abort: new AbortController() };
  jobs.set(jobId, job);
  const run = async () => {
    broadcastSse(job, { type: 'progress', stage: 'Checking the inspected source and tools' });
    const readiness = await inspectDcpReadiness(projectId, { signal: job.abort.signal });
    if (readiness.renderHistoryId !== renderHistoryId || readiness.sourceSha256 !== sourceSha256) throw failure('The final render changed since inspection. Inspect it again.', 'DCP_SOURCE_CHANGED');
    const problems = readiness.sourceError ? [readiness.sourceError] : dcpSourceProblems(readiness.source);
    if (problems.length) throw failure(problems.join(' '), 'DCP_SOURCE_UNSUPPORTED');
    if (!Object.values(readiness.tools).every(Boolean)) throw failure('Install DCP-o-matic with create, encoder and verifier CLI tools, and ffprobe. See the DCP guide.', 'DCP_TOOLS_MISSING');
    const project = await requireProject(projectId);
    if (project.renderHistoryId !== readiness.renderHistoryId) throw failure('The final render changed. Inspect it again.', 'DCP_SOURCE_CHANGED');
    const { getHistoryItem } = await import('../videoGen/history.js');
    const entry = await getHistoryItem(project.renderHistoryId);
    const sourcePath = safeUnder(PATHS.videos, entry?.filename);
    if (!sourcePath) throw failure('The final render is missing.', 'DCP_SOURCE_MISSING');
    const [create, encoder, verifier] = await Promise.all(['dcpomatic2_create', 'dcpomatic2_cli', 'dcpomatic2_verify_cli'].map(locateDcpTool));
    if (!create || !encoder || !verifier) throw failure('The DCP-o-matic toolchain is unavailable.', 'DCP_TOOLS_MISSING');
    if (job.abort.signal.aborted) throw new Error('Export cancelled');
      await mkdir(PATHS.videos, { recursive: true });
      const free = await statfs(PATHS.videos);
      const sourceBytes = (await stat(sourcePath)).size;
      const estimate = sourceBytes + readiness.source.durationSec * (250000000 / 8 + 6 * 48000 * 3) + 2 * 1024 ** 3;
      if (free.bavail * free.bsize < estimate) throw new Error('Not enough free disk space for the package and temporary files. Free space and try again.');
      const root = await mkdtemp(join(PATHS.videos, 'dcp-'));
      let committed = false;
      let publicationAttempted = false;
      try {
        const sourceCopy = join(root, `source${entry.filename.slice(entry.filename.lastIndexOf('.'))}`);
        broadcastSse(job, { type: 'progress', stage: 'Copying and checking the source' });
        const before = await dcpSourceDigest(sourcePath, job.abort.signal);
        if (before !== sourceSha256) throw new Error('The final render changed since inspection. Inspect it again.');
        await pipeline(createReadStream(sourcePath), createWriteStream(sourceCopy, { flags: 'wx' }), { signal: job.abort.signal });
        const [copyHash, after] = await Promise.all([dcpSourceDigest(sourceCopy, job.abort.signal), dcpSourceDigest(sourcePath, job.abort.signal)]);
        if (before !== after || before !== copyHash || job.abort.signal.aborted) throw new Error('The source changed or the export was cancelled while copying.');
        const temp = join(root, 'temp');
        await mkdir(temp);
        const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp };
        const config = join(root, 'config');
        const film = join(root, 'film');
        await mkdir(config);
        const stagedSource = await probeDcpSource(sourceCopy, job.abort.signal);
        const stagedProblems = dcpSourceProblems(stagedSource);
        if (stagedProblems.length || JSON.stringify(stagedSource) !== JSON.stringify(readiness.source)) throw new Error('The source changed since inspection or is unsupported. Inspect it again.');
        broadcastSse(job, { type: 'progress', stage: 'Checking frame timing' });
        const frameCount = await assertConstantFrameTiming(sourceCopy, job.abort.signal);
        broadcastSse(job, { type: 'progress', stage: 'Preparing the cinema project' });
        await command(create, ['--config', config, '--no-encrypt', '--standard', 'SMPTE', '--twok', '--twod', '-f', '24', '-a', '6', '--container-ratio', '185', '-c', 'SHR', '-n', 'Music video', '--colourspace', grade, '-o', film, sourceCopy], job.abort.signal, 'DCP project creation', env);
        validateFilmMetadata(await readFile(join(film, 'metadata.xml'), 'utf8'), grade, stagedSource, frameCount);
        broadcastSse(job, { type: 'progress', stage: 'Encoding the cinema package' });
        await command(encoder, ['--config', config, '--no-remote', '--no-progress', film], job.abort.signal, 'DCP encode', env);
        const entries = await readdir(film, { withFileTypes: true });
        const candidates = [];
        for (const dir of entries.filter(e => e.isDirectory())) {
          const names = await readdir(join(film, dir.name));
          if (names.includes('ASSETMAP') || names.includes('ASSETMAP.xml')) candidates.push(dir.name);
        }
        if (candidates.length !== 1) throw new Error('The encoder did not produce exactly one DCP package.');
        const packagePath = join(root, 'package');
        await rename(join(film, candidates[0]), packagePath);
        const report = join(root, 'verification.txt');
        broadcastSse(job, { type: 'progress', stage: 'Verifying the package' });
        let verifierOutput = '';
        let outputOverflow = false;
        const verify = await runFfmpegProcess({ bin: verifier, args: ['-q', '-o', report, packagePath], signal: job.abort.signal, env, onStdout: chunk => {
          if (verifierOutput.length + chunk.length > 8 * 1024 * 1024) outputOverflow = true;
          else verifierOutput += chunk.toString();
        } });
        if (job.abort.signal.aborted) throw new Error('Export cancelled');
        const reportText = await readFile(report, 'utf8').catch(() => '');
        if (!reportText) await writeFile(report, `The verifier did not produce a report: ${verify.reason || 'unknown error'}\n`);
        if (outputOverflow) await appendFile(report, '\nVerifier output exceeded the capture limit. Run verification in DCP-o-matic directly.\n');
        if (verifierOutput.trim()) await appendFile(report, `\nVerifier messages (including severity):\n${verifierOutput}`);
        await rm(sourceCopy, { force: true });
        await rm(film, { recursive: true, force: true });
        await rm(config, { recursive: true, force: true });
        await rm(temp, { recursive: true, force: true });
        const artifact = { id: basename(root), sourceRenderId: readiness.renderHistoryId, sourceSha256: before,
          source: readiness.source, grade, container: { width: 1998, height: 1080 }, standard: 'SMPTE', frameRate: 24,
          status: verify.ok && reportText && !outputOverflow ? 'verified' : 'verification-failed', hasWarnings: /^Warning:/m.test(verifierOutput), createdAt: new Date().toISOString() };
        if (job.abort.signal.aborted) throw new Error('Export cancelled');
        job.committing = true;
        publicationAttempted = true;
        await withBackupAssetPublication(() => mutateProjectRecord(projectId, current => ({ project: { ...current, dcpExports: [...(current.dcpExports || []), artifact] } }))).catch(() => { throw new Error(`Could not save the package record. The output was retained at ${root}; inspect it before removing it.`); });
        committed = true;
        return artifact;
      } finally {
        if (!committed && !publicationAttempted) await rm(root, { recursive: true, force: true });
      }
    };
    Promise.resolve().then(run).then(artifact => {
      job.status = 'complete'; active.delete(projectId);
      broadcastSse(job, { type: 'complete', result: artifact }); closeJobAfterDelay(jobs, jobId);
    }).catch(err => {
      const canceled = job.abort.signal.aborted;
      job.status = canceled ? 'canceled' : 'error'; active.delete(projectId);
      if (!canceled) console.error(`Cinema package export failed [${jobId.slice(0, 14)}]: ${err.code || 'EXPORT_FAILED'}`);
      broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: canceled ? 'Cinema package export cancelled' : err.message }); closeJobAfterDelay(jobs, jobId);
    });
  return { jobId };
}

/** Only resolve an artifact named by this project's persisted record. */
export async function dcpArtifactPaths(projectId, artifactId) {
  const project = await requireProject(projectId);
  if (!Array.isArray(project.dcpExports) || !project.dcpExports.some(item => item.id === artifactId)) throw failure('Cinema package not found.', 'NOT_FOUND', 404);
  const root = safeUnder(PATHS.videos, artifactId);
  if (!root || !/^dcp-[A-Za-z0-9]+$/.test(artifactId)) throw failure('Cinema package not found.', 'NOT_FOUND', 404);
  const packagePath = join(root, 'package');
  const reportPath = join(root, 'verification.txt');
  const present = await stat(packagePath).then(value => value.isDirectory()).catch(() => false);
  if (!present) throw failure('This package is not present on this host.', 'NOT_FOUND', 404);
  return { packagePath, reportPath };
}
