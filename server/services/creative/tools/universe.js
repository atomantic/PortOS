/**
 * Universe-domain creative tools (#2183). Conductor wrappers over existing
 * Universe Builder entry points — no re-implementation.
 */

import { z } from 'zod';
import { createUniverse, needsEntryIdPersist, updateUniverse } from '../../universeBuilder.js';
import { expandWorldTemplate } from '../../universeBuilderExpand.js';
import { renderUniverseJobs } from '../../universeBuilderRender.js';
import { COST_FREE, COST_LLM, COST_RENDER } from './shared.js';

export const UNIVERSE_TOOLS = [
  {
    name: 'universe_createUniverse',
    description: 'Create a new universe record (a creative world container). Persists a record; does not generate content.',
    costClass: COST_FREE,
    schema: z.object({ name: z.string().min(1) }).passthrough(),
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Universe name.' } },
      required: ['name'],
    },
    execute: (args) => createUniverse(args),
  },
  {
    name: 'universe_expandWorldTemplate',
    description: 'Expand a starter prompt into a universe bible (logline, premise, style, canon) via the configured LLM. Returns the parsed bible; does not persist.',
    costClass: COST_LLM,
    // `influences` must be the structured `{ embrace, avoid }` token-list shape —
    // the service's sanitizeInfluences ignores a bare string and silently drops
    // the style direction, so advertise (and validate) the object shape.
    schema: z.object({
      starterPrompt: z.string().min(1),
      influences: z.object({ embrace: z.array(z.string()).optional(), avoid: z.array(z.string()).optional() }).optional(),
    }).passthrough(),
    parameters: {
      type: 'object',
      properties: {
        starterPrompt: { type: 'string', description: 'Seed prompt describing the world to expand.' },
        influences: {
          type: 'object',
          description: 'Optional stylistic influences as token lists.',
          properties: {
            embrace: { type: 'array', items: { type: 'string' }, description: 'Positive-prompt style tokens to embrace.' },
            avoid: { type: 'array', items: { type: 'string' }, description: 'Negative-prompt tokens to avoid.' },
          },
        },
        providerId: { type: 'string', description: 'Optional LLM provider override.' },
        model: { type: 'string', description: 'Optional model override.' },
      },
      required: ['starterPrompt'],
    },
    execute: (args) => expandWorldTemplate(args),
  },
  {
    name: 'universe_renderUniverseJobs',
    description: "Enqueue a batch of image-generation jobs for a universe's canon/variations/composite sheets (requires local or codex image-gen mode). Long-running: returns job handles; completion arrives via media-job events.",
    costClass: COST_RENDER,
    longRunning: true,
    schema: z.object({ universeId: z.string().min(1), body: z.record(z.any()).optional() }),
    parameters: {
      type: 'object',
      properties: {
        universeId: { type: 'string', description: 'Universe id to render.' },
        body: { type: 'object', description: 'Render options (promptMode, selection, batchPerVariation, extraStyle, negativePrompt, stylePresetId, mode).' },
      },
      required: ['universeId'],
    },
    // Mirror the render route's preflight (routes/universeBuilder.js): for a
    // non-canon render of a legacy universe, persist the transient
    // variation/sheet entry ids first (a no-op `updateUniverse` write) so they
    // stay stable across enqueue → completion and the filename hook can attach
    // rendered files back to the source rows. mapServiceError is an identity
    // rethrow — the dispatcher owns error surfacing.
    execute: async ({ universeId, body }) => {
      const opts = body || {};
      if (opts.promptMode !== 'canon' && await needsEntryIdPersist(universeId)) {
        await updateUniverse(universeId, () => ({}));
      }
      return renderUniverseJobs(universeId, opts, (err) => err);
    },
  },
];
