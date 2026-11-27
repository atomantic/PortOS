// Zod request schemas for the character routes.

import { z } from 'zod';
import { diceNotationSchema } from './diceNotation.js';

// Zod schemas for request validation
export const updateCharacterSchema = z.object({
  // Empty is allowed (not `.min(1)`): '' is the "unset" state the human-centered page renders
  // as the "Your name" / "Add a title" placeholder (#2677), so the user must be able to clear
  // a name/title back to blank, not just replace it.
  name: z.string().max(100).optional(),
  class: z.string().max(100).optional(),
  avatarPath: z.string().max(500).regex(/^\/data\/images\/[A-Za-z0-9._-]+$/, 'Invalid avatar path').optional()
});

export const addXPSchema = z.object({
  amount: z.number().int().min(1),
  source: z.string().min(1).max(200),
  description: z.string().max(500).optional()
});

export const takeDamageSchema = z.object({
  diceNotation: diceNotationSchema,
  description: z.string().max(500).optional()
});

export const takeRestSchema = z.object({
  type: z.enum(['short', 'long'])
});

export const addEventSchema = z.object({
  description: z.string().min(1).max(500),
  xp: z.number().int().min(0).optional(),
  diceNotation: diceNotationSchema.optional()
});

// `?skills=0` / `?metrics=0` opt out of each derived registry's domain fan-out, for consumers
// that only read the persisted fields plus the age level — notably the OpenWorld HUD, which
// polls this route every 15s and renders only `level`. Both default to ON, so an unaware
// caller still gets the full sheet.
//
// `metrics` defaults to whatever `skills` says rather than to ON. `?skills=0` predates the
// metrics grid (#2676) and has only ever meant one thing — "give me the cheap sheet, skip the
// domain fan-out" — so a caller that predates the flag (a browser holding a stale bundle
// across an update, or any external script) must not silently start paying a NEW fan-out it
// has no way to ask about. An explicit `?metrics=` always wins, so the two stay independently
// gateable: `?skills=0&metrics=1` gets the grid without the skill curve.
const flagEnum = z.enum(['0', '1', 'false', 'true']).optional();

export const getCharacterQuerySchema = z.object({
  skills: flagEnum,
  metrics: flagEnum,
});
