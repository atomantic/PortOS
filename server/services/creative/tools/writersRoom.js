/**
 * Writers-room-domain creative tools (#2183). Conductor wrappers over the
 * existing Writers Room entry points.
 */

import { z } from 'zod';
import { createWork } from '../../writersRoom/local.js';
import { runAnalysis } from '../../writersRoom/evaluator.js';
import { COST_FREE, COST_LLM } from './shared.js';

export const WRITERS_ROOM_TOOLS = [
  {
    name: 'writersRoom.createWork',
    description: 'Create a new writers-room work (short-story, novel, etc.). Persists a manifest; returns it.',
    costClass: COST_FREE,
    schema: z.object({ title: z.string().min(1), folderId: z.string().nullish(), kind: z.string().optional() }),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Work title.' },
        folderId: { type: 'string', description: 'Optional parent folder id.' },
        kind: { type: 'string', description: "Work kind (default 'short-story')." },
      },
      required: ['title'],
    },
    execute: ({ title, folderId, kind }) => createWork({ title, folderId: folderId ?? null, kind }),
  },
  {
    name: 'writersRoom.runAnalysis',
    description: 'Run an editorial analysis pass (LLM) over a writers-room work and persist the result.',
    costClass: COST_LLM,
    schema: z.object({ workId: z.string().min(1), kind: z.string().optional() }),
    parameters: {
      type: 'object',
      properties: {
        workId: { type: 'string', description: 'Work id to analyze.' },
        kind: { type: 'string', description: 'Analysis kind.' },
      },
      required: ['workId'],
    },
    execute: ({ workId, kind }) => runAnalysis(workId, { kind }),
  },
];
