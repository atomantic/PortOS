/**
 * Media-domain creative tools (#2183). Conductor wrappers over the media job
 * queue. Each enqueue tags the job's `owner` back to the calling project so the
 * orchestration's renders are attributable via `listJobs({ owner })`.
 */

import { z } from 'zod';
import { enqueueJob } from '../../mediaJobQueue/index.js';
import { COST_RENDER, resolveOwner } from './shared.js';

const paramsSchema = z.object({ params: z.record(z.any()).default({}), owner: z.string().optional() });

const mediaTool = (kind, label) => ({
  name: `media.enqueue${label}Job`,
  description: `Enqueue a ${kind} media job. Long-running: returns a job handle; completion arrives via media-job events. Tags the job owner to the calling project.`,
  costClass: COST_RENDER,
  longRunning: true,
  schema: paramsSchema,
  parameters: {
    type: 'object',
    properties: {
      params: { type: 'object', description: `Job parameters for the ${kind} worker.` },
      owner: { type: 'string', description: 'Optional explicit owner tag (defaults to the calling project).' },
    },
    required: ['params'],
  },
  execute: (args, ctx) => enqueueJob({ kind, params: args.params || {}, owner: resolveOwner(args, ctx) }),
});

export const MEDIA_TOOLS = [
  mediaTool('image', 'Image'),
  mediaTool('video', 'Video'),
  mediaTool('audio', 'Audio'),
];
