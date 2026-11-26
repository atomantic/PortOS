// Zod schemas for instance identity, peer settings, sync, and Tailcat routes.

import { z } from 'zod';
import { DEFAULT_PEER_PORT, DEFAULT_TAILCAT_REMOTE_PORT, PORTS } from './ports.js';
import { federatedMediaPeerSettingsSchema } from './federatedMediaValidation.js';
import { isBlockedIngestHost } from './safeUrlFetch.js';
import { optionalBooleanMap } from './zodCompat.js';
import { DEFAULT_SYNC_CATEGORIES } from './instanceSyncCategories.js';
import { isValidTcAddress } from './tailcatAddress.js';

export const instanceIdSchema = z.string().guid();

// Optional HTTP Basic credential for a peer behind an auth proxy. `null` clears
// it; an object sets it. The service's sanitizePeerAuth does the final
// normalize: the password is the secret that defines the credential, so a
// payload with a password stores it (username optional — password-only is
// valid Basic auth), both fields blank is a clear, and a username-only payload
// is ignored (it's most likely a redacted client peer being round-tripped, and
// must not wipe a stored password).
const peerAuthSchema = z.object({
  username: z.string().max(256).optional(),
  password: z.string().max(2048).optional()
}).nullable().optional();

export const addPeerSchema = z.object({
  address: z.string()
    .regex(/^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/, 'Must be a valid IP address')
    .refine(ip => !isBlockedIngestHost(ip), 'Loopback, unspecified and link-local addresses are not allowed'),
  port: z.number().int().min(1).max(65535).default(DEFAULT_PEER_PORT),
  name: z.string().optional(),
  host: z.string().optional(),
  auth: peerAuthSchema
});

// Derive accepted keys from the shared category defaults so new categories survive validation.
const syncCategoriesSchema = z.object(
  optionalBooleanMap(Object.keys(DEFAULT_SYNC_CATEGORIES))
).optional();

export const updatePeerSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  syncEnabled: z.boolean().optional(),
  // Full-sync ("mirror everything") mode: implies every current + future sync
  // category and back-subscribes all subscribable records to this peer.
  fullSync: z.boolean().optional(),
  syncCategories: syncCategoriesSchema,
  // How Media Collection bytes arrive from this peer (mirrors MEDIA_SYNC_MODES
  // in services/instances.js): copied locally or hosted
  // by the peer and streamed on demand.
  mediaSyncMode: z.enum(['copy', 'host']).optional(),
  // Standing grant: this paired peer may delete media on this machine (default on).
  mediaDeleteAllowed: z.boolean().optional(),
  // Accept empty string to clear; any other string is validated/normalized in the service
  host: z.string().optional().nullable(),
  auth: peerAuthSchema,
  // Explicit consumer opt-in + model allowlist for using this peer as a media
  // provider. Provider-side sharing remains independently configured there.
  mediaProvider: federatedMediaPeerSettingsSchema.optional(),
  syncSecret: z.string().min(32).max(256).nullable().optional(),
});

export const announceSchema = z.object({
  port: z.number().int().min(1).max(65535),
  instanceId: instanceIdSchema,
  name: z.string().optional(),
  // Tailscale-issued DNS name announcing peer reaches itself at; receiver
  // stores it on the peer record so callbacks use https://<host>:<port>.
  host: z.string().optional().nullable()
});

export const querySchema = z.object({
  path: z.string().startsWith('/api/', 'Path must start with /api/')
});

// Reciprocal sync request from a peer: it enabled `syncCategories` toward us
// and asks us to mirror them so the sync is bidirectional. instanceId is the
// announcing peer's identity (matched against our peer record).
export const reciprocalSyncSchema = z.object({
  instanceId: instanceIdSchema,
  // `.unwrap()` strips the `.optional()` from the shared schema so the
  // syncCategories KEY is required. An empty `{}` still parses (all fields are
  // optional) and simply no-ops downstream in applyReciprocalSync
  // (sanitizeSyncCategories returns null → changed:false).
  syncCategories: syncCategoriesSchema.unwrap(),
  // Optional: a full-sync peer asks us to mirror everything back. Absent from
  // older peers (they reciprocate via the all-on syncCategories map instead).
  fullSync: z.boolean().optional()
});

export const pairSecretSchema = z.object({ syncSecret: z.string().min(32).max(256) });

// Older peers may send a non-GUID cursor key. Absent, blank, or repeated values use the unscoped status.
export const syncStatusQuerySchema = z.object({
  forPeer: z.preprocess(
    (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, 128) : undefined),
    z.string().optional()
  )
});

export const updateSelfSchema = z.object({
  name: z.string().min(1).optional(),
  // Default full-sync ("mirror everything") mode for peers added from now on.
  defaultPeerFullSync: z.boolean().optional()
}).refine((d) => d.name !== undefined || d.defaultPeerFullSync !== undefined, {
  message: 'Provide name and/or defaultPeerFullSync'
});

export const addTailcatPeerSchema = z.object({
  tcAddress: z.string().trim().min(24).max(2048),
  protocol: z.enum(['http', 'https']).default('http'),
  name: z.string().optional(),
  auth: peerAuthSchema,
  remotePort: z.number().int().min(1).max(65535).default(DEFAULT_TAILCAT_REMOTE_PORT),
});

export const retryTailcatForwardSchema = z.object({
  remotePort: z.number().int().min(1).max(65535).optional(),
  tcAddress: z.string().trim().min(24).max(2048).refine(isValidTcAddress, 'Invalid Tailcat address').optional(),
});

export const ensureTailcatServeSchema = z.object({
  localPort: z.literal(PORTS.TAILCAT_INGRESS).optional(),
  keyName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
});
