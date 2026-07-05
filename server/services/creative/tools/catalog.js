/**
 * Catalog-domain creative tools (#2183). Conductor wrappers over catalog search
 * and cast suggestion. `catalog.searchIngredients` hydrates its description +
 * parameters from the voice `catalog_lookup` tool (the palette hydration
 * pattern) so the ingredient-search schema has a single source of truth.
 */

import { z } from 'zod';
import { listIngredients } from '../../catalogDB.js';
import { suggestCastForBrief } from '../../creativeDirector/autoCast.js';
import { COST_FREE, COST_LLM } from './shared.js';

export const CATALOG_TOOLS = [
  {
    name: 'catalog.searchIngredients',
    description: 'Search the creative ingredients catalog by name/content, optionally narrowed to one type.',
    costClass: COST_FREE,
    // Reuse the voice catalog_lookup schema instead of duplicating it.
    hydrateFrom: 'catalog_lookup',
    schema: z.object({ query: z.string().min(1), type: z.string().optional(), limit: z.number().int().positive().max(50).optional() }),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search across name + payload content.' },
        type: { type: 'string', description: 'Optional: restrict to one ingredient kind.' },
        limit: { type: 'integer', description: 'Max results (default 20).' },
      },
      required: ['query'],
    },
    execute: ({ query, type, limit }) => listIngredients({ query, type, limit: limit ?? 20 }),
  },
  {
    name: 'catalog.suggestCastForBrief',
    description: 'Suggest catalog ingredients to cast for a creative brief (ranked). Uses embedding search over the catalog.',
    costClass: COST_LLM,
    schema: z.object({ brief: z.string().min(1), types: z.array(z.string()).optional(), limit: z.number().int().positive().max(50).optional() }),
    parameters: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'The creative brief to cast against.' },
        types: { type: 'array', items: { type: 'string' }, description: 'Optional castable types to restrict to.' },
        limit: { type: 'integer', description: 'Max suggestions.' },
      },
      required: ['brief'],
    },
    execute: (args) => suggestCastForBrief(args),
  },
];
