// Pure on-disk reasoning for the Ollama↔LM Studio "copy weights locally instead
// of re-downloading" migrate fast-path.
//
// Both backends store the SAME GGUF weights — only the on-disk *layout* differs:
//   • LM Studio: plain files at  <models>/<publisher>/<repo>/<file>.gguf
//                (and Apple **MLX** models, which are NOT GGUF and have no
//                 Ollama equivalent)
//   • Ollama:    a content-addressed blob store —
//                <models>/blobs/sha256-<hash>  referenced by a JSON manifest at
//                <models>/manifests/<registry>/<namespace>/<name>/<tag>
//
// So a single-file GGUF text model can be imported across backends with no
// network pull. Multimodal (separate mmproj projector), sharded (`-00001-of-`),
// and MLX models are the exceptions the caller routes to re-pull / skip.
//
// This module is pure (no fs, no network) so it is unit-testable; the managers
// do the actual reads/copies using these helpers.

// Ollama manifest layer media types.
export const OLLAMA_MODEL_MEDIATYPE = 'application/vnd.ollama.image.model';
export const OLLAMA_PROJECTOR_MEDIATYPE = 'application/vnd.ollama.image.projector';

/**
 * Extract the weight + projector blob digests from a parsed Ollama manifest.
 * @param {object} manifest
 * @returns {{ modelDigest: string|null, projectorDigest: string|null }}
 */
export function parseOllamaManifest(manifest) {
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  const find = (mt) => layers.find((l) => l?.mediaType === mt)?.digest || null;
  return { modelDigest: find(OLLAMA_MODEL_MEDIATYPE), projectorDigest: find(OLLAMA_PROJECTOR_MEDIATYPE) };
}

/** `sha256:abc123` → `sha256-abc123` (Ollama's blob filename form). */
export function digestToBlobFilename(digest) {
  return String(digest || '').replace(':', '-');
}

/**
 * Parse an Ollama model ref into registry/namespace/name/tag, mirroring how
 * Ollama lays manifests out on disk. Bare names default to the
 * `registry.ollama.ai/library/<name>:latest` form.
 * @param {string} id e.g. `llama3.2:latest`, `gpt-oss:20b`, `myorg/m:tag`
 */
export function parseOllamaModelRef(id) {
  let rest = String(id || '').trim();
  if (!rest) return { registry: 'registry.ollama.ai', namespace: 'library', name: '', tag: 'latest' };

  // Split off the tag: the LAST `:` only when what follows has no `/` (so a
  // `host:port/...` registry prefix isn't mistaken for a tag).
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon !== -1 && !rest.slice(colon + 1).includes('/')) {
    tag = rest.slice(colon + 1) || 'latest';
    rest = rest.slice(0, colon);
  }

  const parts = rest.split('/').filter(Boolean);
  let registry = 'registry.ollama.ai';
  let namespace = 'library';
  let name = rest;
  if (parts.length === 1) {
    name = parts[0];
  } else if (parts.length === 2) {
    [namespace, name] = parts;
  } else {
    // registry / namespace / name (extra path segments fold into the namespace)
    registry = parts[0];
    name = parts[parts.length - 1];
    namespace = parts.slice(1, -1).join('/');
  }
  return { registry, namespace, name, tag };
}

/** Relative manifest path (POSIX-joined) for a parsed ref. */
export function ollamaManifestRelPath({ registry, namespace, name, tag }) {
  return ['manifests', registry, namespace, name, tag].join('/');
}

/** A filesystem-safe Ollama model name for `ollama create` / `/api/create`. */
export function sanitizeOllamaName(id) {
  const base = String(id || '').split('/').pop() || '';
  const cleaned = base.trim().toLowerCase().replace(/[^a-z0-9._:-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'imported-model';
}

/** Is this directory an MLX model (safetensors, no GGUF)? MLX ≠ GGUF. */
export function dirIsMlx(filenames = []) {
  const lower = filenames.map((f) => String(f).toLowerCase());
  const hasGguf = lower.some((f) => f.endsWith('.gguf'));
  const hasSafetensors = lower.some((f) => f.endsWith('.safetensors'));
  return hasSafetensors && !hasGguf;
}

const isProjectorName = (f) => /(^|[-_./])(mmproj|projector)/i.test(f);
const isShardName = (f) => /-\d{5}-of-\d{5}\.gguf$/i.test(f);

/**
 * Pick the primary weights GGUF from a directory listing: skip projector files,
 * prefer the first shard of a sharded model, otherwise the first `.gguf`.
 * @returns {string|null} the chosen basename
 */
export function selectPrimaryGguf(filenames = []) {
  const ggufs = filenames.filter((f) => /\.gguf$/i.test(f) && !isProjectorName(f));
  if (ggufs.length === 0) return null;
  const firstShard = ggufs.find((f) => /-00001-of-\d{5}\.gguf$/i.test(f));
  return firstShard || ggufs[0];
}

/** Find the multimodal projector GGUF in a listing, if any. */
export function selectProjectorGguf(filenames = []) {
  return filenames.find((f) => /\.gguf$/i.test(f) && isProjectorName(f)) || null;
}

/** True when the chosen GGUF is one part of a multi-file (sharded) model. */
export function isShardedGguf(basename) {
  return isShardName(String(basename || ''));
}

// Make one id segment safe to use as a directory name on every platform —
// anything outside [A-Za-z0-9._-] (notably `:` from Ollama tags like
// `model:latest`, and `\` on Windows) collapses to `-`.
const fsSafeSegment = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';

/**
 * Split an LM Studio model id into its on-disk `<publisher>/<repo>` parts,
 * sanitized into filesystem-safe path components (the id may be migration-
 * generated, e.g. `imported/llama3.2:latest`, not just a clean LM Studio id).
 * Bare ids (no `/`) land under an `imported` publisher.
 */
export function lmStudioPublisherRepo(lmstudioId) {
  const parts = String(lmstudioId || '').split('/').filter(Boolean);
  if (parts.length >= 2) return { publisher: fsSafeSegment(parts[0]), repo: fsSafeSegment(parts.slice(1).join('-')) };
  return { publisher: 'imported', repo: fsSafeSegment(parts[0] || 'model') };
}

/** A `FROM <gguf>` Modelfile body for importing a local GGUF into Ollama. */
export function buildModelfile(ggufPath) {
  return `FROM ${ggufPath}\n`;
}
