import { z } from 'zod';

export const FEDERATED_MEDIA_WIRE_VERSION = 1;
export const FEDERATED_MEDIA_STALE_AFTER_MS = 60_000;
export const FEDERATED_MEDIA_MAX_CLOCK_SKEW_MS = 30_000;

const FEDERATED_AUDIO_STYLES = [
  'ambient', 'cinematic', 'classical', 'electronic', 'folk', 'hip-hop',
  'jazz', 'metal', 'orchestral', 'pop', 'rock', 'synthwave',
];
const FEDERATED_AUDIO_MOODS = [
  'bright', 'calm', 'dark', 'dreamy', 'energetic', 'hopeful',
  'melancholic', 'mysterious', 'playful', 'tense', 'triumphant', 'warm',
];
const FEDERATED_AUDIO_INSTRUMENTS = [
  'acoustic-guitar', 'bass', 'brass', 'cello', 'drums', 'electric-guitar',
  'flute', 'piano', 'strings', 'synthesizer', 'violin', 'woodwinds',
];

// Free-form text can contain PII and therefore cannot cross the federation
// boundary. Consumers select only these fixed musical descriptors; the remote
// adapter renders the provider prompt locally from this validated profile.
export const federatedMediaAudioProfileSchema = z.object({
  style: z.enum(FEDERATED_AUDIO_STYLES),
  mood: z.enum(FEDERATED_AUDIO_MOODS),
  tempo: z.enum(['slow', 'moderate', 'fast']).default('moderate'),
  energy: z.enum(['low', 'medium', 'high']).default('medium'),
  instruments: z.array(z.enum(FEDERATED_AUDIO_INSTRUMENTS)).max(6).default([])
    .refine((items) => new Set(items).size === items.length, {
      message: 'instruments must not contain duplicates',
    }),
}).strict();

const words = (value) => value.replaceAll('-', ' ');
const styleByWords = new Map(FEDERATED_AUDIO_STYLES.map((value) => [words(value), value]));
const instrumentByWords = new Map(FEDERATED_AUDIO_INSTRUMENTS.map((value) => [words(value), value]));
const AUDIO_PROMPT_RE = /^Instrumental ([a-z ]+) music with a ([a-z]+) mood, (slow|moderate|fast) tempo, (low|medium|high) energy(?:, featuring ([a-z ]+(?: and [a-z ]+){0,5}))?\. No vocals or spoken words\.$/;

/**
 * Render a validated audio profile into a canonical prompt string.
 * Free-form text cannot cross the federation boundary (PII safety); consumers
 * send validated enum profiles, which this function formats into deterministic prompt prose.
 *
 * @param {object} profile - Audio profile conforming to federatedMediaAudioProfileSchema.
 * @returns {string|null} Canonical prompt string, or null if profile fails validation.
 */
export function renderFederatedMediaAudioPrompt(profile) {
  const parsed = federatedMediaAudioProfileSchema.safeParse(profile);
  if (!parsed.success) return null;
  const { style, mood, tempo, energy, instruments } = parsed.data;
  const instrumentation = instruments.length > 0
    ? `, featuring ${instruments.map(words).join(' and ')}`
    : '';
  return `Instrumental ${words(style)} music with a ${mood} mood, ${tempo} tempo, ${energy} energy${instrumentation}. No vocals or spoken words.`;
}

/**
 * Validate that a prompt string conforms to the canonical federated audio grammar.
 * Provider-side validation receives only the rendered text (not the local profile)
 * so older wire-v1 providers can accept newer consumers. Parses the canonical grammar
 * back into fixed tokens and requires an exact round trip.
 *
 * @param {any} value - Input string to test.
 * @returns {boolean} True if input is a valid federated audio prompt string.
 */
export function isFederatedMediaAudioPrompt(value) {
  if (typeof value !== 'string') return false;
  const match = AUDIO_PROMPT_RE.exec(value);
  if (!match) return false;
  const style = styleByWords.get(match[1]);
  const instruments = match[5]
    ? match[5].split(' and ').map((item) => instrumentByWords.get(item))
    : [];
  if (!style || instruments.some((item) => !item)) return false;
  return renderFederatedMediaAudioPrompt({
    style,
    mood: match[2],
    tempo: match[3],
    energy: match[4],
    instruments,
  }) === value;
}

// Wire v1 started audio-only; image and video share the same capability/job/
// result projection (duration and lyrics fields simply go null/false for
// kinds they don't apply to) rather than forking a second schema shape.
//
// Backward compatibility for kinds an ALREADY-DEPLOYED older consumer cannot
// parse is handled at the transport layer, not by narrowing this enum: an
// older consumer's own copy of this file still validates `kinds`/`capabilities`
// against a literal('audio') schema and can never be patched retroactively, so
// GET /status only reports non-audio kinds when the caller explicitly opts in
// via `?kinds=` (see normalizeRequestedMediaKinds below). A caller that never
// asks — every already-shipped consumer — gets back the exact audio-only shape
// it has always understood.
export const KNOWN_MEDIA_KINDS = Object.freeze(['audio', 'image', 'video']);
const mediaKindSchema = z.enum(KNOWN_MEDIA_KINDS);

/**
 * Parse a requested-kinds value (a comma-separated query string or an array)
 * down to the known, deduplicated subset, defaulting to `['audio']` when the
 * input is absent, empty, or names nothing this build understands. The
 * default is deliberate: an older consumer never sends this parameter, so it
 * always gets the original audio-only status projection.
 */
