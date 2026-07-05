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
    // description + parameters are hydrated from the voice `catalog_lookup` tool
    // (single source of the ingredient-search schema); the guard guarantees the
    // hydration resolves, so no authored fallback is needed here. Only the Zod
    // `schema` (used for arg validation) is local.
    costClass: COST_FREE,
    hydrateFrom: 'catalog_lookup',
    schema: z.object({ query: z.string().min(1), type: z.string().optional(), limit: z.number().int().positive().max(50).optional() }),
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
