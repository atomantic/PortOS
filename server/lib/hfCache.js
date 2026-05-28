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
import { join } from 'node:path';

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