export function normalizeRequestedMediaKinds(raw) {
  const list = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : [];
  const kinds = [...new Set(list.map((value) => (typeof value === 'string' ? value.trim() : '')))]
    .filter((value) => KNOWN_MEDIA_KINDS.includes(value));
  return kinds.length ? kinds : ['audio'];
}

// { mimeType -> file extension } for the result Content-Disposition header
// and any provider-side filename validation. One source so a new result kind
// can't drift the two.
export const FEDERATED_MEDIA_RESULT_EXTENSION = Object.freeze({
  'audio/wav': 'wav',
  'image/png': 'png',
  'video/mp4': 'mp4',
});

const FEDERATED_MEDIA_RESULT_MIME = Object.freeze({
  audio: 'audio/wav',
  image: 'image/png',
  video: 'video/mp4',
});

const federatedMediaCapabilitySchema = z.object({
  kind: mediaKindSchema,
  engine: z.string().trim().min(1).max(80),
  engineName: z.string().trim().min(1).max(256),
  modelId: z.string().trim().min(1).max(256),
  modelName: z.string().trim().min(1).max(256),
  ready: z.boolean(),
  unavailableReason: z.string().max(120).nullable(),
  runtimeReady: z.boolean(),
  platformSupported: z.boolean(),
  cudaRequired: z.boolean(),
  cudaState: z.enum(['available', 'absent', 'unknown']),
  minDurationSec: z.number().finite().positive().nullable(),
  maxDurationSec: z.number().finite().positive().nullable(),
  defaultDurationSec: z.number().finite().positive().nullable(),
  lyrics: z.boolean(),
  autoDuration: z.boolean(),
});

const federatedMediaQueueStatusSchema = z.object({
  totalActive: z.number().int().nonnegative(),
  providerActive: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  maxQueuedJobs: z.number().int().positive(),
  accepting: z.boolean(),
});

// Strip unknown fields from peer responses before persisting or exposing them
// locally. Mixed-version compatibility lives in the versioned route and the
// known-field schema; an older consumer must not relay an unreviewed future
// status field (especially creative metadata) into its own client payload.
export const federatedMediaProviderStatusSchema = z.object({
  wireVersion: z.literal(FEDERATED_MEDIA_WIRE_VERSION),
  generatedAt: z.string().datetime(),
  staleAfterMs: z.number().int().positive().max(300_000),
  status: z.enum(['ready', 'busy', 'unavailable']),
  kinds: z.array(mediaKindSchema).max(KNOWN_MEDIA_KINDS.length),
  queue: federatedMediaQueueStatusSchema,
  capabilities: z.array(federatedMediaCapabilitySchema).max(300),
}).superRefine((value, ctx) => {
  const kinds = new Set(value.kinds);
  if (kinds.size !== value.kinds.length) {
    ctx.addIssue({ code: 'custom', path: ['kinds'], message: 'kinds must not contain duplicates' });
  }
  value.capabilities.forEach((capability, index) => {
    if (!kinds.has(capability.kind)) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', index, 'kind'],
        message: 'capability kind must be listed in kinds',
      });
    }
  });
});

const federatedMediaResultSchema = z.object({
  available: z.literal(true),
  mimeType: z.enum(Object.keys(FEDERATED_MEDIA_RESULT_EXTENSION)),
  sizeBytes: z.number().int().positive().max(4_294_967_296),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  downloadUrl: z.string().trim().min(1).max(500),
  engine: z.string().trim().min(1).max(80).nullable(),
  modelId: z.string().trim().min(1).max(256).nullable(),
  durationSec: z.number().finite().positive().max(3600).nullable(),
});

// Consumer-side job reconciliation validates every provider response against
// this projection before acting on status, progress, or result metadata. The
// result URL is still advisory: consumers derive the fixed v1 result endpoint
// from the validated job id rather than following provider-supplied URLs.
export const federatedMediaProviderJobSchema = z.object({
  wireVersion: z.literal(FEDERATED_MEDIA_WIRE_VERSION),
  id: z.string().uuid(),
  kind: mediaKindSchema,
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  position: z.number().int().positive().nullable(),
  progress: z.number().finite().min(0).max(1).nullable(),
  etaMs: z.number().finite().nonnegative().nullable(),
  failure: z.object({
    code: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(500),
  }).optional(),
  result: federatedMediaResultSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.result && value.result.mimeType !== FEDERATED_MEDIA_RESULT_MIME[value.kind]) {
    ctx.addIssue({
      code: 'custom',
      path: ['result', 'mimeType'],
      message: 'result mimeType must match the job kind',
    });
  }
});

/**
 * Check a validated provider snapshot against the consumer's clock.
 * A timestamp too far in the future is unknown rather than fresh: accepting it
 * would extend capacity indefinitely on a peer with a broken clock.
 */
export function inspectFederatedMediaStatusFreshness(status, now = Date.now()) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const generatedAtMs = Date.parse(status?.generatedAt);
  const staleAfterMs = status?.staleAfterMs;
  if (!Number.isFinite(nowMs) || !Number.isFinite(generatedAtMs)
    || !Number.isInteger(staleAfterMs) || staleAfterMs <= 0) {
    return { fresh: false, reason: 'invalid-timestamp', freshUntil: null };
  }
  if (generatedAtMs - nowMs > FEDERATED_MEDIA_MAX_CLOCK_SKEW_MS) {
    return { fresh: false, reason: 'clock-skew', freshUntil: null };
  }
  const freshUntilMs = generatedAtMs + staleAfterMs;
  return {
    fresh: nowMs <= freshUntilMs,
    reason: nowMs <= freshUntilMs ? null : 'stale',
    freshUntil: new Date(freshUntilMs).toISOString(),
  };
}
