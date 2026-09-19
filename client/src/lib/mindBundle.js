// Mind bundle format vocabulary, re-exported from the single server-side
// definition (client/src/lib/README.md "One pure module, one definition").
//
// The client cannot import `server/lib/mindBundleCrypto.js` — that module pulls
// node's `crypto` — so the format names live in a sibling leaf with no node
// imports and both sides read THAT. A mirrored copy here would drift the first
// time the container version or the passphrase floor moves.
export {
  MIND_BUNDLE_FILE_EXTENSION,
  MIND_BUNDLE_GROUP_CHOICES,
  MIND_BUNDLE_GROUP_SCOPES,
  MIND_BUNDLE_MAX_CHARS,
  MIND_BUNDLE_PASSPHRASE_MIN_CHARS,
  PERSISTENT_MIND_BUNDLE_GROUPS,
  PERSISTENT_MIND_BUNDLE_SCOPES,
} from '../../../server/lib/mindBundleFormat.js';
