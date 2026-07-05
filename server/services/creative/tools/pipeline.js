/**
 * Pipeline-domain creative tools (#2183). Conductor wrappers over the existing
 * comic/story production pipeline entry points, including running the Series
 * Autopilot as one orchestrated step.
 */

import { z } from 'zod';
import { createSeries } from '../../pipeline/series.js';
import { generateSeriesConcept } from '../../pipeline/seriesGenerate.js';
import { generateStage } from '../../pipeline/textStages.js';
import { enqueueComicCover } from '../../pipeline/visualStages.js';
import { startSeriesAutopilot } from '../../pipeline/seriesAutopilot.js';
import { COST_FREE, COST_LLM, COST_RENDER } from './shared.js';

export const PIPELINE_TOOLS = [
  {
    name: 'pipeline.createSeries',
    description: 'Create a new pipeline series record. Persists a record; returns it.',
    costClass: COST_FREE,
    // The wrapped service rejects a missing/blank `name`; require it here so a
    // bad orchestrator call fails the gate instead of the service.
    schema: z.object({ name: z.string().min(1) }).passthrough(),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Series name (required).' },
        universeId: { type: 'string', description: 'Optional universe to attach the series to.' },
        premise: { type: 'string', description: 'Optional series premise.' },
      },
      required: ['name'],
    },
    execute: (args) => createSeries(args),
  },
  {
    name: 'pipeline.generateSeriesConcept',
    description: 'Generate a series concept (name, logline, premise, shape) for a universe via the LLM.',
    costClass: COST_LLM,
    schema: z.object({ universeId: z.string().min(1), options: z.record(z.any()).optional() }),
    parameters: {
      type: 'object',
      properties: {
        universeId: { type: 'string', description: 'Universe id to derive a concept from.' },
        options: { type: 'object', description: 'Optional generation options.' },
      },
      required: ['universeId'],
    },
    execute: ({ universeId, options }) => generateSeriesConcept(universeId, options || {}),
  },
  {
    name: 'pipeline.generateStage',
    description: 'Generate one text stage (LLM) for a pipeline issue and persist the updated issue.',
    costClass: COST_LLM,
    schema: z.object({ issueId: z.string().min(1), stageId: z.string().min(1), options: z.record(z.any()).optional() }),
    parameters: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue id.' },
        stageId: { type: 'string', description: 'Stage id to generate.' },
        options: { type: 'object', description: 'Optional generation options.' },
      },
      required: ['issueId', 'stageId'],
    },
    execute: ({ issueId, stageId, options }) => generateStage(issueId, stageId, options || {}),
  },
  {
    name: 'pipeline.enqueueComicCover',
    description: 'Enqueue a comic-cover image render for an issue. Long-running: returns a job handle; completion arrives via media-job events.',
    costClass: COST_RENDER,
    longRunning: true,
    schema: z.object({ issueId: z.string().min(1), options: z.record(z.any()).optional() }),
    parameters: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue id to render a cover for.' },
        options: { type: 'object', description: 'Optional cover render options (variant, fromProof).' },
      },
      required: ['issueId'],
    },
    execute: ({ issueId, options }) => enqueueComicCover(issueId, options || {}),
  },
  {
    name: 'pipeline.startSeriesAutopilot',
    description: 'Start (or no-op resume) the Series Autopilot for a series. Long-running: returns a run handle; progress and pauses arrive via events. Autopilot has its own cos-off gate; the orchestrator gate applies first.',
    costClass: COST_LLM,
    longRunning: true,
    schema: z.object({ seriesId: z.string().min(1), options: z.record(z.any()).optional() }),
    parameters: {
      type: 'object',
      properties: {
        seriesId: { type: 'string', description: 'Series id to run the autopilot on.' },
        options: { type: 'object', description: 'Optional autopilot run options.' },
      },
      required: ['seriesId'],
    },
    execute: ({ seriesId, options }) => startSeriesAutopilot(seriesId, options || {}),
  },
];
