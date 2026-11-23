// Completion contract for downloaded voice model assets (Whisper `.bin`, Piper `.onnx` +
// `.onnx.json`).
//
// `inspectVoiceAsset(kind, path)` is the read-only readiness check (`verified` / `unverified` /
// `incomplete` / `missing` — stat plus one small JSON read, no hashing or network);
// `verifyVoiceAssetHashes` and `writeVoiceAssetReceipt` are the script-side halves that re-hash and
// record the `.portos-complete.json` receipt after promotion. `isManagedVoiceAsset` separates
// setup-script-owned files from user-supplied ones. Shared by `voice/bootstrap.js`, `voice/health.js`
// and `scripts/voice-asset.js`.
//
// Completion contract for downloaded voice model assets (Whisper .bin, Piper
// .onnx + .onnx.json pair). The setup scripts download into temp siblings,
// promote the verified files, and only then write a receipt next to the primary
// asset. A bare file's existence is NOT evidence the download finished — a
// dropped transfer leaves a partial file at the final path.
//
// Readiness states (the server reads these without any network or hashing):
//   verified   receipt present and every listed file still has its recorded size
//   unverified no receipt (installed before receipts, or a user-supplied file)
//              but structurally usable: non-empty, and a Piper pair has a
//              parseable sidecar. Stays usable; the next user-authorized setup
//              run adopts it by writing a receipt
//   incomplete present but not usable: empty, sidecar missing/invalid, or a
//              receipt that no longer matches the files on disk
//   missing    the primary file is absent
//
// The scripts (setup-voice.sh / .ps1, via scripts/voice-asset.js) additionally
// re-verify sha256 so a same-size replacement cannot keep a valid receipt.

import { createHash } from 'crypto';
import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

export const VOICE_ASSET_RECEIPT_VERSION = 1;
export const VOICE_ASSET_KINDS = Object.freeze(['whisper', 'piper']);

export const voiceAssetReceiptPath = (primaryPath) => `${primaryPath}.portos-complete.json`;
const piperSidecarPath = (onnxPath) => `${onnxPath}.json`;

// Piper refuses a config without audio.sample_rate, so that is the minimum
// evidence the sidecar is a real config rather than an error page or a stub.
export const isValidPiperConfig = (text) => {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return false; }
  return Number.isFinite(parsed?.audio?.sample_rate);
};

const fileSize = (path) => {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
};

const readText = (path) => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

const expectedFiles = (kind, primaryPath) => (kind === 'piper'
  ? [primaryPath, piperSidecarPath(primaryPath)]
  : [primaryPath]);

const readReceipt = (primaryPath) => {
  const text = readText(voiceAssetReceiptPath(primaryPath));
  if (text === null) return { present: false };
  try {
    const parsed = JSON.parse(text);
    const valid = parsed?.version === VOICE_ASSET_RECEIPT_VERSION && Array.isArray(parsed.files);
    return { present: true, receipt: valid ? parsed : null };
  } catch {
    return { present: true, receipt: null };
  }
};

/**
 * Cheap, read-only readiness check — stat + one small JSON read, no hashing, no
 * network. Safe to call from boot and from every status poll.
 */
// Receipt-independent half: are the files themselves usable? Returns null when
// they are, else the missing/incomplete verdict.
const structuralProblem = (kind, primaryPath) => {
  if (!VOICE_ASSET_KINDS.includes(kind)) throw new Error(`unknown voice asset kind: ${kind}`);
  if (!primaryPath || !existsSync(primaryPath)) return { state: 'missing', reason: 'primary file absent' };
  const files = expectedFiles(kind, primaryPath);
  const sizes = files.map(fileSize);
  if (!(sizes[0] > 0)) return { state: 'incomplete', reason: 'primary file empty' };
  if (kind === 'piper') {
    if (sizes[1] === null) return { state: 'incomplete', reason: 'sidecar config missing' };
    if (!isValidPiperConfig(readText(files[1]) ?? '')) return { state: 'incomplete', reason: 'sidecar config invalid' };
  }
  return null;
};

export const inspectVoiceAsset = (kind, primaryPath) => {
  const problem = structuralProblem(kind, primaryPath);
  if (problem) return problem;
  const files = expectedFiles(kind, primaryPath);
  const sizes = files.map(fileSize);

  const { present, receipt } = readReceipt(primaryPath);
  if (!present) return { state: 'unverified', reason: 'no completion receipt' };
  if (!receipt) return { state: 'incomplete', reason: 'completion receipt unreadable' };
  for (let i = 0; i < files.length; i += 1) {
    const entry = receipt.files.find((f) => f?.name === basename(files[i]));
    if (!entry || entry.size !== sizes[i]) return { state: 'incomplete', reason: `${basename(files[i])} does not match its receipt` };
  }
  return { state: 'verified', reason: '' };
};

/** True when the state is usable for synthesis / transcription. */
export const isVoiceAssetUsable = (state) => state === 'verified' || state === 'unverified';

