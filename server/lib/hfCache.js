// HuggingFace Hub cache inspection — detect whether a model repo has been
// downloaded into `~/.cache/huggingface/hub/` (or wherever HF_HOME points)
// so the image/video gen forms can show "Available" vs "Download" inline
// without waiting until first render to discover a multi-GB download.
//
// Cache layout (huggingface_hub >=0.14):
//   <root>/models--<owner>--<name>/
//     refs/main           -> commit sha
//     snapshots/<sha>/     -> symlinks to ../../blobs/<hash>
//     blobs/<hash>         -> actual file bytes
//
// "Cached" here means: at least one snapshot directory exists AND every
// non-metadata file (safetensors, ckpt, bin, pt, msgpack) in that snapshot
// resolves to an existing blob with non-zero size. A partial download
// (interrupted mid-snapshot) leaves dangling symlinks — we treat that as
// not cached so the user gets the Download button instead of a confusing
// "Available" badge followed by a runtime failure.
//
// All filesystem work is async (`fs.promises`) so the `/models/status`
// route — which inspects every registered model — doesn't block the Node
// event loop while walking large snapshot directories.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import {
  join, dirname, resolve as resolvePath, relative, sep, posix, win32,
} from 'node:path';
import { sha256File } from './fileUtils.js';

// HF cache root resolution mirrors huggingface_hub's own precedence:
// HF_HUB_CACHE > HF_HOME/hub > $XDG_CACHE_HOME/huggingface/hub
// > ~/.cache/huggingface/hub. Skipping the XDG branch (the python lib does
// honor it) would silently report a freshly-downloaded model as not cached
// on Linux installs that set XDG_CACHE_HOME to a non-default location.
export const getHfCacheRoot = () => {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  if (process.env.HF_HOME) return join(process.env.HF_HOME, 'hub');
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, 'huggingface', 'hub');
  return join(homedir(), '.cache', 'huggingface', 'hub');
};

// HF's on-disk naming: `org/name` -> `models--org--name`. Forward slashes
// inside the name (rare) are also `--` separated. Strip trailing slash so
// a registry-edit user pasting `org/name/` doesn't miss a real cache hit.
const repoToDirName = (repoId) => `models--${repoId.replace(/\/$/, '').replace(/\//g, '--')}`;

const WEIGHT_EXTENSIONS = ['.safetensors', '.ckpt', '.bin', '.pt', '.msgpack', '.gguf'];
const isWeightFile = (name) => WEIGHT_EXTENSIONS.some((ext) => name.endsWith(ext));

// Walk a snapshot directory recursively. HF stores nested layouts (e.g.
// `text_encoder/model.safetensors`) so a flat readdir would miss real
// weight files and falsely report a model as not cached.
async function collectWeightFiles(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectWeightFiles(path, out);
    } else if (isWeightFile(entry.name)) {
      out.push({ name: entry.name, path });
    }
  }
}

// Returns the path of the most recently modified snapshot under a repo, or
// null if no snapshots exist. HF writes snapshots/<sha>/ on every revision
// pull; the latest mtime is the most recently downloaded.
const HF_COMMIT_RE = /^[0-9a-f]{40}$/i;

async function latestSnapshotDir(repoDir, revision = null) {
  const snapshotsRoot = join(repoDir, 'snapshots');
  // PortOS-shipped model revisions are immutable HF commit hashes. Resolve an
  // exact snapshot when one is supplied instead of accepting a newer/mutable
  // `main` snapshot that happens to have the latest mtime.
  if (revision != null) {
    if (typeof revision !== 'string' || !HF_COMMIT_RE.test(revision)) return null;
    const exact = join(snapshotsRoot, revision.toLowerCase());
    const stat = await fs.stat(exact).catch(() => null);
    return stat?.isDirectory() ? exact : null;
  }
  let entries;
  try {
    entries = await fs.readdir(snapshotsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let latest = null;
  let latestMs = -1;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return;
    const p = join(snapshotsRoot, entry.name);
    const s = await fs.stat(p).catch(() => null);
    if (!s) return;
    if (s.mtimeMs > latestMs) {
      latestMs = s.mtimeMs;
      latest = p;
    }
  }));
  return latest;
}

