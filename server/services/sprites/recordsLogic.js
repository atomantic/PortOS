/**
 * Sprites — pure record builders/mutators shared by the DB and file backends
 * (issue #2895, phase 1). Mirrors musicVideo/projectsLogic.js: all mutation
 * semantics live here so the two backends can't drift.
 *
 * A sprite record is the db-primary metadata for one sprite subject — a
 * `character` (identity reference → anchors → walk animations → atlas), a
 * `place`, a standalone `object`, or an imported `props` family (a fixed-cell
 * atlas of non-character sprites). Binary assets (reference images, strips,
 * atlases, manifests) live on disk under data/sprites/<id>/ — the record holds
 * only metadata and workflow state.
 *
 * `props` is a legacy import-only value (#2932): imported prop atlas families
 * keep `kind: 'props'` and the UI folds them under the same "Objects" heading
 * as `object` — no migration, since the two are user-visibly identical. New
 * records created through the UI only ever get `character`/`place`/`object`.
 */

export const SPRITE_RECORD_KINDS = ['character', 'place', 'object', 'props'];

// Record ids double as the on-disk directory name under data/sprites/ — keep
// them strict kebab-case so a record id can never traverse the filesystem.
export const SPRITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSpriteId(id) {
  return typeof id === 'string' && SPRITE_ID_PATTERN.test(id);
}

/**
 * Derive a record id from a display name (kebab, pattern-conformant), or
 * null when nothing derivable remains. (lib/planIds' slugify was considered
 * but its 'item' fallback and collision suffixing don't fit — sprite creation
 * 400s on an underivable name and 409s on a duplicate id instead.)
 */
export function deriveSpriteId(name) {
  const id = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return isValidSpriteId(id) ? id : null;
}

export function mirrorTimestamp(value, fallback) {
  return typeof value === 'string' && value ? value : fallback;
}

const trimOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function buildSpriteRecord(input, { id, now }) {
  const kind = SPRITE_RECORD_KINDS.includes(input.kind) ? input.kind : 'character';
  return {
    id,
    kind,
    name: trimOrNull(input.name) || id,
    status: trimOrNull(input.status) || 'draft',
    // Character spec (proportions/materials/appearance) — verbatim from the
    // source pipeline for characters, null for props families.
    spec: input.spec && typeof input.spec === 'object' ? input.spec : null,
    // Matte color used for video keying (per-character, phase 2 makes this
    // dynamic — one of the standard keys #FF00FF / #00FF00 / #0000FF).
    chromaKey: trimOrNull(input.chromaKey),
    // Publish binding ({ appId, atlasDestPath, codeBinding? }) — configured in
    // phase 4; imported records start unbound.
    publishBinding: input.publishBinding && typeof input.publishBinding === 'object'
      ? input.publishBinding
      : null,
    importedFrom: input.importedFrom && typeof input.importedFrom === 'object'
      ? input.importedFrom
      : null,
    notes: trimOrNull(input.notes),
    createdAt: now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
  };
}

// Whitelist patch — key-absent preserves, key-present applies (including an
// intentional clear via null/''), per the LLM/merge convention in CLAUDE.md.
const PATCHABLE = ['name', 'status', 'kind', 'spec', 'chromaKey', 'publishBinding', 'notes'];

export function applySpriteRecordPatch(record, patch) {
  const next = { ...record };
  for (const key of PATCHABLE) {
    if (!(key in patch)) continue;
    if (key === 'name') next.name = trimOrNull(patch.name) || record.name;
    else if (key === 'status') next.status = trimOrNull(patch.status) || record.status;
    // Reclassifying is allowed (e.g. fix a mis-imported record); an unknown
    // kind is ignored rather than corrupting the record. The route's Zod
    // schema already enum-gates it — this is the defense-in-depth backstop.
    else if (key === 'kind') next.kind = SPRITE_RECORD_KINDS.includes(patch.kind) ? patch.kind : record.kind;
    else if (key === 'spec' || key === 'publishBinding') {
      next[key] = patch[key] && typeof patch[key] === 'object' ? patch[key] : null;
    } else next[key] = trimOrNull(patch[key]);
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * Merge a fresh import over an existing record: import metadata wins for the
 * source-derived fields (kind/spec/importedFrom), but user-managed fields the
 * importer doesn't know about (publishBinding, notes, a manually-set
 * chromaKey) survive a re-import.
 */
export function mergeImportedRecord(existing, imported, now) {
  if (!existing || existing.deleted) return { ...imported, createdAt: imported.createdAt || now, updatedAt: now };
  return {
    ...existing,
    kind: imported.kind,
    name: imported.name,
    status: imported.status,
    spec: imported.spec,
    // Preserve the existing value verbatim — including an intentional null
    // clear; `||` would resurrect the legacy import default over a clear.
    chromaKey: existing.chromaKey !== undefined ? existing.chromaKey : imported.chromaKey,
    importedFrom: imported.importedFrom,
    updatedAt: now,
  };
}
