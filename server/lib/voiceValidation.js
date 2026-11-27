/**
 * Zod schemas for voice provider, download, and avatar routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { nonEmptyString } from './sharedSchemas.js';

export const voicePiperFetchBodySchema = z.object({ voice: nonEmptyString });

export const voiceAvatarCommandSchema = z.object({
  action: z.enum(['install', 'update', 'cancel', 'start', 'stop', 'uninstall']),
  acceptTerms: z.literal(true).optional(),
}).strict();

export const avatarAudioLimit = 2 * 1024 * 1024;
export const voiceAvatarWaveSchema = z.custom(wav => Buffer.isBuffer(wav) && wav.length >= 44 &&
  wav.length <= avatarAudioLimit && wav.toString('ascii', 0, 4) === 'RIFF' &&
  wav.toString('ascii', 8, 12) === 'WAVE', 'Expected PCM WAV audio.');
