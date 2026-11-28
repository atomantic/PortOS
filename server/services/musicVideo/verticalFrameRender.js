/**
 * Server encoder for framed 9:16 vertical videos (1080x1920):
 * composites the full uncropped 16:9 master inside TikTok's safe-render window over
 * a live blurred ambient backdrop, a vector-crisp static header/border PNG, and a
 * 12 fps raw RGBA dynamic footer stream (synced lyrics, waveform, progress bar).
 */
import { spawn } from '../../lib/childProcess.js';
import { unlink } from 'fs/promises';
import {
  VERTICAL_FOOTER_HEIGHT,
  VERTICAL_FOOTER_Y,
  VERTICAL_FRAME_HEIGHT,
  VERTICAL_FRAME_WIDTH,
  resolveVerticalFrameTheme,
  verticalFrameDynamicSvg,
  verticalFrameStaticSvg,
} from '../../lib/musicVideo/musicVideoVerticalFrame.js';
import { edgeFadeFilter } from '../../lib/ffmpeg.js';

const FOOTER_FPS = 12;

let sharpPromise = null;
const loadSharp = () => (sharpPromise ??= import('sharp').then((m) => m.default || m));

/**
 * Render a framed 9:16 video from a 16:9 master MP4.
 * Writes directly to `outputPath` and cleans up its temporary static chrome PNG.
 */
export async function renderVerticalFramedVideo({
  ffmpeg,
  masterPath,
  outputPath,
  startSec = 0,
  endSec,
  frameOptions = {},
  lyrics = [],
  beats = [],
  videoArgs = [],
  audioArgs = [],
  fade = false,
  signal,
  onProgress,
}) {
  const sharp = await loadSharp();
  const spanSec = Math.max(0.1, endSec - startSec);
  const theme = resolveVerticalFrameTheme(frameOptions.theme);
  const { x, y, width, height } = theme.videoRect;
  const staticPngPath = `${outputPath}.chrome.png`;

  const staticSvg = verticalFrameStaticSvg({
    theme: theme.id,
    title: frameOptions.title,
    subtitle: frameOptions.subtitle,
  });
  await sharp(Buffer.from(staticSvg)).png().toFile(staticPngPath);

  const dimBrightness = -Math.min(0.45, Math.max(0.08, theme.backdropDim * 0.42));
  const blurRadius = Math.max(12, Math.min(36, Math.round(theme.backdropBlurPx * 0.85)));
  const filterComplex = [
    `[0:v]split=2[bg][fg]`,
    `[bg]scale=${VERTICAL_FRAME_WIDTH}:${VERTICAL_FRAME_HEIGHT}:force_original_aspect_ratio=increase,crop=${VERTICAL_FRAME_WIDTH}:${VERTICAL_FRAME_HEIGHT},boxblur=${blurRadius}:4,eq=brightness=${dimBrightness.toFixed(2)}:saturation=1.12[b]`,
    `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black[f]`,
    `[b][f]overlay=${x}:${y}[v1]`,
    `[v1][1:v]overlay=0:0[v2]`,
    `[v2][2:v]overlay=0:${VERTICAL_FOOTER_Y}:shortest=1,setsar=1[vout]`,
  ].join(';');

  const inputTrim = startSec > 0 ? ['-ss', String(startSec)] : [];
  const audioFilter = fade
    ? ['-af', `asetpts=PTS-STARTPTS${edgeFadeFilter(spanSec)}`]
    : ['-af', 'asetpts=PTS-STARTPTS'];

  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...inputTrim, '-t', String(spanSec), '-i', masterPath,
    '-loop', '1', '-i', staticPngPath,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${VERTICAL_FRAME_WIDTH}x${VERTICAL_FOOTER_HEIGHT}`, '-r', String(FOOTER_FPS), '-i', 'pipe:0',
    '-filter_complex', filterComplex,
    '-map', '[vout]', '-map', '0:a:0?',
    ...videoArgs,
    ...audioFilter,
    ...audioArgs,
    '-shortest',
    '-y', outputPath,
  ];

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => {
        proc.kill('SIGTERM');
        done(signal?.reason || new Error('Aborted'));
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      proc.stdin.on('error', () => {});
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', done);
      proc.on('close', (code) => {
        if (code === 0) done();
        else done(new Error(`Framed vertical encode failed (${code}): ${stderr.trim() || 'ffmpeg error'}`));
      });

      const waitForDrain = () => new Promise((resolve) => {
        if (settled || signal?.aborted || proc.stdin.destroyed || proc.stdin.writableEnded) {
          resolve();
          return;
        }
        const finish = () => {
          proc.stdin.off('drain', finish);
          proc.stdin.off('close', finish);
          proc.stdin.off('error', finish);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        proc.stdin.once('drain', finish);
        proc.stdin.once('close', finish);
        proc.stdin.once('error', finish);
        signal?.addEventListener('abort', finish, { once: true });
      });

      const totalFrames = Math.max(1, Math.ceil(spanSec * FOOTER_FPS));
      const feedFrames = async () => {
        for (let i = 0; i < totalFrames; i++) {
          if (settled || signal?.aborted) break;
          const timeSec = startSec + i / FOOTER_FPS;
          const svg = verticalFrameDynamicSvg({
            theme: theme.id,
            timeSec,
            startSec,
            endSec,
            lyrics,
            beats,
            showLyrics: Boolean(frameOptions.showLyrics),
            showWaveform: frameOptions.showWaveform !== false,
            footerNote: frameOptions.footerNote,
          });
          const raw = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
          if (settled || signal?.aborted) break;
          if (!proc.stdin.write(raw)) {
            await waitForDrain();
          }
          if (onProgress && (i % 6 === 0 || i === totalFrames - 1)) {
            onProgress((i + 1) / totalFrames);
          }
        }
        if (!settled) proc.stdin.end();
      };
      feedFrames().catch((err) => {
        proc.kill('SIGTERM');
        done(err);
      });
    });
  } finally {
    await unlink(staticPngPath).catch(() => {});
  }
}