// Returns `{ cached, sizeBytes, snapshotPath }`. `cached` is true only when
// the snapshot directory contains at least one weight file AND every weight
// file in the snapshot resolves to a non-zero blob. `sizeBytes` is the sum
// of resolved weight-blob sizes (config/tokenizer files are tiny and ignored
// so the displayed footprint reflects the user-meaningful download).
export async function inspectModelCache(repoId, { revision = null } = {}) {
  if (!repoId || typeof repoId !== 'string') {
    return { cached: false, sizeBytes: 0, snapshotPath: null };
  }
  const root = getHfCacheRoot();
  const repoDir = join(root, repoToDirName(repoId));
  const snapshotPath = await latestSnapshotDir(repoDir, revision);
  if (!snapshotPath) {
    return { cached: false, sizeBytes: 0, snapshotPath: null };
  }
  const weights = [];
  await collectWeightFiles(snapshotPath, weights);
  if (weights.length === 0) {
    return { cached: false, sizeBytes: 0, snapshotPath };
  }
  // Each snapshot file is a symlink into ../../blobs/<hash>; a stat that
  // follows the link surfaces dangling-symlink failures (interrupted
  // download) as a throw. One stat per file covers both broken-link
  // detection and size accounting. Parallelize across weights — large FLUX
  // / HiDream snapshots have hundreds of shards and sequential stats add up.
  const stats = await Promise.all(weights.map((f) => fs.stat(f.path).catch(() => null)));
  let sizeBytes = 0;
  for (const s of stats) {
    if (!s || s.size === 0) {
      return { cached: false, sizeBytes: 0, snapshotPath };
    }
    sizeBytes += s.size;
  }
  return { cached: true, sizeBytes, snapshotPath };
}

export const isModelCached = async (repoId) => (await inspectModelCache(repoId)).cached;

// Return the exact cached snapshot directory for an immutable revision. The
// Wan runner consumes this local path instead of a mutable `org/repo` handle,
// which also guarantees its cache-only subprocess cannot select another
// snapshot or trigger a hidden network fetch.
export async function findCachedRepoSnapshot(repoId, revision) {
  if (!repoId || typeof repoId !== 'string') return null;
  if (!revision || typeof revision !== 'string') return null;
  return latestSnapshotDir(join(getHfCacheRoot(), repoToDirName(repoId)), revision);
}

