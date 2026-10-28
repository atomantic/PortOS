import { z } from 'zod';

const physicalIdentitySchema = z.object({ dev: z.string(), ino: z.string(), birthtimeNs: z.string() });
export const checkoutSeedSchema = z.object({ version: z.literal(1), agentId: z.string(), startedAt: z.string().datetime(),
  seededAt: z.string().datetime(), repoPath: z.string(), branch: z.string(), path: z.string(),
  repository: physicalIdentitySchema, checkout: physicalIdentitySchema,
  incarnation: z.object({ pointer: physicalIdentitySchema,
    gitdir: z.object({ path: z.string(), dev: z.string(), ino: z.string(), birthtimeNs: z.string() }) }) });
