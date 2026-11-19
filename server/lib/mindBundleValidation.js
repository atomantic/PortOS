/**
 * Zod schemas for the mind bundle export, preview and apply routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import {
  PERSISTENT_MIND_BUNDLE_SCOPES, MIND_BUNDLE_PASSPHRASE_MIN_CHARS, MIND_BUNDLE_PASSPHRASE_MAX_CHARS,
  MIND_BUNDLE_MAX_CHARS, PERSISTENT_MIND_BUNDLE_GROUPS, MIND_BUNDLE_GROUP_CHOICES
} from './mindBundleFormat.js';

/**
 * `POST /api/cos/mind/bundle/export` (#7621) — seal the Mind into a downloadable,
 * passphrase-encrypted bundle.
 *
 * The scope vocabulary and passphrase floor come from `mindBundleCrypto.js`, the
 * module that owns the container contract, so the route, the sealer, and the UI
 * cannot drift apart on what a bundle may declare. The passphrase is bounded but
 * deliberately unconstrained in composition: it is a user-chosen secret, and a
 * validation failure here must never echo it (`validateRequest` reports paths
 * and messages, never values).
 */
export const mindBundleExportSchema = z.object({
  scopes: z.array(z.enum(PERSISTENT_MIND_BUNDLE_SCOPES))
    .min(1)
    .max(PERSISTENT_MIND_BUNDLE_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, 'bundle scopes must be unique'),
  passphrase: z.string()
    .min(MIND_BUNDLE_PASSPHRASE_MIN_CHARS, `Passphrase must be at least ${MIND_BUNDLE_PASSPHRASE_MIN_CHARS} characters`)
    .max(MIND_BUNDLE_PASSPHRASE_MAX_CHARS),
}).strict();

const mindBundlePassphrase = z.string()
  .min(MIND_BUNDLE_PASSPHRASE_MIN_CHARS, `Passphrase must be at least ${MIND_BUNDLE_PASSPHRASE_MIN_CHARS} characters`)
  .max(MIND_BUNDLE_PASSPHRASE_MAX_CHARS);

// The uploaded file, as text. Bounded here as well as in the container reader
// so an oversized upload is refused before a key derivation runs over it.
const mindBundleText = z.string().min(1).max(MIND_BUNDLE_MAX_CHARS);

/** Open a bundle and report what it carries. Read-only — no choices, no writes (#7622). */
export const mindBundlePreviewSchema = z.object({
  bundle: mindBundleText,
  passphrase: mindBundlePassphrase,
}).strict();

/**
 * Apply a bundle under one whole-group choice per group. A group the caller
 * omits keeps this install's value, so a partial payload can never overwrite a
 * personality by accident; `.strict()` on the choice map means a group name
 * this build does not know is a 400, not a silently ignored key.
 */
export const mindBundleApplySchema = z.object({
  bundle: mindBundleText,
  passphrase: mindBundlePassphrase,
  choices: z.object(Object.fromEntries(
    PERSISTENT_MIND_BUNDLE_GROUPS.map((group) => [group, z.enum(MIND_BUNDLE_GROUP_CHOICES).optional()]),
  )).strict(),
}).strict();
