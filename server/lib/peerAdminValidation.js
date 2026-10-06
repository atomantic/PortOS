import { z } from 'zod';

// Planning v1 is deliberately not an execution grant. A future executor must
// require a new operator confirmation, never promote these grants on upgrade.
export const PEER_ADMIN_SCOPE = 'planning-v1';
export const PEER_ADMIN_ACTIONS = ['portos.update', 'portos.restart', 'catalog.install'];
export const peerAdminActionSchema = z.enum(PEER_ADMIN_ACTIONS);
const uuid = z.string().uuid();
const peerId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
export const peerAdminPeerSchema = z.object({ peerId }).strict();
export const peerAdminGrantSchema = z.object({
  peerId,
  action: peerAdminActionSchema,
  confirmedHostInstanceId: uuid,
  confirmedPeerInstanceId: uuid,
  previousGrantId: uuid.nullable(),
  expiresInMinutes: z.number().int().min(1).max(1440),
  allowPlanning: z.boolean(),
}).strict();
export const peerAdminIntentSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('portos.update') }).strict(),
  z.object({ action: z.literal('portos.restart') }).strict(),
  z.object({
    action: z.literal('catalog.install'),
    backend: z.enum(['ollama', 'lmstudio']),
    catalogKey: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
  }).strict(),
]);
export const peerAdminPreflightSchema = z.object({
  protocolVersion: z.literal(1),
  challenge: uuid,
  intent: peerAdminIntentSchema,
}).strict();
export const peerAdminPlanSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: uuid,
  preflightId: uuid,
  grantId: uuid,
  intent: peerAdminIntentSchema,
}).strict();
export const peerAdminReceiptSchema = z.object({ requestId: uuid }).strict();
export const peerAdminRemotePlanSchema = z.object({ peerId, intent: peerAdminIntentSchema }).strict();

// Independent confirmation: planning records never authorize execution.
export const PEER_EXECUTION_SCOPE = 'execution-v1';
export const peerExecutionGrantSchema = peerAdminGrantSchema.omit({ allowPlanning: true }).extend({
  allowExecution: z.boolean(), confirmation: z.literal(PEER_EXECUTION_SCOPE),
}).strict();
export const peerExecutionPreflightSchema = z.object({ protocolVersion: z.literal(1), requestId: uuid, intent: peerAdminIntentSchema }).strict();
export const peerExecutionDispatchSchema = peerExecutionPreflightSchema.extend({
  grantId: uuid, grantGeneration: z.number().int().positive().safe(),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/), executionEpoch: uuid,
  version: z.string().min(1).max(100),
}).strict();
export const peerExecutionPreflightPayloadSchema = peerExecutionDispatchSchema.extend({
  scope: z.literal(PEER_EXECUTION_SCOPE), senderInstanceId: uuid, targetInstanceId: uuid,
  expiresAt: z.number().int().positive().safe(),
}).strict();
export const peerExecutionRemoteDispatchSchema = peerAdminPeerSchema.extend({
  preflight: z.object({ payload: peerExecutionPreflightPayloadSchema, signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();
export const peerExecutionRemoteStatusSchema = peerAdminPeerSchema.extend({ requestId: uuid }).strict();

export const peerExecutionReceiptPayloadSchema = z.object({
  protocolVersion: z.literal(1), scope: z.literal(PEER_EXECUTION_SCOPE), requestId: uuid,
  senderInstanceId: uuid, targetInstanceId: uuid, operationId: uuid,
  state: z.enum(['queued', 'draining', 'in-flight', 'awaiting-reconnect', 'succeeded', 'failed', 'uncertain']),
  revision: z.number().int().positive().safe(), code: z.string().regex(/^[A-Z0-9_]{1,100}$/).nullable(),
}).strict();
