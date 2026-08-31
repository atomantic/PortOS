/**
 * Machine-local character voice profiles (#5380, #5381).
 *
 * Universe characters retain only portable voice direction and their legacy
 * namespaced preset id. This module owns the local, DB-primary binding that
 * can be promoted independently on each install, plus the managed directory
 * that holds benchmark renders, training runs, and local engine artifacts.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/paths.js';

export const VOICE_PROFILE_ENGINES = new Set(['kokoro', 'piper', 'qwen3-tts']);
export const VOICE_PROFILE_KINDS = new Set(['preset', 'designed', 'cloned', 'fine-tuned']);
export const VOICE_PROFILE_ROUTES = new Set(['studio', 'interactive']);

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_ID = 160;
const MAX_LABEL = 160;
const MAX_REVISION = 240;
const MAX_BENCHMARK_LINES = 12;
const MAX_RENDER_ID = 160;
const DEFAULT_DELIVERY = Object.freeze({ rate: 1, pitchSemitones: null, formantSemitones: null });
const DEFAULT_MASTERING = Object.freeze({ chain: ['preset-output:unprocessed'] });
const SAFE_ASSET_BASENAME = /^[a-z0-9][a-z0-9._-]{0,159}$/i;

const trim = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const timestamp = () => new Date().toISOString();
const positiveInteger = (value, fallback = 1) =>
  Number.isInteger(value) && value > 0 ? value : fallback;

export function parsePresetVoiceId(voiceId) {
  const value = trim(voiceId, MAX_ID);
  const match = /^([a-z][a-z0-9-]*):([^:\s]+)$/i.exec(value);
  if (!match) return null;
  const engine = match[1].toLowerCase();
  const normalizedEngine = engine === 'qwen3' ? 'qwen3-tts' : engine;
  if (!VOICE_PROFILE_ENGINES.has(normalizedEngine)) return null;
  return { engine: normalizedEngine, voice: match[2], voiceId: `${normalizedEngine}:${match[2]}` };
}

const sanitizeRoutes = (raw) => Object.fromEntries(
  [...VOICE_PROFILE_ROUTES].map((route) => [route, {
    enabled: raw?.[route]?.enabled === true,
    maxFirstAudioMs: Number.isFinite(raw?.[route]?.maxFirstAudioMs)
      ? Math.max(50, Math.round(raw[route].maxFirstAudioMs))
      : (route === 'interactive' ? 900 : null),
  }]),
);

const boundedNumber = (value, min, max, fallback) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const sanitizeDelivery = (raw) => ({
  rate: boundedNumber(raw?.rate, 0.25, 4, DEFAULT_DELIVERY.rate),
  pitchSemitones: null,
  formantSemitones: null,
});

const sanitizeMastering = (raw) => ({
  chain: Array.isArray(raw?.chain)
    ? raw.chain.map((step) => trim(step, 80)).filter(Boolean).slice(0, 12)
    : [...DEFAULT_MASTERING.chain],
});

const sanitizeInference = (raw) => ({
  seed: Number.isInteger(raw?.seed) ? raw.seed : 42,
  instructions: trim(raw?.instructions, 2000) || null,
  rate: boundedNumber(raw?.rate, 0.25, 4, 1.0),
  checkpointPath: trim(raw?.checkpointPath, 500) || null,
  modelId: trim(raw?.modelId, 160) || null,
});

const sanitizeBenchmark = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const renderedAt = trim(raw.renderedAt, 64);
  const lines = Array.isArray(raw.lines) ? raw.lines.map((line) => {
    const filename = trim(line?.filename, 200);
    if (!filename) return null;
    return {
      key: trim(line.key, 64),
      text: trim(line.text, 1000),
      filename,
      latencyMs: Number.isFinite(line.latencyMs) ? Math.max(0, Math.round(line.latencyMs)) : null,
      engine: VOICE_PROFILE_ENGINES.has(line.engine) ? line.engine : null,
      modelRevision: trim(line.modelRevision, MAX_REVISION) || null,
      effectiveControls: {
        rate: Number.isFinite(line?.effectiveControls?.rate) ? line.effectiveControls.rate : null,
      },
    };
  }).filter(Boolean).slice(0, MAX_BENCHMARK_LINES) : [];
  if (!renderedAt || lines.length === 0) return null;
  return {
    profileRevision: positiveInteger(raw.profileRevision),
    renderedAt,
    lines,
    mastering: sanitizeMastering(raw.mastering),
    interactiveLatencyMs: Number.isFinite(raw.interactiveLatencyMs) ? Math.round(raw.interactiveLatencyMs) : null,
    similarityScore: Number.isFinite(raw.similarityScore) ? Number(raw.similarityScore.toFixed(3)) : null,
  };
};

const sanitizeSourceAssets = (raw) => Array.isArray(raw)
  ? raw.map((asset) => {
    const filename = trim(asset?.filename, 160);
    if (!SAFE_ASSET_BASENAME.test(filename)) return null;
    return {
      filename,
      sha256: /^[a-f0-9]{64}$/i.test(trim(asset?.sha256, 64)) ? trim(asset.sha256, 64).toLowerCase() : null,
      transcript: trim(asset?.transcript, 4000) || null,
      rightsConfirmedAt: trim(asset?.rightsConfirmedAt, 64) || null,
      performerConsentConfirmed: asset?.performerConsentConfirmed === true,
      licensePosture: trim(asset?.licensePosture, 160) || null,
    };
  }).filter(Boolean).slice(0, 24)
  : [];

/** Turn a raw DB JSON payload into the durable public profile shape. */
export function sanitizeVoiceProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = trim(raw.id, 80);
  const universeId = trim(raw?.binding?.universeId, MAX_ID);
  const characterId = trim(raw?.binding?.characterId, MAX_ID);
  const kind = VOICE_PROFILE_KINDS.has(raw.kind) ? raw.kind : 'preset';
  const engine = VOICE_PROFILE_ENGINES.has(raw.engine)
    ? raw.engine
    : (parsePresetVoiceId(raw.voiceId)?.engine || 'kokoro');

  if (!PROFILE_ID_RE.test(id) || !universeId || !characterId) return null;

  const approvalStatus = raw?.approval?.status === 'approved'
    ? 'approved'
    : raw?.approval?.status === 'retired' ? 'retired' : 'draft';
  const createdAt = trim(raw.createdAt, 64) || timestamp();
  const updatedAt = trim(raw.updatedAt, 64) || createdAt;
  const voiceId = trim(raw.voiceId, MAX_ID) || `${engine}:${kind}`;

  return {
    id,
    version: positiveInteger(raw.version),
    binding: { universeId, characterId },
    label: trim(raw.label, MAX_LABEL) || null,
    kind,
    engine,
    voiceId,
    modelRevision: trim(raw.modelRevision, MAX_REVISION) || (engine === 'qwen3-tts' ? 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign' : 'configured-preset'),
    sourceAssets: sanitizeSourceAssets(raw.sourceAssets),
    inference: sanitizeInference(raw.inference),
    routes: sanitizeRoutes(raw.routes),
    delivery: sanitizeDelivery(raw.delivery),
    mastering: sanitizeMastering(raw.mastering),
    approval: {
      status: approvalStatus,
      approvedAt: approvalStatus === 'approved' ? trim(raw?.approval?.approvedAt, 64) || updatedAt : null,
      benchmarkRevision: positiveInteger(raw?.approval?.benchmarkRevision),
    },
    benchmark: sanitizeBenchmark(raw.benchmark),
    createdAt,
    updatedAt,
  };
}

