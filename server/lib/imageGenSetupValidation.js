// Zod request schemas for the image gen setup routes.

import { z } from 'zod';
import { HF_TOKEN_REGEX } from './hfTokenFormat.js';

// Save the HF token from the inline form on the Image Gen page. settings.json
// is the canonical location (single-user app behind Tailscale — see AGENTS.md).
// Same endpoint serves FLUX.2 and legacy mflux gated models — the token is
// global (HF_TOKEN env in spawn).
export const hfTokenSchema = z.object({
  token: z.string().regex(HF_TOKEN_REGEX, 'Token must look like `hf_…`').max(200),
});

export const checkSchema = z.object({ pythonPath: z.string().min(1) });

export const venvSchema = z.object({
  basePython: z.string().min(1).optional(),
});

export const installSchema = z.object({
  pythonPath: z.string().min(1),
  packages: z.array(z.string().min(1)).min(1).max(40),
});

export const installQuerySchema = z.object({ pythonPath: z.string().optional(), packages: z.string().optional() });

export const flux2QuerySchema = z.object({ modelId: z.string().optional() });

export const flux3RuntimeQuerySchema = z.object({ runtime: z.literal('flux3') }).strict();

export const mossRuntimeQuerySchema = z.object({ runtime: z.literal('moss-swift').optional() }).strict();
