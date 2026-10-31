/**
 * High-resolution, player-facing idle animation derived from the approved
 * `idle-loop` track. Runtime atlases optimize for compact gameplay cells; this
 * horizontal strip keeps the authored source frames at menu presentation size.
 */

import { readFile } from 'fs/promises';
import { basename } from 'path';
import sharp from 'sharp';
import { ServerError } from '../../lib/errorHandler.js';
import { keyChannelSplit } from './chromaKey.js';
import { isAnimationTrack } from './animationTracks.js';
import { getEffectiveAnimationTracks } from './animationTrackStore.js';
import { getTrackState } from './animationTrackWorkflow.js';
import { resolveSpriteAssetPath } from './paths.js';
import { loadManifest } from './reference.js';
import { getRecord } from './records.js';
import { resolveChromaKey } from './walk.js';
import { verifyPackagedFrames } from './walkFrames.js';
import { decodeTransparentSpriteSource, sha256Buffer } from './walkPostprocess.js';

export const PRESENTATION_IDLE_TRACK_ID = 'idle-loop';
export const PRESENTATION_IDLE_CELL_SIZE = 512;
export const PRESENTATION_IDLE_LAYOUT_KIND = 'portos-presentation-animation-layout';

export const presentationIdleSidecarPath = (destPath) =>
  destPath.replace(/\.png$/i, '.presentation.json');

export function buildPresentationIdleLayout(presentationIdle, destPath) {
  return {
    schemaVersion: 1,
    kind: PRESENTATION_IDLE_LAYOUT_KIND,
    track: PRESENTATION_IDLE_TRACK_ID,
    imageFile: basename(destPath),
    imageSha256: presentationIdle.sha256,
    frameCount: presentationIdle.frameCount,
    frameRate: presentationIdle.frameRate,
    cellSize: presentationIdle.cellSize,
    sourceManifestPath: presentationIdle.sourceManifestPath,
    sourceManifestSha256: presentationIdle.sourceManifestSha256,
    sourceFrameSha256s: presentationIdle.sourceFrameSha256s,
  };
}

const idleError = (message, code) =>
  new ServerError(message, { status: 422, code });

export async function composePresentationIdleStrip(frameBytes, chromaKey) {
  if (!Array.isArray(frameBytes) || frameBytes.length === 0) {
    throw idleError('The approved idle loop has no presentation frames', 'PRESENTATION_IDLE_FRAMES_REQUIRED');
  }

  const split = keyChannelSplit(chromaKey);
  const tiles = [];
  for (let index = 0; index < frameBytes.length; index++) {
    // frame order is the animation order
    const frame = await decodeTransparentSpriteSource(frameBytes[index], split, chromaKey);
    // each normalized tile feeds the ordered strip
    const input = await sharp(frame.data, {
      raw: { width: frame.width, height: frame.height, channels: 4 },
    })
      .resize(PRESENTATION_IDLE_CELL_SIZE, PRESENTATION_IDLE_CELL_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        kernel: sharp.kernel.nearest,
      })
      .png()
      .toBuffer();
    tiles.push({ input, left: index * PRESENTATION_IDLE_CELL_SIZE, top: 0 });
  }

  return sharp({
    create: {
      width: PRESENTATION_IDLE_CELL_SIZE * tiles.length,
      height: PRESENTATION_IDLE_CELL_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(tiles)
    .png()
    .toBuffer();
}

export async function buildPresentationIdle(recordId) {
  // `idle-loop` is a user-authored track, not a shipped one (#3152 moved every
  // non-walk row into the editable registry). On an install that never created
  // it, `getTrackState` resolves the id through the registry, which THROWS a
  // bare "Unknown animation track" Error — a 500 naming internals, on the same
  // publish the UI offers unconditionally. Answer it as the missing prerequisite
  // it is, alongside the not-yet-approved case below.
  if (!isAnimationTrack(PRESENTATION_IDLE_TRACK_ID, getEffectiveAnimationTracks())) {
    throw idleError(
      `Create an animation track named '${PRESENTATION_IDLE_TRACK_ID}' and approve it before publishing a picker animation`,
      'PRESENTATION_IDLE_TRACK_REQUIRED',
    );
  }
  const [record, referenceManifest, state] = await Promise.all([
    getRecord(recordId),
    loadManifest(recordId),
    getTrackState(PRESENTATION_IDLE_TRACK_ID, recordId),
  ]);
  const set = state?.set;
  const directionEntries = Object.entries(set?.directions || {});
  if (set?.status !== 'final'
    || set?.track !== PRESENTATION_IDLE_TRACK_ID
    || directionEntries.length !== 1) {
    throw idleError(
      'Approve the complete idle-loop track before publishing a picker animation',
      'PRESENTATION_IDLE_TRACK_REQUIRED',
    );
  }

  const [direction, approved] = directionEntries[0];
  if (approved?.status !== 'approved' || !approved.runManifest || !approved.runManifestSha256) {
    throw idleError(
      'The finalized idle-loop track has no approved source manifest',
      'PRESENTATION_IDLE_TRACK_INVALID',
    );
  }

  const manifestBytes = await readFile(
    resolveSpriteAssetPath(recordId, approved.runManifest),
  ).catch(() => null);
  if (!manifestBytes || sha256Buffer(manifestBytes) !== approved.runManifestSha256) {
    throw idleError(
      'The approved idle-loop manifest is missing or no longer matches its recorded hash',
      'PRESENTATION_IDLE_TRACK_INVALID',
    );
  }

  const runManifest = JSON.parse(manifestBytes);
  if (runManifest.track !== PRESENTATION_IDLE_TRACK_ID
    || runManifest.direction !== direction) {
    throw idleError(
      'The approved idle-loop manifest is mislabeled',
      'PRESENTATION_IDLE_TRACK_INVALID',
    );
  }
  const { frameBytes } = await verifyPackagedFrames(recordId, runManifest, {
    bytes: true,
    track: PRESENTATION_IDLE_TRACK_ID,
  });
  const chromaKey = resolveChromaKey({ manifest: referenceManifest, record });
  const buffer = await composePresentationIdleStrip(frameBytes, chromaKey);

  return {
    buffer,
    sha256: sha256Buffer(buffer),
    sourceManifestPath: approved.runManifest,
    sourceManifestSha256: approved.runManifestSha256,
    sourceFrameSha256s: runManifest.frames.map((frame) => frame.sha256),
    frameCount: frameBytes.length,
    frameRate: runManifest.frameRate,
    cellSize: PRESENTATION_IDLE_CELL_SIZE,
  };
}
