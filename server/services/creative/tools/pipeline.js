/**
 * Pipeline-domain creative tools (#2183). Conductor wrappers over the existing
 * comic/story production pipeline entry points, including running the Series
 * Autopilot as one orchestrated step.
 */

import { z } from 'zod';
import { createSeries } from '../../pipeline/series.js';
import { generateSeriesConcept } from '../../pipeline/seriesGenerate.js';
import { generateStage } from '../../pipeline/textStages.js';
import { startSeriesAutopilot } from '../../pipeline/seriesAutopilot.js';
import {
  renderComicCover,
  renderComicBackCover,
  renderVolumeCover,
  renderVolumeBackCover,
} from '../../pipeline/visualStages.js';
import { COST_FREE, COST_LLM, COST_RENDER } from './shared.js';

// Shared render-option schema for the cover-render tools — mirrors the route's
// makeCoverRenderSchema (routes/pipeline/covers.js) so the orchestrator flows
// the same image-gen knobs the UI drawer does. Each tool merges its own script
// field (coverScript / backCoverScript) on top. The `renderXxx` services
// enqueue AND persist the in-flight render slot the filename hook needs (#2220),
// so an orchestrated cover completes exactly like a user-driven one — the bare
// `enqueueComicCover` was deliberately kept off the registry because it only
// queued the job and dropped the completed render.
const coverRenderOptionsShape = {
  negativePrompt: z.string().max(2000).optional(),
  extraStyle: z.string().max(2000).optional(),
  mode: z.enum(['local', 'codex']).optional(),
  modelId: z.string().max(64).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  target: z.enum(['proof', 'final']).optional(),
  useProofAsBase: z.boolean().optional(),
};

// OpenAI-function `parameters` fragment mirroring coverRenderOptionsShape so the
// orchestrator sees the render knobs it can pass.
const coverRenderParamProps = {
  negativePrompt: { type: 'string', description: 'Negative prompt tokens.' },
  extraStyle: { type: 'string', description: 'Extra style direction appended to the prompt.' },
  mode: { type: 'string', enum: ['local', 'codex'], description: 'Image-gen mode (defaults to the configured mode).' },
  modelId: { type: 'string', description: 'Image model id override.' },
  width: { type: 'integer', description: 'Render width in px.' },
  height: { type: 'integer', description: 'Render height in px.' },
  steps: { type: 'integer', description: 'Sampler steps.' },
  cfgScale: { type: 'number', description: 'CFG scale.' },
  guidance: { type: 'number', description: 'Guidance scale.' },
  seed: { type: 'integer', description: 'Deterministic seed.' },
  target: { type: 'string', enum: ['proof', 'final'], description: "Variant to render — 'proof' (fast layout) or 'final' (hi-res). Defaults to 'proof'." },
  useProofAsBase: { type: 'boolean', description: "For target=final: upscale off this slot's existing proof (i2i)." },
};

export const PIPELINE_TOOLS = [
  {
    name: 'pipeline_createSeries',
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
    name: 'pipeline_generateSeriesConcept',
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
    name: 'pipeline_generateStage',
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
    name: 'pipeline_startSeriesAutopilot',
    description: 'Start (or no-op resume) the Series Autopilot for a series. Long-running: returns a run handle; progress and pauses arrive via events. Autopilot has its own cos-off gate; the orchestrator gate applies first.',
    costClass: COST_LLM,
    longRunning: true,
    // Self-budgeting: the autopilot budget-gates and records each of its own
    // LLM/render steps against the cos budget internally, so the dispatcher must
    // NOT also charge one action for the start call (see dispatchCreativeTool).
    selfBudgeted: true,
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
  {
    name: 'pipeline_renderComicCover',
    description: "Enqueue AND persist a comic-issue FRONT cover render. Long-running: returns { jobId, ... }; the finished image attaches to stages.comicPages.cover via the media-job filename hook. Pass coverScript to set/update the persisted cover concept in the same call.",
    costClass: COST_RENDER,
    longRunning: true,
    schema: z.object({ issueId: z.string().min(1), coverScript: z.string().max(8000).optional(), ...coverRenderOptionsShape }),
    parameters: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Comic issue id.' },
        coverScript: { type: 'string', description: 'Cover-art concept text; absent preserves the persisted script, empty string clears it.' },
        ...coverRenderParamProps,
      },
      required: ['issueId'],
    },
    execute: ({ issueId, ...options }) => renderComicCover(issueId, options),
  },
  {
    name: 'pipeline_renderComicBackCover',
    description: "Enqueue AND persist a comic-issue BACK cover render. Long-running: the finished image attaches to stages.comicPages.backCover via the filename hook. Pass backCoverScript to set/update the persisted back-cover concept.",
    costClass: COST_RENDER,
    longRunning: true,
    schema: z.object({ issueId: z.string().min(1), backCoverScript: z.string().max(8000).optional(), ...coverRenderOptionsShape }),
    parameters: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Comic issue id.' },
        backCoverScript: { type: 'string', description: 'Back-cover concept text; absent preserves, empty string clears.' },
        ...coverRenderParamProps,
      },
      required: ['issueId'],
    },
    execute: ({ issueId, ...options }) => renderComicBackCover(issueId, options),
  },
  {
    name: 'pipeline_renderVolumeCover',
    description: "Enqueue AND persist a volume (season) FRONT cover render. Long-running: the finished image attaches to series.seasons[].cover via the season-cover filename hook. Pass coverScript to set/update the persisted concept.",
    costClass: COST_RENDER,
    longRunning: true,
    schema: z.object({ seriesId: z.string().min(1), seasonId: z.string().min(1), coverScript: z.string().max(8000).optional(), ...coverRenderOptionsShape }),
    parameters: {
      type: 'object',
      properties: {
        seriesId: { type: 'string', description: 'Series id.' },
        seasonId: { type: 'string', description: 'Season (volume) id on the series.' },
        coverScript: { type: 'string', description: 'Cover-art concept text; absent preserves, empty string clears.' },
        ...coverRenderParamProps,
      },
      required: ['seriesId', 'seasonId'],
    },
    execute: ({ seriesId, seasonId, ...options }) => renderVolumeCover(seriesId, seasonId, options),
  },
  {
    name: 'pipeline_renderVolumeBackCover',
    description: "Enqueue AND persist a volume (season) BACK cover render. Long-running: the finished image attaches to series.seasons[].backCover via the season-cover filename hook. Pass backCoverScript to set/update the persisted concept.",
    costClass: COST_RENDER,
    longRunning: true,
    schema: z.object({ seriesId: z.string().min(1), seasonId: z.string().min(1), backCoverScript: z.string().max(8000).optional(), ...coverRenderOptionsShape }),
    parameters: {
      type: 'object',
      properties: {
        seriesId: { type: 'string', description: 'Series id.' },
        seasonId: { type: 'string', description: 'Season (volume) id on the series.' },
        backCoverScript: { type: 'string', description: 'Back-cover concept text; absent preserves, empty string clears.' },
        ...coverRenderParamProps,
      },
      required: ['seriesId', 'seasonId'],
    },
    execute: ({ seriesId, seasonId, ...options }) => renderVolumeBackCover(seriesId, seasonId, options),
  },
];
