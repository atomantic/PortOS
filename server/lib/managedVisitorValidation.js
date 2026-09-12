import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const visitorScopeSchema = z.object({ individualId: id, individualSessionId: id, worldId: id, epoch: id }).strict();
export const visitorCancellationSchema = visitorScopeSchema.omit({ epoch: true }).strict();
export const visitorCredentialSchema = z.object({ individualIds: z.array(id).min(1).max(64), worldIds: z.array(id).min(1).max(32),
  ttlMs: z.number().int().min(60000).max(7 * 86400000) }).strict();
export const visitorAdmissionSchema = z.object({ individualId: id, individualSessionId: id, worldId: id,
  body: z.literal('fly-v1'), ttlMs: z.number().int().min(1000).max(300000) }).strict();
export const visitorActionSchema = visitorScopeSchema.extend({ sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  action: z.discriminatedUnion('type', [z.object({ type: z.enum(['start', 'pause', 'rest', 'leave']) }).strict(),
    z.object({ type: z.literal('move'), forward: z.number().min(0).max(0.12), yaw: z.number().min(-0.8).max(0.8), intervalMs: z.literal(5) }).strict()]) }).strict();
export const visitorIdSchema = id;
export const visitorPoseSchema = z.object({ x: z.number().finite().min(-2).max(2), z: z.number().finite().min(-2).max(2),
  yaw: z.number().finite().min(-Math.PI).max(Math.PI) }).strict();
const hostScope = visitorScopeSchema.extend({ version: z.literal(1), appId: id, sessionId: id });
export const visitorHostAdmissionSchema = hostScope.extend({ expiresAt: z.number().int().positive(), status: z.literal('paused'), pose: visitorPoseSchema }).strict();
export const visitorHostObservationSchema = hostScope.extend({ frameId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  capturedAtMs: z.number().int().positive(), sensorySource: z.literal('engineered-gentle-patch-spatial-proxy-v1'), camera: z.literal('controller'), width: z.literal(8), height: z.literal(4),
  rgb: z.array(z.number().int().min(0).max(255)).length(96), pose: visitorPoseSchema }).strict();
export const visitorHostActionSchema = hostScope.extend({ expiresAt: z.number().int().positive(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['running', 'paused', 'resting', 'left']), pose: visitorPoseSchema }).strict();
export const visitorCredentialDocumentSchema = z.object({ schemaVersion: z.literal(1), credentials: z.array(z.object({
  appId: id, digest: z.string().regex(/^[a-f0-9]{64}$/), individualIds: z.array(id).min(1).max(64), worldIds: z.array(id).min(1).max(32),
  createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
}).strict()).max(64) }).strict();
