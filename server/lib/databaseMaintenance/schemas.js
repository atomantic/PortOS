/** Schemas for durable cutover stages, ownership and evidence. */
import { z } from 'zod';

export const databaseMaintenanceEndpointSchema = z.object({
  mode: z.enum(['native', 'docker']),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(63),
  user: z.string().min(1).max(63),
}).strict();

export const stages = ['accepted', 'quiescing', 'exporting', 'importing', 'committing', 'verifying', 'verified'];

export const journalSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  stage: z.enum(stages),
  createdAt: z.string().datetime(),
  source: databaseMaintenanceEndpointSchema,
  target: databaseMaintenanceEndpointSchema,
}).strict();

export const coordinatorSchema = z.object({
  id: z.string().uuid(),
  token: z.string().uuid(),
}).strict();
export const successorSchema = coordinatorSchema.extend({ previousToken: z.string().uuid() });
export const producerSnapshotSchema = z.object({
  id: z.string().uuid(),
  producers: z.array(z.object({
    name: z.enum(['portos-cos', 'portos-server']),
    pmId: z.number().int().nonnegative(), pid: z.number().int().nonnegative(),
    cwd: z.string().min(1), script: z.string().min(1),
    status: z.enum(['online', 'stopped']),
  }).strict()).length(2),
}).strict();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
// Transfer evidence. The dump name is derived from the operation, never a path
// chosen by a caller, so a manifest cannot point the import anywhere else.
export const transferDumpSchema = z.object({
  id: z.string().uuid(),
  source: databaseMaintenanceEndpointSchema,
  file: z.string().regex(/^portos-maintenance-[0-9a-f-]{36}\.sql$/),
  bytes: z.number().int().positive(),
  sha256: sha256Schema,
}).strict();
export const transferImportSchema = z.object({
  id: z.string().uuid(),
  target: databaseMaintenanceEndpointSchema,
  sha256: sha256Schema,
}).strict();
// A restarted ordinary server proved ITS OWN pool reaches the recorded target.
// Evidence, not authority: the coordinator accepts it only for the PM2 pid it
// reads back itself AND that process's start time (a reused pid cannot inherit
// an earlier process's proof), and every booting process proves its own pool.
// startedAt is null only on Windows, which has no process-table start time.
export const targetProofSchema = z.object({
  id: z.string().uuid(),
  pid: z.number().int().positive(),
  startedAt: z.number().int().nullable(),
  target: databaseMaintenanceEndpointSchema,
}).strict();
export const recoveryIntentSchema = z.object({
  id: z.string().uuid(),
  previousToken: z.string().uuid(),
  recoveryToken: z.string().uuid(),
}).strict();
export const workerGroupSchema = coordinatorSchema.extend({ pgid: z.number().int().positive() }).strict();
export const decisionSchema = coordinatorSchema.extend({
  stage: z.enum(stages),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('transition'), nextStage: z.enum(stages) }).strict(),
    z.object({ kind: z.literal('recovery'), recoveryToken: z.string().uuid() }).strict(),
  ]),
});
