// Creative-catalog voice tool (catalog_lookup): search the creative ingredients
// catalog (characters, places, objects, ideas, scenes, concepts — plus any
// user-defined types) by name or content. The `type` enum is widened to the
// live type registry at spec-build time (see catalogTypeEnum), and the intent
// gate is extended at classify time for user-defined nouns (see
// matchesCustomCatalogNoun) since the static regex only knows the six built-ins.

import { listIngredients as listCatalogIngredients, listRefsForIngredient } from '../../catalogDB.js';
import { getActiveCatalogTypes, isActiveType } from '../../../lib/catalogTypes.js';
import { clampLimit } from './shared.js';

// Creative catalog lookups — "find my character X", "what scenes feature Y",
// "look up the place named Z", "search my catalog for …". Tight enough that
// generic "find" / "search" don't trip it (those still go to brain_search).
export const CATALOG_INTENT_RE = /\b(catalog|ingredient|cast|creative library)\b|\b(?:look ?up|find|search|show me|do i have|any)\b[^.!?\n]{0,30}\b(?:character|place|object|scene|concept|idea|prop|setting|location|faction)s?\b/i;

// Catalog ingredient kinds. The six built-ins are a STATIC fallback; the live
// enum advertised to the LLM (and the filter-validity check) resolves through
// the active type registry at `getToolSpecs()` / call time so user-defined
// types (Settings → Catalog) are voice-addressable too. `activeCatalogTypeIds`
// reads the registry fresh each call — it changes on a settings save / peer
// sync without a process restart.
const CATALOG_INGREDIENT_TYPES = ['character', 'place', 'object', 'idea', 'scene', 'concept'];
const activeCatalogTypeIds = () => {
  const ids = getActiveCatalogTypes().map((t) => t.id);
  return ids.length ? ids : CATALOG_INGREDIENT_TYPES;
};

// The live `type` enum for catalog_lookup, used by the orchestrator's
// spec-builder to widen the static schema with user-defined types.
export const catalogTypeEnum = () => activeCatalogTypeIds();

// Escape a freeform string (a user-type label can be anything) for safe use
// inside a `new RegExp(...)` so a label like "C++ faction" can't throw or inject.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The static `catalog` regex only knows the six built-in nouns. A user-defined
// type (e.g. "wardrobe", "faction") wouldn't trip it, so "search my wardrobes"
// would never surface `catalog_lookup` (the enum-widening in catalogTypeEnum
// can't help a tool that intent-gating already dropped). Returns true when the
// utterance mentions any active user type's id or label — singular or simple
// plural. System types are already covered by CATALOG_INTENT_RE.
export const matchesCustomCatalogNoun = (userText) => {
  const customNouns = getActiveCatalogTypes()
    .filter((t) => t.system === false)
    .flatMap((t) => [t.id, t.label])
    .filter((s) => typeof s === 'string' && s.trim().length > 1)
    .map((s) => s.trim().toLowerCase());
  if (!customNouns.length) return false;
  const lower = userText.toLowerCase();
  // Match the noun as a whole word, optionally pluralized (foo → foos/fooes).
  return customNouns.some((n) => new RegExp(`\\b${escapeRegExp(n)}e?s?\\b`).test(lower));
};

// Pull a short snippet from an ingredient's type-specific payload. Mirrors
// the fallback chain used by client/src/pages/Catalog.jsx so voice + UI agree
// on what "the body" of an ingredient is. Trimmed to 200 chars.
const catalogPayloadSnippet = (payload) => {
  if (!payload || typeof payload !== 'object') return '';
  const raw = payload.physicalDescription
    || payload.description
    || payload.summary
    || payload.personality
    || payload.significance
    || payload.role
    || payload.notes
    || '';
  const text = String(raw).trim().replace(/\s+/g, ' ');
  if (text.length <= 200) return text;
  return `${text.slice(0, 197)}…`;
};

export const CATALOG_TOOLS = [
  {
    name: 'catalog_lookup',
    description:
      'Search the creative ingredients catalog (characters, places, objects, ideas, scenes, concepts) by name or content. ' +
      'Use when the user asks "do I have a character named X?", "find my places", "look up the scene where Y happens", "what concepts are in my catalog about Z". ' +
      'Returns up to `limit` matches (default 5) with id, name, type, a short snippet, and link count. Pass `type` to narrow to a single kind.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search across name + payload content. Use the user\'s most distinctive phrasing.' },
        // enum is filled in at spec-build time (toSpec) from the active type
        // registry so user-defined types are advertised; this static default
        // is the fallback shape.
        type: { type: 'string', enum: CATALOG_INGREDIENT_TYPES, description: 'Optional: restrict to one ingredient kind.' },
        limit: { type: 'integer', description: 'Max results (default 5, max 20).' },
      },
      required: ['query'],
    },
    execute: async ({ query, type, limit = 5 } = {}) => {
      if (typeof query !== 'string' || !query.trim()) throw new Error('query is required');
      const q = query.trim();
      const max = clampLimit(limit, 5, 20);
      // Accept any ACTIVE type (built-in or user-defined); an unknown type
      // silently drops to an unfiltered search rather than erroring.
      const filterType = type && isActiveType(type) ? type : undefined;
      const { items } = await listCatalogIngredients({ query: q, type: filterType, limit: max });
      const results = await Promise.all(items.map(async (ing) => {
        const refs = await listRefsForIngredient(ing.id);
        return {
          id: ing.id,
          name: ing.name,
          type: ing.type,
          snippet: catalogPayloadSnippet(ing.payload),
          refsCount: refs.length,
        };
      }));
      const summary = results.length
        ? `Found ${results.length} catalog match${results.length === 1 ? '' : 'es'} for "${q}"${filterType ? ` (${filterType})` : ''}.`
        : `No catalog ingredients matched "${q}"${filterType ? ` in ${filterType}` : ''}.`;
      return { ok: true, count: results.length, results, summary };
    },
  },
];
