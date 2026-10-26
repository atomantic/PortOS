import { z } from 'zod';
import { isValidNodePublicKey } from './tailcatAddress.js';

export const tailcatDeviceApprovalSchema = z.object({
  label: z.string().trim().min(1).max(100),
  publicKey: z.string().refine(isValidNodePublicKey, 'Expected a canonical nodekey public key'),
}).strict();
export const tailcatDeviceEnforcementSchema = z.object({ enabled: z.boolean() }).strict();
