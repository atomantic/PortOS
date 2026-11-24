/** The per-run findings cap nearly every editorial check declares: its config schema and its matching settings field. */

import { z } from 'zod';

const MIN = 1;
const MAX = 50;

export const findingCapSchema = (fallback) => z.number().int().min(MIN).max(MAX).default(fallback);

/** `what` names the thing that would otherwise flood the review. */
export const findingCapField = (what = 'a long manuscript') => ({
  key: 'maxFindings',
  label: 'Max findings per run',
  type: 'number',
  min: MIN,
  max: MAX,
  step: 1,
  help: `Cap findings so ${what} can not flood the review.`,
});
