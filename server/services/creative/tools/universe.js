/**
 * Universe-domain creative tools (#2183). Conductor wrappers over existing
 * Universe Builder entry points — no re-implementation.
 */

import { z } from 'zod';
import { createUniverse } from '../../universeBuilder.js';
import { expandWorldTemplate } from '../../universeBuilderExpand.js';
import { renderUniverseJobs } from '../../universeBuilderRender.js';
import { COST_FREE, COST_LLM, COST_RENDER } from './shared.js';

export const UNIVERSE_TOOLS = [
  {
    name: 'universe.createUniverse',
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
    name: 'universe.expandWorldTemplate',
    description: 'Expand a starter prompt into a universe bible (logline, premise, style, canon) via the configured LLM. Returns the parsed bible; does not persist.',
    costClass: COST_LLM,
    schema: z.object({ starterPrompt: z.string().min(1) }).passthrough(),
    parameters: {
      type: 'object',
      properties: {
        starterPrompt: { type: 'string', description: 'Seed prompt describing the world to expand.' },
        influences: { type: 'string', description: 'Optional comma-separated stylistic influences.' },
        providerId: { type: 'string', description: 'Optional LLM provider override.' },
        model: { type: 'string', description: 'Optional model override.' },
      },
      required: ['starterPrompt'],
    },
    execute: (args) => expandWorldTemplate(args),
  },
  {
    name: 'universe.renderUniverseJobs',
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
    // mapServiceError is an identity rethrow — the dispatcher owns error surfacing.
    execute: ({ universeId, body }) => renderUniverseJobs(universeId, body || {}, (err) => err),
  },
];
