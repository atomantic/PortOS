/**
 * Zod schemas for the Autonomous Job notepad routes (#17392); the caps live in `autonomousJobNotepadLimits.js`.
 */

import { z } from 'zod';
import { MAX_KEY_CHARS, MAX_VALUE_BYTES, NOTE_KEY_PATTERN } from './autonomousJobNotepadLimits.js';
import { byteLength } from './autonomousJobNotepad.js';

export const noteKeySchema = z.string()
  .min(1, 'key is required')
  .max(MAX_KEY_CHARS, `key must be at most ${MAX_KEY_CHARS} characters`)
  .regex(NOTE_KEY_PATTERN, 'key may contain only letters, digits and . _ : -');

export const noteValueSchema = z.string()
  .refine((value) => byteLength(value) <= MAX_VALUE_BYTES, `value must be at most ${MAX_VALUE_BYTES} bytes (UTF-8)`);

export const putNoteBodySchema = z.object({ value: noteValueSchema }).strict();
