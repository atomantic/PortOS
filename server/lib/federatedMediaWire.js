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

export function renderFederatedMediaAudioPrompt(profile) {
  const parsed = federatedMediaAudioProfileSchema.safeParse(profile);
  if (!parsed.success) return null;
  const { style, mood, tempo, energy, instruments } = parsed.data;
  const instrumentation = instruments.length > 0
    ? `, featuring ${instruments.map(words).join(' and ')}`
    : '';
  return `Instrumental ${words(style)} music with a ${mood} mood, ${tempo} tempo, ${energy} energy${instrumentation}. No vocals or spoken words.`;
}

// Provider-side validation receives only the rendered text (not the local
// profile) so older wire-v1 providers can still accept newer consumers. Parse
// the canonical grammar back into fixed tokens and require an exact round trip;
// arbitrary prose, names, lyrics, and redaction-sensitive fields fail closed.
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

// Wire v1 intentionally exposes audio only. Later media kinds get their own
// versioned capability shape instead of being accepted against audio-specific
// readiness fields by an older consumer.
const mediaKindSchema = z.literal('audio');

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
  kinds: z.array(mediaKindSchema).max(1),
  queue: federatedMediaQueueStatusSchema,
  capabilities: z.array(federatedMediaCapabilitySchema).max(300),
});

const federatedMediaResultSchema = z.object({
  available: z.literal(true),
  mimeType: z.literal('audio/wav'),
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
