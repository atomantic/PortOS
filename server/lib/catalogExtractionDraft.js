// Extraction-only graph validation and reconciliation. No records are written.
import { z } from 'zod';
import { catalogDraftRelationshipSchema } from './catalogValidation.js';
import { CATALOG_TYPES, canonicalTagKey } from './catalogTypes.js';
import { BIBLE_FIELD, BIBLE_LIMITS, PROMPT_FIELDS, sanitizeBibleList, stripCanonControlFields } from './storyBible.js';
import { writersRoomCharacterCreateSchema, writersRoomPlaceUpdateSchema, writersRoomObjectCreateSchema } from './pipelineValidation.js';

export const CATALOG_DRAFT_TYPES = Object.freeze(CATALOG_TYPES.map(type => ({
  ...type, key: BIBLE_FIELD[type.id] || `${type.id}s`,
})));
const text = max => z.string().trim().max(max);
const strings = (max, count) => z.array(text(max).min(1)).max(count);
const draftId = text(64).min(1).regex(/^[a-zA-Z0-9_-]+$/);
const common = {
  draftId,
  name: text(BIBLE_LIMITS.NAME_MAX).min(1),
  // A distinctive phrase from the source, never a generated global entity ID.
  sourceIdentity: text(300).optional(),
  aliases: strings(BIBLE_LIMITS.ALIAS_MAX, BIBLE_LIMITS.ALIASES_PER_ENTRY_MAX).optional(),
  tags: strings(BIBLE_LIMITS.TAG_MAX, BIBLE_LIMITS.TAGS_PER_ENTRY_MAX).default([]),
};
const bibleSchemas = {
  character: writersRoomCharacterCreateSchema,
  place: writersRoomPlaceUpdateSchema,
  object: writersRoomObjectCreateSchema,
};
const structuredFields = {
  stats: z.array(z.object({ label: text(80), value: text(200) }).strict()).max(30),
  colorPalette: z.array(z.object({ name: text(80), hex: text(10), role: text(120).optional() }).strict()).max(12),
  props: z.array(z.object({ name: text(120), purpose: text(400).optional(), materials: text(200).optional(), notes: text(600).optional() }).strict()).max(12),
  expressions: z.array(z.object({ name: text(80), description: text(400) }).strict()).max(16),
  handGestures: z.array(z.object({ name: text(80), description: text(300) }).strict()).max(12),
};

function entrySchema(type) {
  if (type.extractionShape === 'bible') {
    // Reuse the authored bible schemas; restrict to creative prompt fields so
    // model output cannot smuggle operational IDs, locks or media references.
    const fields = Object.fromEntries(PROMPT_FIELDS[type.id]
      .filter(key => key !== 'voiceId')
      .map(key => {
        const cap = BIBLE_LIMITS[key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase() + '_MAX'];
        return [key, (structuredFields[key] || (cap ? text(cap) : bibleSchemas[type.id].shape[key]) || text(2000)).optional()];
      }));
    return z.object({ ...fields, ...common,
      evidence: strings(BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX).min(1),
    }).strict();
  }
  return z.object({ ...common, summary: text(2000).min(1), evidence: text(400).min(1),
    ...(type.id === 'scene' ? { setting: text(200).nullable().optional(), actors: strings(200, 12).optional() } : {}),
    ...(type.id === 'concept' ? { kind: text(64).optional() } : {}),
  }).strict();
}

export const catalogExtractionDraftSchema = z.object({
  ...Object.fromEntries(CATALOG_DRAFT_TYPES.map(type => [type.key, z.array(entrySchema(type)).max(200)])),
  relationships: z.array(catalogDraftRelationshipSchema.extend({ fromDraftId: draftId, toDraftId: draftId })).max(1000),
}).strict();

export const emptyCatalogDraft = () => ({
  ...Object.fromEntries(CATALOG_DRAFT_TYPES.map(({ key }) => [key, []])), relationships: [],
});
const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const unique = values => [...new Set(values)];
// A determiner, generic noun or single adjective is not a source identity.
// Require at least two distinguishing words beyond the candidate's own labels
// (e.g. an explicit owner or origin phrase). Uncertain repeats stay separate.
const IDENTITY_GLUE = new Set('a an the this that these those his her their its my our your of from to with at in on and by for'.split(' '));
const words = value => normalize(value).match(/[\p{L}\p{N}]+/gu) || [];
const aliasKey = value => normalize(value).replace(/^(?:a|an|the|this|that|his|her|their|its|my|our|your)\s+/, '');
function sourceIdentityKey(entry) {
  const identity = normalize(entry.sourceIdentity);
  const labels = new Set([entry.name, ...(entry.aliases || [])].flatMap(words));
  const distinguishing = new Set(words(identity).filter(word => !labels.has(word) && !IDENTITY_GLUE.has(word)));
  return distinguishing.size >= 2 ? identity : '';
}

