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
import { join, dirname, resolve as resolvePath } from 'node:path';
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
async function latestSnapshotDir(repoDir) {
  const snapshotsRoot = join(repoDir, 'snapshots');
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
export async function inspectModelCache(repoId) {
  if (!repoId || typeof repoId !== 'string') {
    return { cached: false, sizeBytes: 0, snapshotPath: null };
  }
  const root = getHfCacheRoot();
  const repoDir = join(root, repoToDirName(repoId));
  const snapshotPath = await latestSnapshotDir(repoDir);
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
  const base = target.split('/').pop();
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
export async function verifyModelCache(repoId, { deep = false } = {}) {
  const base = {
    repoId, status: 'missing', cached: false, sizeBytes: 0,
    snapshotPath: null, checkedDeep: deep, files: [],
  };
  if (!repoId || typeof repoId !== 'string') return base;
  const root = getHfCacheRoot();
  const repoDir = join(root, repoToDirName(repoId));
  const snapshotPath = await latestSnapshotDir(repoDir);
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
export async function repairModelCache(repoId, { deep = false } = {}) {
  const verify = await verifyModelCache(repoId, { deep });
  if (verify.status !== 'bad') {
    return { repoId, status: verify.status, deleted: [] };
  }
  const deleted = [];
  for (const file of verify.files.filter((f) => !f.ok)) {
    const lst = await fs.lstat(file.path).catch(() => null);
    if (lst?.isSymbolicLink()) {
      const target = await fs.readlink(file.path).catch(() => null);
      if (target) {
        const blobPath = resolvePath(dirname(file.path), target);
        await fs.unlink(blobPath).catch(() => {});
      }
    }
    await fs.unlink(file.path).catch(() => {});
    deleted.push(file.name);
  }
  return { repoId, status: 'bad', deleted };
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
