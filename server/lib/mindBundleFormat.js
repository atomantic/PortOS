/**
 * Mind bundle FORMAT vocabulary — the names, versions, scopes, groups, and
 * refusal reasons that describe a portable Mind bundle (#7621, #7622; epic
 * #7620).
 *
 * Deliberately separate from `mindBundleCrypto.js`, which seals and opens one:
 * that module imports node's `crypto`, and the browser needs these same names
 * to render the export scope list, the import group table, and the passphrase
 * rule. Splitting the vocabulary out is what lets the client import ONE
 * definition (`client/src/lib/mindBundle.js`) instead of mirroring constants
 * that would then drift on the first version bump.
 *
 * Nothing here performs I/O or touches a key.
 */

export const MIND_BUNDLE_MAGIC = 'portos-mind-bundle';
export const MIND_BUNDLE_CONTAINER_VERSION = 1;
export const MIND_BUNDLE_PAYLOAD_VERSION = 1;
export const MIND_BUNDLE_FILE_EXTENSION = '.portos-mind';

/**
 * Key length in bytes. Declared here rather than beside the cipher because the
 * KDF parameters below travel inside the cleartext header, and a reader has to
 * be able to check them against what this build will run.
 */
const KEY_BYTES = 32;

/**
 * scrypt cost, recorded in the cleartext header so a bundle sealed by a future
 * install that raises them still opens here (the parameters travel with the
 * file) while a bundle declaring absurd ones is refused rather than executed.
 */
export const MIND_BUNDLE_KDF = Object.freeze({ name: 'scrypt', N: 32_768, r: 8, p: 1, keyBytes: KEY_BYTES });

/**
 * The scope vocabulary is part of the container contract — it is declared in the
 * cleartext header, so a destination can refuse a scope it cannot apply. Memory
 * export is opt-in (epic #7620): protected memories quote private conversation.
 */
export const PERSISTENT_MIND_BUNDLE_SCOPES = Object.freeze(['profile', 'avatar', 'memories']);
export const DEFAULT_PERSISTENT_MIND_BUNDLE_SCOPES = Object.freeze(['profile', 'avatar']);

/**
 * The units an IMPORT applies, and the scope each one arrives in (#7622).
 *
 * A scope is what the exporter seals; a group is what the destination user
 * chooses about. They are not one-to-one: the `profile` scope carries four
 * independently-authored things, and offering them as one all-or-nothing
 * switch would force a user who wants the incoming name to also take the
 * incoming model policy. `playbook` is separate from `personality` for the
 * same reason — a playbook is a product-supported loop with its own
 * vocabulary, not free prose.
 *
 * The vocabulary lives beside the container contract because the cleartext
 * header declares scopes: a reader must be able to say which groups a bundle
 * could possibly offer before it decrypts anything.
 */
export const MIND_BUNDLE_GROUP_SCOPES = Object.freeze({
  identity: 'profile',
  personality: 'profile',
  playbook: 'profile',
  modelPolicy: 'profile',
  avatar: 'avatar',
  memories: 'memories',
});

/** Stable presentation order — the preview and the apply summary share it. */
export const PERSISTENT_MIND_BUNDLE_GROUPS = Object.freeze(Object.keys(MIND_BUNDLE_GROUP_SCOPES));

/**
 * Whole-group choices, never a merge (#7622). `memories` reads these as
 * "skip them" / "import them": that group is additive, appending and never
 * replacing, so there is no "mine" that losing the choice would destroy.
 */
export const MIND_BUNDLE_GROUP_CHOICES = Object.freeze(['keep-mine', 'use-imported']);

/**
 * A bundle is a file from somewhere else. Cap what this install will even
 * attempt to parse, far under the JSON body limit, so an oversized or hostile
 * file is refused by length rather than by running scrypt over it.
 */
export const MIND_BUNDLE_MAX_CHARS = 8 * 1024 * 1024;

/**
 * Refusal reasons are NAMED, because "forward-compatible by refusal" only
 * helps if the destination can tell the user WHICH refusal it hit. The code
 * travels to the client; the message explains it in the user's terms.
 *
 * `AUTH_FAILED` deliberately covers both a wrong passphrase and a modified
 * file: GCM cannot distinguish them, and guessing which one it was would tell
 * a holder of the file whether their passphrase guess was close.
 */
export const MIND_BUNDLE_REFUSALS = Object.freeze({
  NOT_A_BUNDLE: 'bundle_not_a_bundle',
  VERSION_UNSUPPORTED: 'bundle_version_unsupported',
  DAMAGED: 'bundle_damaged',
  UNKNOWN_SCOPE: 'bundle_unknown_scope',
  CIPHER_UNSUPPORTED: 'bundle_cipher_unsupported',
  KDF_UNSUPPORTED: 'bundle_kdf_unsupported',
  AUTH_FAILED: 'bundle_auth_failed',
  INTEGRITY_FAILED: 'bundle_integrity_failed',
  PAYLOAD_UNSUPPORTED: 'bundle_payload_unsupported',
  PASSPHRASE_INVALID: 'bundle_passphrase_invalid',
  TOO_LARGE: 'bundle_too_large',
});

/** Tag a refusal with its named reason so callers branch on the code, not the prose. */
export function mindBundleRefusal(reason, message) {
  return Object.assign(new Error(message), { mindBundleReason: reason });
}

/**
 * A short passphrase makes the scrypt work factor irrelevant. 12 characters is
 * the floor; the UI says so before the field is ever filled in.
 */
export const MIND_BUNDLE_PASSPHRASE_MIN_CHARS = 12;
export const MIND_BUNDLE_PASSPHRASE_MAX_CHARS = 512;
