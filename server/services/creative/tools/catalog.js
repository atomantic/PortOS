/**
 * Catalog-domain creative tools (#2183). Conductor wrappers over catalog search
 * and cast suggestion. `catalog.searchIngredients` hydrates its description +
 * parameters from the voice `catalog_lookup` tool (the palette hydration
 * pattern) so the ingredient-search schema has a single source of truth.
 */

import { z } from 'zod';
import { dispatchTool as dispatchVoiceTool } from '../../voice/tools.js';
import { suggestCastForBrief } from '../../creativeDirector/autoCast.js';
import { COST_FREE, COST_LLM } from './shared.js';

export const CATALOG_TOOLS = [
  {
    name: 'catalog.searchIngredients',
    // Full conductor over the voice `catalog_lookup` tool: description +
    // parameters are hydrated from it (single source of the ingredient-search
    // schema; the guard guarantees hydration resolves) AND execute delegates to
    // its implementation via dispatchVoiceTool — so the advertised input AND
    // result shape (default limit 5/max 20, snippet + refsCount) are honored
    // exactly, with no re-implementation.
    costClass: COST_FREE,
    hydrateFrom: 'catalog_lookup',
    schema: z.object({ query: z.string().min(1), type: z.string().optional(), limit: z.number().int().positive().max(20).optional() }),
    execute: (args, ctx) => dispatchVoiceTool('catalog_lookup', args, ctx),
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