function sanitizeEntry(raw, type, factual) {
  const entry = type.extractionShape === 'bible'
    ? stripCanonControlFields(sanitizeBibleList([raw], type.id)[0]) : { ...raw };
  // Stable only within this extraction. Do not use canon-generated IDs as
  // graph endpoints, nor put these metadata fields inside ingredient payloads.
  entry.draftId = raw.draftId;
  if (raw.sourceIdentity) entry.sourceIdentity = raw.sourceIdentity;
  if (raw.aliases) entry.aliases = raw.aliases;
  entry.tags = [...new Map([...(entry.tags || []), ...(factual ? ['factual', ...(type.id === 'character' ? ['real-person'] : [])] : [])]
    .map(tag => [canonicalTagKey(tag), tag])).values()];
  if (entry.tags.length > BIBLE_LIMITS.TAGS_PER_ENTRY_MAX) throw new Error('Catalog tags exceed the review limit; retry extraction.');
  return entry;
}

/** Parse the ENTIRE output, without repairing truncation or selecting an inner object. */
export function parseCatalogDraft(content, { corpus, factual = false, finishReason } = {}) {
  if (finishReason && !['stop', 'end_turn', 'stop_sequence'].includes(finishReason)) {
    throw new Error(`Extraction stopped before completion (${finishReason}); retry with more output capacity or a shorter source.`);
  }
  if (typeof content !== 'string' || content.length > 2_000_000) throw new Error('Invalid catalog extraction response.');
  // A complete outer fence is tolerated; an unclosed fence or extra prose is not.
  const fenced = content.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  let parsed;
  try { parsed = JSON.parse(fenced ? fenced[1] : content); } catch {
    throw new Error('Invalid or truncated catalog JSON; retry extraction.');
  }
  const validated = catalogExtractionDraftSchema.safeParse(parsed);
  if (!validated.success) throw new Error('Invalid catalog draft schema; retry extraction.');
  const draft = validated.data;
  const ids = new Map();
  const source = normalize(corpus);
  const grounded = quote => source.includes(normalize(quote));
  for (const type of CATALOG_DRAFT_TYPES) {
    for (const entry of draft[type.key]) {
      if (ids.has(entry.draftId)) throw new Error('Duplicate catalog draft ID; retry extraction.');
      ids.set(entry.draftId, type.id);
      const evidence = Array.isArray(entry.evidence) ? entry.evidence : [entry.evidence];
      if (!evidence.every(grounded) || !(entry.aliases || []).every(grounded) || (entry.sourceIdentity && !grounded(entry.sourceIdentity))) {
        throw new Error('Catalog evidence is not present in the source; retry extraction.');
      }
    }
  }
  if (ids.size > 200) throw new Error('Catalog draft exceeds 200 entries; extract a smaller source.');
  for (const edge of draft.relationships) {
    if (!ids.has(edge.fromDraftId) || !ids.has(edge.toDraftId) || edge.fromDraftId === edge.toDraftId) {
      throw new Error('Invalid catalog relationship endpoint; retry extraction.');
    }
    if (!grounded(edge.evidence)) throw new Error('Catalog relationship evidence is not present in the source; retry extraction.');
    if (['owned-by', 'used-by'].includes(edge.kind)
      && (ids.get(edge.fromDraftId) !== 'object' || ids.get(edge.toDraftId) !== 'character')) {
      throw new Error('Ownership and use must point from an object to a character.');
    }
  }
  for (const type of CATALOG_DRAFT_TYPES) draft[type.key] = draft[type.key].map(entry => sanitizeEntry(entry, type, factual));
  return draft;
}

