/**
 * Creative-Director-domain creative tools (CDO Phase 3, #2185). The
 * pipeline/autopilot → Creative Director direction of the bridge: mint + start a
 * fresh CD teaser/trailer video project seeded from a pipeline issue. Wraps the
 * `produceVideoFromIssue` conductor (createProject + setTreatment + auto-cast +
 * start — never mutates an existing project's treatment, the #842 rule).
 */

import { z } from 'zod';
import { produceVideoFromIssue } from '../../creativeDirector/bridgeFromIssue.js';
import { COST_LLM } from './shared.js';

export const CD_TOOLS = [
  {
    name: 'cd_produceVideoFromIssue',
    description:
      'Mint AND start a fresh Creative Director teaser/trailer video project seeded from a pipeline issue. '
      + 'Generates a treatment from the issue\'s prose/script + series canon, auto-casts the series ingredients, links the source issue (for the music bed), and kicks off rendering. '
      + 'Non-destructive: always creates a NEW project, never overwrites an existing one. Costs one LLM call for the treatment; the project\'s renders proceed asynchronously.',
    costClass: COST_LLM,
    schema: z.object({
      issueId: z.string().min(1),
      name: z.string().max(200).optional(),
      aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
      quality: z.enum(['draft', 'standard', 'high']).optional(),
      targetDurationSeconds: z.number().int().min(5).max(600).optional(),
    }),
    parameters: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Pipeline issue id to seed the teaser from (required).' },
        name: { type: 'string', description: 'Project name (defaults to "<issue title> — Teaser").' },
        aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'Video aspect ratio (default 16:9).' },
        quality: { type: 'string', enum: ['draft', 'standard', 'high'], description: 'Render quality (default standard).' },
        targetDurationSeconds: { type: 'integer', description: 'Target teaser length in seconds (5–600, default 60).' },
      },
      required: ['issueId'],
    },
    execute: ({ issueId, ...options }) => produceVideoFromIssue(issueId, options),
  },
];
