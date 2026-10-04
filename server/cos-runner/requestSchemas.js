/**
 * Request-body schemas for the CoS runner's HTTP API (#10024).
 *
 * The runner is a separate PM2 process with its own Express app, so it cannot
 * use `validateRequest` (which throws through the main server's error
 * middleware). Its handlers call `schema.safeParse(req.body)` and answer a
 * failure with the same `{ error }` 400 shape the hand-written field checks
 * already used, via `bodyErrorMessage`.
 *
 * The schemas pin TYPES only. Presence checks stay in the handlers because
 * their messages name the missing field (a single opaque "invalid body" once
 * sent a grok-tui agent to the zombie reaper with no clue why), and
 * `JSON.stringify` on the server side drops `undefined`, so every field is
 * absent-or-typed; `null` is tolerated where a caller legitimately sends it.
 */

import { z } from 'zod';

const optionalString = z.string().nullish();
// Free-form maps composed server-side (provider env, auth descriptor); the
// downstream env builder owns their contents, the schema only rejects a
// wrong-typed top level (array, string).
const looseRecord = z.record(z.string(), z.unknown()).nullish();

export const spawnTuiBodySchema = z.object({
  agentId: optionalString,
  maintenanceParentId: z.string().uuid().nullish(),
  taskId: optionalString,
  sessionId: optionalString,
  command: optionalString,
  args: z.array(z.string()).optional(),
  workspacePath: optionalString,
  envVars: looseRecord,
  providerAuth: looseRecord,
  cols: z.number().int().min(1).optional(),
  rows: z.number().int().min(1).optional(),
  doneSentinelPath: optionalString,
});

export const spawnBodySchema = z.object({
  agentId: optionalString,
  maintenanceParentId: z.string().uuid().nullish(),
  taskId: optionalString,
  prompt: optionalString,
  workspacePath: optionalString,
  model: optionalString,
  envVars: looseRecord,
  providerAuth: looseRecord,
  cliCommand: optionalString,
  cliArgs: z.union([z.array(z.string()), z.string()]).nullish(),
  claudePath: optionalString,
});

export const pauseBodySchema = z.object({ reason: optionalString });

export const btwBodySchema = z.object({ message: z.string().min(1, 'message is required') });

/** One-line 400 message naming every offending field. */
export function bodyErrorMessage(error) {
  const detail = error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
  return `Invalid request body: ${detail}`;
}