/**
 * Whether `path` sits directly in the setup script's managed directory. Only
 * those files carry receipts or get replaced; a model at any other path is the
 * user's and is validated but never touched.
 */
export const isManagedVoiceAsset = (path, managedDir) => !!path && !!managedDir
  && resolve(dirname(path)) === resolve(managedDir);

const sha256File = (path) => new Promise((resolveHash, reject) => {
  const hash = createHash('sha256');
  createReadStream(path)
    .on('error', reject)
    .on('data', (chunk) => hash.update(chunk))
    .on('end', () => resolveHash(hash.digest('hex')));
});

/**
 * Full verification used by the setup scripts: everything inspectVoiceAsset
 * checks plus the recorded sha256 of every file. Streams, so a multi-GB Whisper
 * model never has to fit in memory.
 */
export const verifyVoiceAssetHashes = async (kind, primaryPath) => {
  const base = inspectVoiceAsset(kind, primaryPath);
  if (base.state !== 'verified') return base;
  const { receipt } = readReceipt(primaryPath);
  for (const file of expectedFiles(kind, primaryPath)) {
    const entry = receipt.files.find((f) => f?.name === basename(file));
    if (!entry || (await sha256File(file)) !== entry.sha256) {
      return { state: 'incomplete', reason: `${basename(file)} content hash differs from its receipt` };
    }
  }
  return base;
};

/**
 * Record completion for an already-promoted asset. Refuses to write a receipt
 * for an unusable asset, and writes through a temp file so a crash cannot leave
 * a truncated receipt that reads as "corrupt" forever.
 */
export const writeVoiceAssetReceipt = async (kind, primaryPath) => {
  // Structure only: a stale receipt from the previous install must not block
  // recording the replacement that was just promoted over it.
  const problem = structuralProblem(kind, primaryPath);
  if (problem) throw new Error(`cannot record completion for ${basename(primaryPath || '')}: ${problem.reason}`);
  const files = [];
  for (const file of expectedFiles(kind, primaryPath)) {
    files.push({ name: basename(file), size: fileSize(file), sha256: await sha256File(file) });
  }
  const receiptPath = voiceAssetReceiptPath(primaryPath);
  const tmpPath = join(dirname(receiptPath), `.${basename(receiptPath)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify({ version: VOICE_ASSET_RECEIPT_VERSION, kind, files }, null, 2));
    renameSync(tmpPath, receiptPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* temp already gone */ }
    throw err;
  }
  return receiptPath;
};

// Pinned sha256 of every Piper release archive the setup scripts may download
// (rhasspy/piper@2023.11.14-2 and rhasspy/piper-phonemize@2023.11.14-4). The archives hold
// native binaries and shared libraries run on every Piper synthesis, so a re-pointed tag or
// replaced release asset must fail closed before extraction. Bump a digest only together with
// the version pin in scripts/setup-voice.sh / setup-voice.ps1.
export const PIPER_RELEASE_ARCHIVE_SHA256 = Object.freeze({
  'piper_linux_aarch64.tar.gz': 'fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb',
  'piper_linux_armv7l.tar.gz': 'c6946fcd57c705ed1d4666ea880f80ba0bbbd14de62ecbdd13460baf3bac8e37',
  'piper_linux_x86_64.tar.gz': 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992',
  'piper_macos_aarch64.tar.gz': '6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc',
  'piper_macos_x64.tar.gz': 'ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b',
  'piper_windows_amd64.zip': 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea',
  'piper-phonemize_linux_aarch64.tar.gz': 'f216660f6225a165155839110cd387947d69618f014f3d1c56729fdedb6557cc',
  'piper-phonemize_linux_x86_64.tar.gz': '3fb3d58b4ac42bd69d38948acdbeab335eee7e599984169d28fb0082496649ad',
  'piper-phonemize_macos_aarch64.tar.gz': '78a9c28b3c94baf6e9526b2e386ce547909abaec4f31aadd7e16b01fbfe5f322',
  'piper-phonemize_macos_x64.tar.gz': '9ec6e300c0d012a663758bc45a097b47ee759761a3b91c7742de042af789d84b',
});

/**
 * Throws unless `filePath` hashes to the pinned digest for `archiveName`. Unknown names are
 * rejected too, so a platform without a pinned archive cannot slip through unverified.
 * `table` exists for tests; production callers use the frozen default.
 */
export const verifyVoiceArchiveSha256 = async (archiveName, filePath, table = PIPER_RELEASE_ARCHIVE_SHA256) => {
  const expected = Object.hasOwn(table, archiveName) ? table[archiveName] : undefined;
  if (!expected) throw new Error(`no pinned sha256 for archive ${archiveName}`);
  const actual = await sha256File(filePath);
  if (actual !== expected) throw new Error(`sha256 mismatch for ${archiveName}: expected ${expected}, got ${actual}`);
};
