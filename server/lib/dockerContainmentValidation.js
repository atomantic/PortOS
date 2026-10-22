/**
 * Route schemas for Docker containment (#12844): the machine-local
 * `dockerContainment` settings slice and the run/pull request bodies. Kept out
 * of `validation.js` so the containment profile does not join that module's
 * very wide import closure.
 */
import { z } from 'zod';
import { DOCKER_CONTAINMENT_PHASES, isDigestPinnedImage, isEgressHostname } from './dockerContainment.js';

/**
 * Limits, extra egress hosts and image overrides. Host-control: an override
 * picks the image untrusted code runs in and extra hosts widen install
 * egress, so `PUT /api/settings` gates the whole slice
 * (`HOST_CONTROL_SETTINGS_SLICES`).
 */
export const dockerContainmentSettingsSchema = z.object({
  limits: z.object({
    cpus: z.number().min(0.5).max(64).optional(),
    memoryMb: z.number().int().min(512).max(65_536).optional(),
    pids: z.number().int().min(64).max(32_768).optional(),
    wallTimeoutMinutes: z.number().int().min(1).max(240).optional(),
  }).strict().optional(),
  extraEgressHosts: z.array(z.string().trim().toLowerCase().refine(isEgressHostname, 'must be a DNS host name (no scheme, port, path or IP literal)')).max(50).optional(),
  imageOverrides: z.record(
    z.string().regex(/^\d{1,3}$/, 'keys are Node major versions'),
    z.string().refine(isDigestPinnedImage, 'must be an image reference pinned by @sha256 digest'),
  ).optional(),
}).strict();

export const dockerContainmentRunSchema = z.object({
  worktree: z.string().min(1).max(4096).refine((path) => path.startsWith('/'), 'worktree must be an absolute path'),
  phase: z.enum(DOCKER_CONTAINMENT_PHASES),
  command: z.string().trim().min(1).max(4000),
  timeoutMinutes: z.number().int().min(1).max(240).optional(),
}).strict();

export const dockerContainmentPullSchema = z.object({
  major: z.number().int().min(1).max(999),
}).strict();
