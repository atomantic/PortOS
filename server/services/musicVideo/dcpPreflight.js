import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '../../lib/childProcess.js';
import { findFfprobe, safeUnder } from '../../lib/ffmpeg.js';
import { safeChildProcessOptions, whichFirst } from '../../lib/processEnv.js';
import { PATHS } from '../../lib/paths.js';
import { requireProject } from './requireProject.js';

const exec = promisify(execFile);
const executable = async path => access(path, constants.X_OK).then(() => path).catch(() => null);

export async function locateDcpTool(name) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const roots = process.platform === 'darwin'
    ? ['/Applications/DCP-o-matic 2.app/Contents/MacOS']
    : process.platform === 'win32'
      ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'DCP-o-matic 2', 'bin')]
      : [];
  for (const root of roots) {
    const path = await executable(join(root, `${name}${suffix}`));
    if (path) return path;
  }
  return whichFirst(name).catch(() => null);
}

export const dcpSourceDigest = (path, signal) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  const abort = () => stream.destroy(new Error('Export cancelled'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  stream.on('close', () => signal?.removeEventListener('abort', abort));
  stream.on('error', reject);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('end', () => resolve(hash.digest('hex')));
});

/** Inspect the selected render and toolchain without changing project or media. */
export async function inspectDcpReadiness(projectId, { signal } = {}) {
  const project = await requireProject(projectId);
  const { getHistoryItem } = await import('../videoGen/history.js');
  const entry = project.renderHistoryId ? await getHistoryItem(project.renderHistoryId) : null;
  const path = entry?.filename ? safeUnder(PATHS.videos, entry.filename) : null;
  const [create, encoder, verifier, ffprobe] = await Promise.all([
    locateDcpTool('dcpomatic2_create'), locateDcpTool('dcpomatic2_cli'), locateDcpTool('dcpomatic2_verify_cli'), findFfprobe(),
  ]);
  let source = null;
  let sourceError = null;
  let sourceSha256 = null;
  if (!path || !await executableOrFile(path)) sourceError = 'The final render is missing. Render the final video first.';
  else if (!ffprobe) sourceError = 'Install ffprobe to inspect the final render.';
  else {
    source = await probeDcpSource(path, signal).catch(() => null);
    if (!source) sourceError = 'Could not inspect the final render with ffprobe.';
    else sourceSha256 = await dcpSourceDigest(path, signal).catch(() => null);
    if (source && !sourceSha256) sourceError = 'Could not read the final render.';
  }
  const temp = await mkdtemp(join(tmpdir(), 'portos-dcp-probe-'));
  let createOk, encoderOk, verifierOk;
  try {
    const compatible = async (path, flags) => {
      if (!path) return false;
      const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp };
      const result = await exec(path, ['--help'], safeChildProcessOptions({ env, signal, timeout: 10000, maxBuffer: 1024 * 1024 })).catch(error => ({ stdout: error.stdout || '', stderr: error.stderr || '' }));
      const text = `${result?.stdout || ''} ${result?.stderr || ''}`;
      return flags.every(flag => text.includes(flag));
    };
    [createOk, encoderOk, verifierOk] = await Promise.all([
      compatible(create, ['--no-encrypt', '--standard', '--twok', '--twod', '--colourspace']),
      compatible(encoder, ['--no-remote', '--config', '--no-progress']),
      compatible(verifier, ['--quiet', 'report']),
    ]);
    if (createOk && encoderOk) {
      const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp };
      const version = async path => {
        const result = await exec(path, ['--version'], safeChildProcessOptions({ env, signal, timeout: 10000 })).catch(() => null);
        return /dcpomatic version (2\.18\.51)(?:\s|$)/.exec(result?.stdout || '')?.[1] || null;
      };
      const [createVersion, encoderVersion] = await Promise.all([version(create), version(encoder)]);
      if (!createVersion || createVersion !== encoderVersion) { createOk = false; encoderOk = false; }
      if (verifierOk) {
        const result = await exec(verifier, ['--version'], safeChildProcessOptions({ env, signal, timeout: 10000 })).catch(() => null);
        verifierOk = /dcpverify version 1\.10\.64(?:\s|$)/.test(result?.stdout || '');
      }
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
  return { renderHistoryId: project.renderHistoryId || null, source, sourceSha256, sourceError, problems: source ? dcpSourceProblems(source) : [], tools: { create: createOk, encoder: encoderOk, verifier: verifierOk, ffprobe: !!ffprobe } };
}

export async function probeDcpSource(path, signal) {
  const ffprobe = await findFfprobe();
  if (!ffprobe) throw new Error('ffprobe is unavailable.');
  const result = await exec(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], safeChildProcessOptions({ signal, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
  const data = JSON.parse(result.stdout);
  const videos = data.streams?.filter(s => s.codec_type === 'video') || [];
  const video = videos[0];
  const audio = data.streams?.filter(s => s.codec_type === 'audio') || [];
  return video ? { videoStreams: videos.length, fieldOrder: video.field_order, width: video.width, height: video.height, frameRate: video.avg_frame_rate, nominalFrameRate: video.r_frame_rate,
    sampleAspectRatio: video.sample_aspect_ratio, colorRange: video.color_range, colorSpace: video.color_space,
    colorTransfer: video.color_transfer, colorPrimaries: video.color_primaries, audioChannels: audio[0]?.channels,
    audioLayout: audio[0]?.channel_layout, audioStreams: audio.length, durationSec: Number(data.format?.duration) || null } : null;
}

async function executableOrFile(path) {
  return access(path, constants.R_OK).then(() => true).catch(() => false);
}

/** Conservative eligibility screen. The grade still requires an explicit user choice. */
export function dcpSourceProblems(source) {
  if (!source) return ['A readable video and stereo audio source is required.'];
  const problems = [];
  if (source.videoStreams !== 1 || source.fieldOrder !== 'progressive') problems.push('The source must contain one explicitly progressive video stream.');
  if (!Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 1 || source.height < 1) problems.push('Source dimensions are missing.');
  if (source.frameRate !== '24/1' || source.nominalFrameRate !== '24/1') problems.push('The source must report 24 fps; convert it deliberately before export.');
  if (!['1:1', '1/1'].includes(source.sampleAspectRatio)) problems.push('The source must have known square pixels.');
  if (source.audioStreams !== 1 || source.audioChannels !== 2 || source.audioLayout !== 'stereo') problems.push('The source must contain one explicitly labeled stereo audio stream.');
  if (source.colorPrimaries !== 'bt709' || source.colorSpace !== 'bt709' || source.colorTransfer !== 'bt709' || source.colorRange !== 'tv') problems.push('The source must have explicit BT.709 primaries, matrix and transfer metadata, and video-range levels. Correct missing or unsupported metadata first.');
  if (!(source.durationSec > 0)) problems.push('The source duration is missing.');
  return problems;
}
