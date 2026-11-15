/**
 * Duration-driven video model contracts shared by the registry loader and
 * migrations. Keep this module pure: importing mediaModels.js from a migration
 * seeds the live registry as a side effect.
 *
 * Pure pinned duration/frame contracts shared by model-registry upgrades and migrations. LTX-2.5 A2V
 * follows the full uploaded audio, rounds up to its 8n+1 temporal grid, and tops out at 1017 frames
 * under the API's single-pass boundary.
 */

export const LTX25_AUDIO_PROFILE = Object.freeze({
  id: 'ltx25_mlx_q8',
  repo: 'MrMofer/ltx-2.5-mlx-q8',
  revision: 'f1b56e7dc89f71a9af2cddac787b89ed22a8b7fc',
  audioDurationDriven: true,
  frameStride: 8,
  maxNumFrames: 1017,
});
