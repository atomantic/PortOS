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
