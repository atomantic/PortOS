/**
 * Dice notation (`NdM` with an optional `+K`/`-K` modifier) shared by the
 * character routes and `rollDice`. The count and sides are bounded because
 * `rollDice` materialises one array entry per die: an unbounded `NdM` lets one
 * request exhaust memory and block the event loop (#13088).
 */
import { z } from 'zod';
import { ServerError } from './errorHandler.js';

export const DICE_MAX_COUNT = 100;
export const DICE_MIN_SIDES = 2;
export const DICE_MAX_SIDES = 1000;

const DICE_PATTERN = /^(\d+)d(\d+)([+-]\d+)?$/;

// Returns `{ count, sides, modifier }` for an in-bounds notation, else `null`.
function parseDiceNotation(notation) {
  const match = DICE_PATTERN.exec(notation);
  if (!match) return null;
  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);
  if (count < 1 || count > DICE_MAX_COUNT) return null;
  if (sides < DICE_MIN_SIDES || sides > DICE_MAX_SIDES) return null;
  const modifier = match[3] ? parseInt(match[3], 10) : 0;
  return { count, sides, modifier };
}

export const diceNotationSchema = z.string().refine(
  (notation) => parseDiceNotation(notation) !== null,
  `Invalid dice notation (e.g. "1d8", "2d6+3"; 1-${DICE_MAX_COUNT} dice with ${DICE_MIN_SIDES}-${DICE_MAX_SIDES} sides)`
);

/** Parse or throw a 400 — used by `rollDice`, which non-route callers also reach. */
export function requireDiceNotation(notation) {
  const parsed = typeof notation === 'string' ? parseDiceNotation(notation) : null;
  if (!parsed) {
    throw new ServerError(
      `Invalid dice notation: ${notation} (1-${DICE_MAX_COUNT} dice with ${DICE_MIN_SIDES}-${DICE_MAX_SIDES} sides)`,
      { status: 400 }
    );
  }
  return parsed;
}