const isPathInside = (root, candidate) => {
  const rel = relative(resolvePath(root), resolvePath(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`)
    && !posix.isAbsolute(rel) && !win32.isAbsolute(rel);
};

// HF filenames are repo-relative POSIX paths. Reject every alternate path
// shape before touching disk: absolute paths, Windows separators, empty/dot
// segments, and traversal. The final containment check is defense-in-depth for
// future path-normalization changes.
export const isSafeHfRepoRelativePath = (filename) => {
  if (typeof filename !== 'string' || filename.length === 0) return false;
  if (filename.includes('\\') || posix.isAbsolute(filename) || win32.isAbsolute(filename)) return false;
  const parts = filename.split('/');
  return !parts.some((part) => part === '' || part === '.' || part === '..');
};

const resolveRepoRelativeFile = (snapshotPath, filename) => {
  if (!snapshotPath || !isSafeHfRepoRelativePath(filename)) return null;
  const parts = filename.split('/');
  const candidate = resolvePath(snapshotPath, ...parts);
  return isPathInside(snapshotPath, candidate) ? candidate : null;
};

// Resolve ONE known file inside a repo's newest snapshot, without walking the
// snapshot at all. `inspectModelCache` recursively collects and stats every
// weight in the snapshot — correct when the question is "is this whole model
// downloaded?", but wrong (and expensive) for an aggregate repo where we only
// ever care about a single file: `DeepBeepMeep/LTX-2` hosts every LTX weight in
// one ~708 GB repo, so walking a populated snapshot there stats hundreds of GB
// of files that have nothing to do with the one we asked for.
//
// Returns the absolute path, or null when the repo has no snapshot or the file
// isn't resident. The `stat` FOLLOWS the symlink, so a dangling snapshot link
// left by an interrupted download reports null rather than a plausible path
// that fails on open — the same non-zero test inspectModelCache applies.
export async function findCachedRepoFile(repoId, filename, { revision = null } = {}) {
  if (!repoId || typeof repoId !== 'string') return null;
  if (!filename || typeof filename !== 'string') return null;
  const snapshotPath = await latestSnapshotDir(join(getHfCacheRoot(), repoToDirName(repoId)), revision);
  if (!snapshotPath) return null;
  const candidate = resolveRepoRelativeFile(snapshotPath, filename);
  if (!candidate) return null;
  const stat = await fs.stat(candidate).catch(() => null);
  return stat && stat.size > 0 ? candidate : null;
}

// Verify an explicit file subset inside an aggregate HF repo without walking
// unrelated siblings. Lightning repositories commonly contain many adapters;
// a PortOS profile needs only its pinned high/low-noise pair.
export async function verifyCachedRepoFiles(repoId, filenames, { deep = false, revision = null } = {}) {
  const base = {
    repoId, status: 'missing', cached: false, sizeBytes: 0,
    snapshotPath: null, checkedDeep: deep, files: [],
  };
  const wanted = Array.isArray(filenames)
    ? filenames.filter((name) => typeof name === 'string' && name.length > 0)
    : [];
  if (!repoId || wanted.length === 0) return base;
  const snapshotPath = await latestSnapshotDir(join(getHfCacheRoot(), repoToDirName(repoId)), revision);
  if (!snapshotPath) return base;
  const resolved = wanted.map((name) => ({ name, path: resolveRepoRelativeFile(snapshotPath, name) }));
  const files = await Promise.all(resolved.map((file) => file.path
    ? verifyWeightFile(file, { deep })
    : Promise.resolve({ name: file.name, path: null, ok: false, reason: 'unsafe-path', sizeBytes: 0 })));
  const anyBad = files.some((file) => !file.ok);
  const anyMissing = files.some((file) => file.reason === 'missing-blob');
  return {
    repoId,
    status: anyMissing ? 'missing' : (anyBad ? 'bad' : 'ok'),
    cached: !anyBad,
    sizeBytes: files.filter((file) => file.ok).reduce((sum, file) => sum + (file.sizeBytes || 0), 0),
    snapshotPath,
    checkedDeep: deep,
    files,
  };
}

export async function repairCachedRepoFiles(repoId, filenames, { deep = false, revision = null } = {}) {
  const verify = await verifyCachedRepoFiles(repoId, filenames, { deep, revision });
  if (verify.status !== 'bad') return { repoId, status: verify.status, deleted: [] };
  const deleted = [];
  for (const file of verify.files.filter((entry) => !entry.ok)) {
    if (await repairCachedFile(file.path, { snapshotPath: verify.snapshotPath })) deleted.push(file.name);
  }
  return { repoId, status: 'bad', deleted };
}

// ---------------------------------------------------------------------------
// Weight-integrity verification (issue #1324)
//
// `inspectModelCache` only confirms each weight blob *exists* and is non-zero.
// That misses the failure mode upstream proved out: a corrupt/partial download
// with the *right size but wrong bytes* (e.g. an interrupted resumable fetch
// that left a truncated tensor region, or bit-rot) decodes to garbled "mosaic"
// renders that a clean re-download fixes. `verifyModelCache` adds two cheap,
// no-tensor-load integrity checks on top of the existence check:
//
//   structural — for every `.safetensors` file, read the 8-byte little-endian
//     header-length prefix + the JSON header and confirm the file is at least
//     `8 + headerLen + max(data_offsets.end)` bytes long. Catches truncation
//     and corrupt headers without loading a single tensor.
//   deep (opt-in) — hash a weight file and compare against HuggingFace's
//     published content hash. We get that hash for free, *with no network*:
//     HF names each cache blob by its etag, which for LFS weight files IS the
//     sha256 of the content. The snapshot file is a symlink into
//     `../../blobs/<sha256>`, so the symlink target's basename is the expected
//     digest. (Non-LFS files are named by a git sha1 — skipped, they're tiny
//     config/tokenizer files we don't treat as weights anyway.)
//
// Coverage caveat: the structural check is `.safetensors`-only, and the deep
// check only fires for a sha256-named LFS cache blob. A weight file that is
// neither — a non-`.safetensors` format (`.ckpt`/`.bin`/`.pt`/`.gguf`), or a
// real on-disk copy materialized by a `--local-dir` BYOV install rather than a
// symlinked cache blob — gets only the existence/non-zero check and is reported
// `ok` with reason `'size-only'` (its bytes were NOT content-verified). The
// targeted "mosaic" failure mode is a corrupt LFS-cached `.safetensors`, which
// both checks cover; `'size-only'` is surfaced per-file so a caller can tell a
// verified file from one that was only existence-checked.
// ---------------------------------------------------------------------------

const SAFETENSORS_MAX_HEADER_BYTES = 100_000_000; // 100MB — far above any real header
const SHA256_RE = /^[0-9a-f]{64}$/;

// Cheap structural check for a single .safetensors file. Reads only the header
// region (a few KB), never the tensor payload. Returns { ok, reason, ... }.
export async function verifySafetensorsStructure(path, size) {
  if (size < 8) return { ok: false, reason: 'truncated-header' };
  let fd;
  try {
    fd = await fs.open(path, 'r');
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const head = Buffer.alloc(8);
    await fd.read(head, 0, 8, 0);
    const headerLen = Number(head.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerLen) || headerLen <= 0
      || headerLen > SAFETENSORS_MAX_HEADER_BYTES || 8 + headerLen > size) {
      return { ok: false, reason: 'bad-header-length' };
    }
    const jsonBuf = Buffer.alloc(headerLen);
    await fd.read(jsonBuf, 0, headerLen, 8);
    let header;
    try {
      header = JSON.parse(jsonBuf.toString('utf8'));
    } catch {
      return { ok: false, reason: 'unparseable-header' };
    }
    // A valid safetensors header is a JSON object. Anything else that happens
    // to parse (null, an array, a bare number/string) is corrupt — and
    // `Object.entries(null)` would throw, turning a repairable bad file into a
    // 500 on the status/verify/repair endpoints.
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      return { ok: false, reason: 'unparseable-header' };
    }
    // The largest tensor end-offset (relative to the byte buffer after the
    // header) is the minimum payload length the file must contain.
    let maxEnd = 0;
    for (const [name, tensor] of Object.entries(header)) {
      if (name === '__metadata__') continue;
      const off = tensor?.data_offsets;
      if (Array.isArray(off) && off.length === 2 && Number.isFinite(off[1]) && off[1] > maxEnd) {
        maxEnd = off[1];
      }
    }
    const expectedBytes = 8 + headerLen + maxEnd;
    if (size < expectedBytes) {
      return { ok: false, reason: 'truncated-data', expectedBytes, actualBytes: size };
    }
    return { ok: true, reason: 'structural-ok' };
  } finally {
    await fd.close().catch(() => {});
  }
}

// The expected sha256 for a cache blob is the symlink target's basename (HF
// names LFS blobs by their sha256 etag). Returns null when the snapshot entry
// is a real file (local_dir copy) or a git-sha1-named non-LFS blob — both
// cases have no usable sha256 to compare against.
async function expectedBlobSha256(path) {
  const lst = await fs.lstat(path).catch(() => null);
  if (!lst || !lst.isSymbolicLink()) return null;
  const target = await fs.readlink(path).catch(() => null);
  if (!target) return null;
  // Split on BOTH separators. `readlink` returns a Windows-separated target on
  // win32, so a '/'-only split yielded the ENTIRE path instead of the blob
  // name, SHA256_RE never matched, and this returned null — silently disabling
  // the deep sha256 integrity check (verifyWeightFile then stopped at
  // 'structural-ok' and could never report 'sha256-mismatch') on every Windows
  // install.
  const base = target.split(/[\\/]/).pop();
  return SHA256_RE.test(base) ? base : null;
}

// Verify a single weight file. `deep` adds the sha256 comparison on top of the
// structural check. The returned entry keeps the resolved `path` so the repair
// path can delete the file without re-walking the snapshot.
async function verifyWeightFile(file, { deep }) {
  const stat = await fs.stat(file.path).catch(() => null); // follows symlink
  if (!stat) return { name: file.name, path: file.path, ok: false, reason: 'missing-blob', sizeBytes: 0 };
  if (stat.size === 0) return { name: file.name, path: file.path, ok: false, reason: 'empty', sizeBytes: 0 };

  const entry = { name: file.name, path: file.path, ok: true, reason: 'size-only', sizeBytes: stat.size };
  if (file.name.endsWith('.safetensors')) {
    const structural = await verifySafetensorsStructure(file.path, stat.size);
    if (!structural.ok) {
      return { ...entry, ok: false, reason: structural.reason, expectedBytes: structural.expectedBytes };
    }
    entry.reason = 'structural-ok';
  }
  if (deep) {
    const expectedSha = await expectedBlobSha256(file.path);
    if (expectedSha) {
      const actualSha = await sha256File(file.path).catch(() => null);
      if (actualSha && actualSha !== expectedSha) {
        return { ...entry, ok: false, reason: 'sha256-mismatch' };
      }
      if (actualSha) entry.reason = 'sha256-ok';
    }
  }
  return entry;
}

// Returns `{ repoId, status, cached, sizeBytes, snapshotPath, checkedDeep, files }`.
// `status` is one of:
//   'missing' — no snapshot / no weight files (nothing downloaded to verify)
//   'ok'      — every weight file passed its checks
//   'bad'     — at least one weight file is corrupt/truncated/missing-blob
// `files` carries a per-file `{ name, ok, reason, sizeBytes }` breakdown so the
// repair path knows exactly which files to delete and the UI can explain why.
export async function verifyModelCache(repoId, { deep = false, revision = null } = {}) {
  const base = {
    repoId, status: 'missing', cached: false, sizeBytes: 0,
    snapshotPath: null, checkedDeep: deep, files: [],
  };
  if (!repoId || typeof repoId !== 'string') return base;
  const root = getHfCacheRoot();
  const repoDir = join(root, repoToDirName(repoId));
  const snapshotPath = await latestSnapshotDir(repoDir, revision);
  if (!snapshotPath) return base;
  const weights = [];
  await collectWeightFiles(snapshotPath, weights);
  if (weights.length === 0) return { ...base, snapshotPath };

  const files = await Promise.all(weights.map((w) => verifyWeightFile(w, { deep })));
  let sizeBytes = 0;
  let anyBad = false;
  for (const f of files) {
    if (f.ok) sizeBytes += f.sizeBytes || 0;
    else anyBad = true;
  }
  return {
    repoId,
    status: anyBad ? 'bad' : 'ok',
    cached: !anyBad,
    sizeBytes,
    snapshotPath,
    checkedDeep: deep,
    files,
  };
}

// Delete the flagged (corrupt/truncated/missing-blob) weight files so the
// existing resumable HF fetch path re-downloads them. For symlinked cache
// entries we unlink BOTH the snapshot symlink and the blob it points at — a
// stale blob with the right name but wrong bytes would otherwise be trusted by
// `hf_hub_download` (it keys on the cached etag, not the content) and never
// re-fetched. Returns `{ repoId, status, deleted: [names] }`; an 'ok' or
// 'missing' status deletes nothing (caller just re-downloads from scratch).
export async function repairModelCache(repoId, { deep = false, revision = null } = {}) {
  const verify = await verifyModelCache(repoId, { deep, revision });
  if (verify.status !== 'bad') {
    return { repoId, status: verify.status, deleted: [] };
  }
  const deleted = [];
  for (const file of verify.files.filter((f) => !f.ok)) {
    if (await repairCachedFile(file.path, { snapshotPath: verify.snapshotPath })) deleted.push(file.name);
  }
  return { repoId, status: 'bad', deleted };
}

// Delete ONE cached file (plus the blob behind its symlink) so the resumable HF
// fetch re-downloads it. The single-file counterpart to repairModelCache, for a
// weight that lives inside an aggregate repo: repairModelCache walks the entire
// snapshot, which against a ~700 GB mirror means stat-ing (and under `deep`,
// hashing) every unrelated weight the user happens to have. Unlinking the blob as
// well as the snapshot link is essential — `hf_hub_download` keys on the cached
// etag, not the content, so a stale blob with the right name is trusted and never
// re-fetched (same reasoning as repairModelCache). Returns true when something
// was removed.
export async function repairCachedFile(path, { snapshotPath = null } = {}) {
  if (!path || typeof path !== 'string') return false;
  const resolvedPath = resolvePath(path);
  let boundedSnapshot = snapshotPath ? resolvePath(snapshotPath) : null;
  let repoDir = null;
  if (boundedSnapshot) {
    repoDir = dirname(dirname(boundedSnapshot));
  } else {
    // Infer `<repo>/snapshots/<sha>` only for a canonical HF snapshot entry.
    // Refuse arbitrary filesystem paths: this helper is a cache repair tool,
    // not a general unlink primitive.
    const marker = `${sep}snapshots${sep}`;
    const markerIndex = resolvedPath.lastIndexOf(marker);
    const shaEnd = markerIndex === -1
      ? -1
      : resolvedPath.indexOf(sep, markerIndex + marker.length);
    if (markerIndex === -1 || shaEnd === -1) return false;
    repoDir = resolvedPath.slice(0, markerIndex);
    boundedSnapshot = resolvedPath.slice(0, shaEnd);
  }
  if (!isPathInside(boundedSnapshot, resolvedPath)) return false;
  const lst = await fs.lstat(path).catch(() => null);
  if (!lst) return false;
  if (lst.isSymbolicLink()) {
    const target = await fs.readlink(path).catch(() => null);
    const blobPath = target ? resolvePath(dirname(path), target) : null;
    const blobRoot = join(repoDir, 'blobs');
    if (blobPath && isPathInside(blobRoot, blobPath)) {
      await fs.unlink(blobPath).catch(() => {});
    }
  }
  await fs.unlink(path).catch(() => {});
  return true;
}

// Condense a verifyModelCache() result to the UI-facing shape `{ status,
// checkedDeep, badFiles: [{ name, reason }] }`. Drops the internal file paths
// and per-tensor details — the banner only needs which files are bad and why.
// Single-repo form, used for video models + the text encoder.
export function summarizeVerify(verify) {
  if (!verify) return null;
  return {
    status: verify.status,
    checkedDeep: verify.checkedDeep,
    badFiles: verify.files.filter((f) => !f.ok).map((f) => ({ name: f.name, reason: f.reason })),
  };
}

// Multi-repo condensation for models with a primary + aux repos (image gen):
// 'bad' wins over 'ok' wins over 'missing' so a corrupt aux encoder still
// reports bad, and each bad file carries its repo so the UI can name it.
export function aggregateVerifies(verifies) {
  const list = (verifies || []).filter(Boolean);
  if (list.length === 0) return null;
  const status = list.some((v) => v.status === 'bad') ? 'bad'
    : list.every((v) => v.status === 'ok') ? 'ok'
      : 'missing';
  return {
    status,
    checkedDeep: list.every((v) => v.checkedDeep),
    badFiles: list.flatMap((v) => v.files.filter((f) => !f.ok).map((f) => ({ repo: v.repoId, name: f.name, reason: f.reason }))),
  };
}
