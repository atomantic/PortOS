/**
 * Mind bundle format vocabulary, free of node builtins so the browser reads the same definitions
 * (`client/src/lib/mindBundle.js`)
 *
 * Magic/versions/extension, scrypt parameters, export scopes, import groups and their source scopes,
 * size/passphrase bounds, and the named refusal reasons. Separate from `mindBundleCrypto.js` (imports node
 * `crypto`) so the client never mirrors constants.
 */

export const MIND_BUNDLE_MAGIC = 'portos-mind-bundle';
export const MIND_BUNDLE_CONTAINER_VERSION = 1;
export const MIND_BUNDLE_PAYLOAD_VERSION = 1;
export const MIND_BUNDLE_FILE_EXTENSION = '.portos-mind';

// Declared here because the KDF parameters travel in the cleartext header and a reader must check them.
const KEY_BYTES = 32;

// Recorded in the cleartext header: a future install's raised costs still open here, absurd ones are refused.
export const MIND_BUNDLE_KDF = Object.freeze({ name: 'scrypt', N: 32_768, r: 8, p: 1, keyBytes: KEY_BYTES });

// Declared in the cleartext header so a destination can refuse a scope it cannot apply.
// Memory export is opt-in: protected memories quote private conversation.
export const PERSISTENT_MIND_BUNDLE_SCOPES = Object.freeze(['profile', 'avatar', 'memories']);
export const DEFAULT_PERSISTENT_MIND_BUNDLE_SCOPES = Object.freeze(['profile', 'avatar']);

/**
 * The units an IMPORT applies, each with its source scope. A scope is what the exporter seals; a group
 * is what the user chooses about (the `profile` scope holds four independently-authored things).
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

/** Whole-group choices, never a merge; for the additive `memories` group they mean skip / import. */
export const MIND_BUNDLE_GROUP_CHOICES = Object.freeze(['keep-mine', 'use-imported']);

// Untrusted file: refuse by length before running scrypt over it.
export const MIND_BUNDLE_MAX_CHARS = 8 * 1024 * 1024;

/**
 * Named refusal reasons so the destination can tell the user WHICH refusal it hit. `AUTH_FAILED`
 * covers both a wrong passphrase and a modified file: distinguishing them would reveal whether a
 * passphrase guess was close.
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

// A short passphrase makes the scrypt work factor irrelevant.
export const MIND_BUNDLE_PASSPHRASE_MIN_CHARS = 12;
export const MIND_BUNDLE_PASSPHRASE_MAX_CHARS = 512;