const profileDirectory = (id) => join(PATHS.voiceProfiles, id);

export function profileArtifactDirectory(id) {
  if (!PROFILE_ID_RE.test(id || '')) {
    throw new ServerError('invalid voice profile id', { status: 400, code: 'VOICE_PROFILE_INVALID_ID' });
  }
  return profileDirectory(id);
}

const persist = async (profile) => {
  await query(
    `INSERT INTO voice_profiles (id, universe_id, character_id, approval_status, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       universe_id = EXCLUDED.universe_id,
       character_id = EXCLUDED.character_id,
       approval_status = EXCLUDED.approval_status,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [
      profile.id,
      profile.binding.universeId,
      profile.binding.characterId,
      profile.approval.status,
      JSON.stringify(profile),
      profile.createdAt,
      profile.updatedAt,
    ],
  );
  return profile;
};

export async function getVoiceProfile(id) {
  const profileId = trim(id, 80);
  if (!PROFILE_ID_RE.test(profileId)) return null;
  const { rows } = await query('SELECT data FROM voice_profiles WHERE id = $1', [profileId]);
  return sanitizeVoiceProfile(rows[0]?.data);
}

export async function getVoiceProfileRequired(id) {
  const profile = await getVoiceProfile(id);
  if (!profile) {
    throw new ServerError('Voice profile not found', { status: 404, code: 'VOICE_PROFILE_NOT_FOUND' });
  }
  return profile;
}

export async function listVoiceProfiles({ universeId, characterId } = {}) {
  const clauses = [];
  const params = [];
  const universe = trim(universeId, MAX_ID);
  const character = trim(characterId, MAX_ID);
  if (universe) { params.push(universe); clauses.push(`universe_id = $${params.length}`); }
  if (character) { params.push(character); clauses.push(`character_id = $${params.length}`); }
  const { rows } = await query(
    `SELECT data FROM voice_profiles ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY updated_at DESC, id DESC`,
    params,
  );
  return rows.map((row) => sanitizeVoiceProfile(row.data)).filter(Boolean);
}

async function getBoundProfile(universeId, characterId) {
  const { rows } = await query(
    `SELECT data FROM voice_profiles
     WHERE universe_id = $1 AND character_id = $2
     ORDER BY (approval_status = 'approved') DESC, updated_at DESC, id DESC LIMIT 1`,
    [universeId, characterId],
  );
  return sanitizeVoiceProfile(rows[0]?.data);
}

/**
 * Retire existing approved profiles for a character when promoting a new profile.
 */
async function supersedeApprovedProfiles(universeId, characterId, exceptProfileId) {
  const { rows } = await query(
    `SELECT data FROM voice_profiles
     WHERE universe_id = $1 AND character_id = $2 AND approval_status = 'approved' AND id != $3`,
    [universeId, characterId, exceptProfileId],
  );
  for (const row of rows) {
    const item = sanitizeVoiceProfile(row.data);
    if (item) {
      const updated = sanitizeVoiceProfile({
        ...item,
        approval: { ...item.approval, status: 'retired' },
        updatedAt: timestamp(),
      });
      await persist(updated);
    }
  }
}

/**
 * Create a candidate Voice Design profile without changing the approved character voice.
 */
export async function createVoiceDesignCandidate({
  universeId,
  characterId,
  characterName = '',
  instructions = '',
  seed = 42,
  modelId = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
  delivery = DEFAULT_DELIVERY,
  rate = 1.0,
} = {}) {
  const universe = trim(universeId, MAX_ID);
  const character = trim(characterId, MAX_ID);
  if (!universe || !character) {
    throw new ServerError('universeId and characterId are required', { status: 400 });
  }

  const profileId = randomUUID();
  const now = timestamp();
  const next = sanitizeVoiceProfile({
    id: profileId,
    version: 1,
    binding: { universeId: universe, characterId: character },
    label: trim(characterName, MAX_LABEL) || null,
    kind: 'designed',
    engine: 'qwen3-tts',
    voiceId: `qwen3:design-${profileId.slice(0, 8)}`,
    modelRevision: trim(modelId, MAX_REVISION) || 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
    sourceAssets: [],
    inference: {
      seed: Number.isInteger(seed) ? seed : 42,
      instructions: trim(instructions, 2000),
      rate: boundedNumber(rate, 0.25, 4, 1.0),
      modelId,
    },
    routes: { studio: { enabled: true }, interactive: { enabled: false, maxFirstAudioMs: 900 } },
    delivery: { ...DEFAULT_DELIVERY, rate: boundedNumber(rate, 0.25, 4, 1.0) },
    mastering: DEFAULT_MASTERING,
    approval: {
      status: 'draft',
      approvedAt: null,
      benchmarkRevision: 1,
    },
    benchmark: null,
    createdAt: now,
    updatedAt: now,
  });

  await mkdir(profileDirectory(profileId), { recursive: true });
  return persist(next);
}

/**
 * Create a candidate Consented Cloned profile with source audio and confirmed consent.
 */
export async function createClonedVoiceCandidate({
  universeId,
  characterId,
  characterName = '',
  audioBuffer,
  filename,
  transcript = '',
  performerConsentConfirmed = false,
  licensePosture = 'consented-performance',
  modelId = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
  rate = 1.0,
} = {}) {
  const universe = trim(universeId, MAX_ID);
  const character = trim(characterId, MAX_ID);
  const cleanFilename = trim(filename, 160);

  if (!universe || !character) {
    throw new ServerError('universeId and characterId are required', { status: 400 });
  }
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new ServerError('Audio recording buffer is required for cloning', { status: 400 });
  }
  if (!SAFE_ASSET_BASENAME.test(cleanFilename)) {
    throw new ServerError('Invalid audio asset filename', { status: 400 });
  }
  if (performerConsentConfirmed !== true) {
    throw new ServerError('Voice cloning requires explicit performer consent confirmation', {
      status: 400,
      code: 'CONSENT_REQUIRED',
    });
  }

  const profileId = randomUUID();
  const profileDir = profileDirectory(profileId);
  const sourceDir = join(profileDir, 'source');
  await mkdir(sourceDir, { recursive: true });

  const safePath = join(sourceDir, cleanFilename);
  await writeFile(safePath, audioBuffer);

  const sha256 = createHash('sha256').update(audioBuffer).digest('hex');
  const now = timestamp();

  const sourceAssets = [{
    filename: cleanFilename,
    sha256,
    transcript: trim(transcript, 4000) || null,
    rightsConfirmedAt: now,
    performerConsentConfirmed: true,
    licensePosture: trim(licensePosture, 160) || 'consented-performance',
  }];

  const next = sanitizeVoiceProfile({
    id: profileId,
    version: 1,
    binding: { universeId: universe, characterId: character },
    label: trim(characterName, MAX_LABEL) || null,
    kind: 'cloned',
    engine: 'qwen3-tts',
    voiceId: `qwen3:clone-${profileId.slice(0, 8)}`,
    modelRevision: trim(modelId, MAX_REVISION) || 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
    sourceAssets,
    inference: {
      seed: 42,
      instructions: null,
      rate: boundedNumber(rate, 0.25, 4, 1.0),
      modelId,
    },
    routes: { studio: { enabled: true }, interactive: { enabled: false, maxFirstAudioMs: 900 } },
    delivery: { ...DEFAULT_DELIVERY, rate: boundedNumber(rate, 0.25, 4, 1.0) },
    mastering: DEFAULT_MASTERING,
    approval: {
      status: 'draft',
      approvedAt: null,
      benchmarkRevision: 1,
    },
    benchmark: null,
    createdAt: now,
    updatedAt: now,
  });

  return persist(next);
}

/**
 * Promote a fine-tuned checkpoint artifact into an approved voice profile.
 */
export async function promoteFineTunedProfile({
  profileId,
  universeId,
  characterId,
  checkpointPath,
  checkpointId,
  modelRevision = null,
  step = 100,
} = {}) {
  const current = await getVoiceProfile(profileId);
  const now = timestamp();
  const id = current?.id || randomUUID();
  const next = sanitizeVoiceProfile({
    ...current,
    id,
    version: current ? current.version + 1 : 1,
    binding: { universeId, characterId },
    label: current?.label || null,
    kind: 'fine-tuned',
    engine: 'qwen3-tts',
    voiceId: `qwen3:fine-tuned-step-${step}`,
    modelRevision: trim(modelRevision, MAX_REVISION) || `qwen3-tts:checkpoint-${step}`,
    inference: {
      ...current?.inference,
      checkpointPath,
    },
    routes: { studio: { enabled: true }, interactive: { enabled: false, maxFirstAudioMs: 900 } },
    delivery: current?.delivery || DEFAULT_DELIVERY,
    mastering: current?.mastering || DEFAULT_MASTERING,
    approval: {
      status: 'approved',
      approvedAt: now,
      benchmarkRevision: current ? current.approval.benchmarkRevision + 1 : 1,
    },
    benchmark: null,
    createdAt: current?.createdAt || now,
    updatedAt: now,
  });

  await mkdir(profileDirectory(next.id), { recursive: true });
  await supersedeApprovedProfiles(universeId, characterId, next.id);
  return persist(next);
}

/**
 * Explicitly promote any draft or candidate profile to approved status.
 */
export async function promoteVoiceProfile(profileId, { routes = null } = {}) {
  const current = await getVoiceProfileRequired(profileId);
  const now = timestamp();

  const nextRoutes = routes ? sanitizeRoutes(routes) : {
    studio: { enabled: true },
    interactive: {
      enabled: current.routes.interactive?.enabled === true,
      maxFirstAudioMs: current.routes.interactive?.maxFirstAudioMs || 900,
    },
  };

  const next = sanitizeVoiceProfile({
    ...current,
    version: current.approval.status === 'approved' ? current.version : current.version + 1,
    routes: nextRoutes,
    approval: {
      status: 'approved',
      approvedAt: now,
      benchmarkRevision: current.approval.benchmarkRevision || 1,
    },
    updatedAt: now,
  });

  await supersedeApprovedProfiles(current.binding.universeId, current.binding.characterId, next.id);
  return persist(next);
}

/**
 * Explicitly promote a selected Kokoro/Piper preset to the local character binding.
 */
export async function promotePresetProfile({
  universeId,
  characterId,
  characterName = '',
  voiceId,
  modelRevision = 'configured-preset',
  delivery = DEFAULT_DELIVERY,
} = {}) {
  const universe = trim(universeId, MAX_ID);
  const character = trim(characterId, MAX_ID);
  const preset = parsePresetVoiceId(voiceId);
  if (!universe || !character || !preset) {
    throw new ServerError('A universe, character, and valid preset are required', {
      status: 400,
      code: 'VOICE_PROFILE_INVALID_PRESET',
    });
  }
  const current = await getBoundProfile(universe, character);
  const samePreset = current?.voiceId === preset.voiceId;
  const now = timestamp();
  const profileId = current?.id || randomUUID();
  const next = sanitizeVoiceProfile({
    ...current,
    id: profileId,
    version: current ? (samePreset ? current.version : current.version + 1) : 1,
    binding: { universeId: universe, characterId: character },
    label: trim(characterName, MAX_LABEL) || current?.label || null,
    kind: 'preset',
    engine: preset.engine,
    voiceId: preset.voiceId,
    modelRevision: trim(modelRevision, MAX_REVISION) || 'configured-preset',
    routes: current?.routes || { studio: { enabled: true }, interactive: { enabled: true, maxFirstAudioMs: 900 } },
    delivery: current?.delivery || delivery,
    mastering: current?.mastering || DEFAULT_MASTERING,
    approval: {
      status: 'approved',
      approvedAt: now,
      benchmarkRevision: current ? (samePreset ? current.approval.benchmarkRevision : current.approval.benchmarkRevision + 1) : 1,
    },
    benchmark: samePreset ? current?.benchmark : null,
    createdAt: current?.createdAt || now,
    updatedAt: now,
  });
  await mkdir(profileDirectory(next.id), { recursive: true });
  await supersedeApprovedProfiles(universe, character, next.id);
  return persist(next);
}

export async function saveProfileBenchmark(profile, benchmark) {
  const current = await getVoiceProfileRequired(profile?.id);
  const next = sanitizeVoiceProfile({
    ...current,
    benchmark,
    updatedAt: timestamp(),
  });
  return persist(next);
}

/**
 * Record line-level provenance in database.
 */
export async function recordVoiceProfileRender({
  issueId,
  lineId,
  audioFilename,
  latencyMs,
  durationMs,
  provenance,
} = {}) {
  const issue = trim(issueId, MAX_RENDER_ID);
  const line = trim(lineId, MAX_RENDER_ID);
  const filename = trim(audioFilename, 500);
  const profileId = trim(provenance?.profileId, 80);
  const profileRevision = positiveInteger(provenance?.profileRevision, 0);
  const engine = VOICE_PROFILE_ENGINES.has(provenance?.engine) ? provenance.engine : null;
  if (!issue || !line || !filename || !PROFILE_ID_RE.test(profileId) || !profileRevision || !engine) {
    throw new ServerError('Invalid local voice render provenance', {
      status: 400,
      code: 'VOICE_PROFILE_INVALID_RENDER_PROVENANCE',
    });
  }
  const now = timestamp();
  const data = {
    profileId,
    profileRevision,
    engine,
    modelRevision: trim(provenance?.modelRevision, MAX_REVISION) || null,
    effectiveControls: {
      rate: Number.isFinite(provenance?.effectiveControls?.rate) ? provenance.effectiveControls.rate : null,
    },
    mastering: sanitizeMastering(provenance?.mastering),
    timing: {
      latencyMs: Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
    },
    audioFilename: filename,
    recordedAt: now,
  };
  await query(
    `INSERT INTO voice_profile_renders (issue_id, line_id, profile_id, profile_revision, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (issue_id, line_id) DO UPDATE SET
       profile_id = EXCLUDED.profile_id,
       profile_revision = EXCLUDED.profile_revision,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [issue, line, profileId, profileRevision, JSON.stringify(data), now, now],
  );
}

export async function clearVoiceProfileRender({ issueId, lineId } = {}) {
  const issue = trim(issueId, MAX_RENDER_ID);
  const line = trim(lineId, MAX_RENDER_ID);
  if (!issue || !line) return;
  await query('DELETE FROM voice_profile_renders WHERE issue_id = $1 AND line_id = $2', [issue, line]);
}

const assertRoute = (route) => {
  if (!VOICE_PROFILE_ROUTES.has(route)) {
    throw new ServerError('Unsupported voice profile route', { status: 400, code: 'VOICE_PROFILE_INVALID_ROUTE' });
  }
};

export async function getProfileForSynthesis(id, route = 'studio') {
  assertRoute(route);
  const profile = await getVoiceProfileRequired(id);
  if (profile.approval.status !== 'approved') {
    throw new ServerError('Voice profile is not approved', { status: 409, code: 'VOICE_PROFILE_UNAPPROVED' });
  }
  if (profile.routes[route]?.enabled !== true) {
    throw new ServerError(`Voice profile is not enabled for ${route}`, {
      status: 409,
      code: 'VOICE_PROFILE_ROUTE_DISABLED',
    });
  }
  return profile;
}

export async function resolveCharacterVoice({
  universeId,
  characterId,
  characterVoiceId = null,
  route = 'studio',
} = {}) {
  assertRoute(route);
  const universe = trim(universeId, MAX_ID);
  const character = trim(characterId, MAX_ID);
  let unavailableProfile = null;
  if (universe && character) {
    const profiles = await listVoiceProfiles({ universeId: universe, characterId: character });
    const profile = profiles.find((item) =>
      item.approval.status === 'approved' && item.routes[route]?.enabled === true,
    );
    if (profile) {
      return {
        source: 'profile',
        profileId: profile.id,
        profileRevision: profile.version,
        voiceId: profile.voiceId,
        degraded: false,
        warning: null,
      };
    }
    unavailableProfile = profiles.find((item) => item.approval.status === 'approved') || null;
  }
  const preset = parsePresetVoiceId(characterVoiceId);
  const legacyVoice = trim(characterVoiceId, MAX_ID);
  if (preset || legacyVoice) {
    return {
      source: 'character-preset',
      profileId: null,
      profileRevision: null,
      voiceId: preset?.voiceId || legacyVoice,
      degraded: Boolean(unavailableProfile),
      warning: unavailableProfile
        ? `The approved local voice profile is unavailable for ${route}; using the portable character preset.`
        : null,
    };
  }
  return {
    source: 'project-default',
    profileId: null,
    profileRevision: null,
    voiceId: null,
    degraded: true,
    warning: unavailableProfile
      ? `The approved local voice profile is unavailable for ${route} and has no portable character preset; using the project default.`
      : 'No approved local voice profile or character preset is available; using the project default.',
  };
}
