/**
 * Story-builder-domain creative tools (#2183). Conductor wrappers over the
 * existing Story Builder entry points.
 */

import { z } from 'zod';
import { createStorySession, generateStep, generateIssuesFromArc } from '../../storyBuilder.js';
import { COST_FREE, COST_LLM } from './shared.js';

export const STORY_BUILDER_TOOLS = [
  {
    name: 'storyBuilder.createStorySession',
    description: 'Create a new story-builder session (optionally minting a universe/series from the title + seed). Persists the session; returns its id.',
    costClass: COST_FREE,
    // The wrapped service requires a non-empty `title` (it doubles as the minted
    // universe/series name); other fields are optional passthrough.
    schema: z.object({ title: z.string().min(1) }).passthrough(),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Session title (also used as the minted universe/series name).' },
        seedIdea: { type: 'string', description: 'Optional seed idea that seeds the universe starter prompt.' },
        universeId: { type: 'string', description: 'Optional existing universe to attach to (instead of minting one).' },
        seriesId: { type: 'string', description: 'Optional existing series to attach to.' },
        intakeMode: { type: 'string', description: "Intake mode (default 'seed')." },
      },
      required: ['title'],
    },
    execute: (args) => createStorySession(args),
  },
  {
    name: 'storyBuilder.generateStep',
    description: 'Generate one story-builder step (LLM) for a session and persist the result.',
    costClass: COST_LLM,
    schema: z.object({ id: z.string().min(1), stepId: z.string().min(1), options: z.record(z.any()).optional() }),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Story session id.' },
        stepId: { type: 'string', description: 'Step id to generate.' },
        options: { type: 'object', description: 'Optional generation options (providerId, model).' },
      },
      required: ['id', 'stepId'],
    },
    execute: ({ id, stepId, options }) => generateStep(id, stepId, options || {}),
  },
  {
    name: 'storyBuilder.generateIssuesFromArc',
    description: 'Generate the issue breakdown for a story arc (LLM). Long-running: creates multiple issue records.',
    costClass: COST_LLM,
    longRunning: true,
    schema: z.object({ id: z.string().min(1), options: z.record(z.any()).optional() }),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Story session id.' },
        options: { type: 'object', description: 'Optional generation options.' },
      },
      required: ['id'],
    },
    execute: ({ id, options }) => generateIssuesFromArc(id, options || {}),
  },
];