function mergeEntries(first, next, type) {
  const merged = { ...first };
  if (!merged.sourceIdentity && next.sourceIdentity) merged.sourceIdentity = next.sourceIdentity;
  for (const [key, value] of Object.entries(next)) {
    if (['draftId', 'sourceIdentity', 'name'].includes(key) || value == null || value === '') continue;
    const prev = merged[key];
    if (prev == null || prev === '' || JSON.stringify(prev) === JSON.stringify(value)) { merged[key] = value; continue; }
    if (Array.isArray(prev) && Array.isArray(value)) {
      merged[key] = [...new Map([...prev, ...value].map(item => [JSON.stringify(item), item])).values()];
    } else if (typeof prev === 'string' && typeof value === 'string') {
      merged[key] = unique([...prev.split('\n'), ...value.split('\n')]).join('\n');
    } else {
      // Conflicting structured facts deserve two review candidates, not loss.
      return null;
    }
  }
  merged.aliases = unique([...(merged.aliases || []), ...(normalize(first.name) !== normalize(next.name) ? [next.name] : [])]);
  // If unioning supported facts would hit a field cap, keep separate candidates.
  // Never silently slice away the second chunk's contribution.
  if (type.extractionShape === 'bible') {
    const sanitized = stripCanonControlFields(sanitizeBibleList([merged], type.id)[0]);
    for (const key of Object.keys(sanitized)) {
      if (JSON.stringify(sanitized[key]) !== JSON.stringify(merged[key])) return null;
    }
  } else if ((merged.summary?.length || 0) > 2000 || (merged.evidence?.length || 0) > 400) return null;
  if ((merged.aliases?.length || 0) > BIBLE_LIMITS.ALIASES_PER_ENTRY_MAX || merged.tags.length > BIBLE_LIMITS.TAGS_PER_ENTRY_MAX) return null;
  return merged;
}

/** Remap local IDs, reconcile only distinctive identities or unambiguous aliases. */
export function dedupDrafts(drafts = []) {
  const merged = emptyCatalogDraft();
  const remap = new Map();
  for (const type of CATALOG_DRAFT_TYPES) {
    const nodes = drafts.flatMap((draft, chunk) => (draft?.[type.key] || []).map((entry, index) => ({
      entry, chunk, id: `${chunk}:${entry.draftId || index}`,
    })));
    const buckets = new Map();
    for (const node of nodes) {
      const identity = sourceIdentityKey(node.entry);
      const hints = [
        ...(identity ? [`identity:${identity}`] : []),
        ...unique([node.entry.name, ...(node.entry.aliases || [])].map(aliasKey)).filter(Boolean).map(value => `alias:${value}`),
      ];
      for (const hint of hints) {
        if (!buckets.has(hint)) buckets.set(hint, []);
        buckets.get(hint).push(node);
      }
    }
    const eligible = new Map();
    for (const [hint, bucket] of buckets) {
      // A repeated token in ONE chunk names multiple candidates: ambiguous.
      if (bucket.length < 2 || new Set(bucket.map(node => node.chunk)).size !== bucket.length) continue;
      if (hint.startsWith('alias:') && !bucket.some(node => (node.entry.aliases || []).some(alias => aliasKey(alias) !== aliasKey(node.entry.name) && `alias:${aliasKey(alias)}` === hint))) continue;
      const identities = unique(bucket.map(node => normalize(node.entry.sourceIdentity)).filter(Boolean));
      if (identities.length > 1) continue;
      for (const node of bucket) {
        if (!eligible.has(node.id)) eligible.set(node.id, new Set());
        bucket.forEach(other => eligible.get(node.id).add(other.id));
      }
    }
    const groups = [];
    for (const node of nodes) {
      const matches = groups.filter(group => !group.chunks.has(node.chunk)
        && (!group.entry.sourceIdentity || !node.entry.sourceIdentity
          || normalize(group.entry.sourceIdentity) === normalize(node.entry.sourceIdentity))
        && group.members.some(id => eligible.get(node.id)?.has(id)));
      const match = matches.length === 1 ? matches[0] : null;
      const combined = match && mergeEntries(match.entry, node.entry, type);
      if (combined) {
        match.entry = combined;
        match.members.push(node.id);
        match.chunks.add(node.chunk);
        remap.set(node.id, match.entry.draftId);
      } else {
        const entry = { ...node.entry, draftId: `draft-${type.id}-${groups.length + 1}` };
        groups.push({ entry, members: [node.id], chunks: new Set([node.chunk]) });
        remap.set(node.id, entry.draftId);
      }
    }
    merged[type.key] = groups.map(group => group.entry);
  }
  const edges = new Map();
  drafts.forEach((draft, chunk) => {
    for (const edge of draft?.relationships || []) {
      const fromDraftId = remap.get(`${chunk}:${edge.fromDraftId}`);
      const toDraftId = remap.get(`${chunk}:${edge.toDraftId}`);
      if (!fromDraftId || !toDraftId || fromDraftId === toDraftId) continue;
      const key = `${fromDraftId}:${toDraftId}:${edge.kind}`;
      const prev = edges.get(key);
      const evidence = unique([...(prev?.evidence.split('\n') || []), edge.evidence]).join('\n');
      if (!catalogDraftRelationshipSchema.shape.evidence.safeParse(evidence).success) {
        throw new Error('Combined relationship evidence exceeds 400 characters; extract a smaller source.');
      }
      edges.set(key, { ...edge, fromDraftId, toDraftId, evidence });
    }
  });
  merged.relationships = [...edges.values()];
  return merged;
}
