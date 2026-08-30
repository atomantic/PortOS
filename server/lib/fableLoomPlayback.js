/**
 * FableLoom node playback semantics shared by persistence, prompts, and UI.
 *
 * Supports entry clips, deterministic hold loops, transition exit clips,
 * live interaction windows, audio-occupancy manifests, and production
 * readiness inspection. Legacy nodes default to decision mode and single
 * videoHistoryId playback.
 */

import { LOOM_LIMITS } from './fableLoomLimits.js';

export const FABLELOOM_PLAYBACK_MODES = Object.freeze(['cut', 'decision']);
export const FABLELOOM_PLAYBACK_MODE_DEFAULT = 'decision';

export const FABLELOOM_PLAYBACK_PHASES = Object.freeze(['entry', 'hold', 'exit', 'ended']);

export const FABLELOOM_PROTAGONIST_PRESENCE = Object.freeze(['offscreen', 'onscreen']);
export const FABLELOOM_PROTAGONIST_PRESENCE_DEFAULT = 'offscreen';

/**
 * Resolve the visual presence contract for one scene. Explicit live-window
 * presence wins because hosted playback must obey that safety setting. Helper
 * decision scenes default to an off-screen audience conversation; a loom with
 * a canonical protagonist defaults other scenes to on-screen until the author
 * marks them otherwise.
 */
export const resolveFableLoomProtagonistPresence = (node, loom = null) => {
  if (node?.interactionWindow?.enabled
    && FABLELOOM_PROTAGONIST_PRESENCE.includes(node.interactionWindow.protagonistPresence)) {
    return node.interactionWindow.protagonistPresence;
  }
  if (FABLELOOM_PROTAGONIST_PRESENCE.includes(node?.protagonistPresence)) {
    return node.protagonistPresence;
  }
  if (loom?.participationMode === 'helper'
    && node?.playbackMode === 'decision'
    && node?.audienceConnection === 'connected') {
    return 'offscreen';
  }
  return loom?.protagonistCharacterId ? 'onscreen' : null;
};

export const FABLELOOM_AUDIO_TARGETS = Object.freeze(['host', 'audience']);
export const FABLELOOM_AUDIO_TARGET_DEFAULT = 'host';

export const FABLELOOM_HOLD_ROTATION_MODES = Object.freeze(['deterministic', 'shuffle', 'sequential']);
export const FABLELOOM_HOLD_ROTATION_MODE_DEFAULT = 'deterministic';

export const isFableLoomPlaybackMode = (value) => FABLELOOM_PLAYBACK_MODES.includes(value);
export const asFableLoomPlaybackMode = (value) => (
  isFableLoomPlaybackMode(value) ? value : FABLELOOM_PLAYBACK_MODE_DEFAULT
);

export const isSafeVideoHistoryId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const trimTo = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const SAFE_PRODUCTION_PARAMETER_KEYS = new Set([
  'width', 'height', 'numFrames', 'fps', 'steps', 'guidance', 'guidanceScale',
  'seed', 'imageStrength', 'quantize', 'effort', 'mode', 'videoMode',
  'aspectRatio', 'disableAudio', 'tiling',
]);

/**
 * Sanitize an audio interval (dialogue, music, or effect).
 */
export function sanitizeAudioInterval(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startMs = Number.isFinite(raw.startMs) && raw.startMs >= 0 ? Math.round(raw.startMs) : 0;
  const endMs = Number.isFinite(raw.endMs) && raw.endMs >= startMs ? Math.round(raw.endMs) : startMs;
  return {
    startMs,
    endMs,
    ...(isStr(raw.characterId) ? { characterId: trimTo(raw.characterId, 80) } : {}),
    ...(isStr(raw.speaker) ? { speaker: trimTo(raw.speaker, 100) } : {}),
    ...(raw.blocking === true ? { blocking: true } : {}),
    ...(isStr(raw.name) ? { name: trimTo(raw.name, 100) } : {}),
  };
}

/**
 * Sanitize and validate an audio occupancy manifest.
 * `safeForLiveVoice` is strictly computed/enforced:
 * - A hold asset containing character dialogue CANNOT open a live voice window.
 * - An asset with author-marked blocking effects CANNOT open a live voice window.
 */
export function validateAudioOccupancy(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      durationMs: 0,
      characterDialogue: [],
      music: [],
      effects: [],
      safeForLiveVoice: true,
    };
  }

  const durationMs = Number.isFinite(raw.durationMs) && raw.durationMs >= 0
    ? Math.round(raw.durationMs)
    : 0;

  const characterDialogue = (Array.isArray(raw.characterDialogue) ? raw.characterDialogue : [])
    .map(sanitizeAudioInterval)
    .filter(Boolean)
    .slice(0, LOOM_LIMITS.AUDIO_INTERVALS_MAX || 50);

  const music = (Array.isArray(raw.music) ? raw.music : [])
    .map(sanitizeAudioInterval)
    .filter(Boolean)
    .slice(0, LOOM_LIMITS.AUDIO_INTERVALS_MAX || 50);

  const effects = (Array.isArray(raw.effects) ? raw.effects : [])
    .map(sanitizeAudioInterval)
    .filter(Boolean)
    .slice(0, LOOM_LIMITS.AUDIO_INTERVALS_MAX || 50);

  const hasCharacterDialogue = characterDialogue.length > 0;
  const hasBlockingEffects = effects.some((e) => e.blocking === true);
  const peakDb = Number.isFinite(raw.truePeakDb)
    ? raw.truePeakDb
    : (Number.isFinite(raw.peakDb) ? raw.peakDb : null);
  const clipping = raw.clipping === true
    || raw.clipped === true
    || raw.clippingDetected === true
    || (peakDb !== null && peakDb > 0);

  // safeForLiveVoice is false if any dialogue, blocking effects, or clipping
  // exists. A caller cannot override these derived safety fields with a stale
  // `safeForLiveVoice: true` value from an older manifest.
  const safeForLiveVoice = !hasCharacterDialogue && !hasBlockingEffects && !clipping;

  return {
    durationMs,
    characterDialogue,
    music,
    effects,
    clipping,
    ...(peakDb !== null ? { peakDb } : {}),
    safeForLiveVoice,
  };
}

export const sanitizeAudioOccupancy = validateAudioOccupancy;

/**
 * Sanitize the path-free visual conditioning manifest attached to a scene or
 * typed playback asset. The playback module owns this shape so the node
 * sanitizer can safely handle one manifest per rendered clip without a
 * records-module import cycle.
 */
export function sanitizeVisualConditioning(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return null;
  const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
  const nullableRef = (value) => (isStr(value) ? trimTo(value, LOOM_LIMITS.REF_ID_MAX) : null);
  const capability = raw.capability && typeof raw.capability === 'object' ? raw.capability : {};
  const bindings = raw.bindings && typeof raw.bindings === 'object' ? raw.bindings : {};
  const protagonistBinding = bindings.protagonist && typeof bindings.protagonist === 'object'
    && nullableRef(bindings.protagonist.characterId)
    ? {
      characterId: nullableRef(bindings.protagonist.characterId),
      wardrobeId: nullableRef(bindings.protagonist.wardrobeId),
      presence: FABLELOOM_PROTAGONIST_PRESENCE.includes(bindings.protagonist.presence)
        ? bindings.protagonist.presence
        : null,
    }
    : null;
  const productionParameters = raw.render?.parameters && typeof raw.render.parameters === 'object'
    ? Object.fromEntries(Object.entries(raw.render.parameters).flatMap(([key, value]) => {
      if (!SAFE_PRODUCTION_PARAMETER_KEYS.has(key)) return [];
      if (typeof value === 'number' && Number.isFinite(value)) return [[key.slice(0, 40), value]];
      if (typeof value === 'boolean') return [[key.slice(0, 40), value]];
      if (isStr(value)) return [[key.slice(0, 40), trimTo(value, 200)]];
      return [];
    }))
    : {};
  return {
    version: 1,
    compilerVersion: trimTo(raw.compilerVersion, 40),
    status: ['locked', 'draft', 'degraded'].includes(raw.status) ? raw.status : 'degraded',
    universeId: nullableRef(raw.universeId),
    capability: {
      version: Number.isInteger(capability.version) ? capability.version : 1,
      kind: capability.kind === 'video' ? 'video' : 'image',
      backend: trimTo(capability.backend, 40),
      modelId: nullableRef(capability.modelId),
      modelRevision: nullableRef(capability.modelRevision),
      referenceRoles: list(capability.referenceRoles, 24)
        .map((item) => trimTo(item, 64)).filter(Boolean),
      referenceBudget: Number.isInteger(capability.referenceBudget)
        ? Math.max(0, Math.min(24, capability.referenceBudget)) : 0,
      supportsLora: capability.supportsLora === true,
      loraCompatKey: nullableRef(capability.loraCompatKey),
      loraBudget: Number.isInteger(capability.loraBudget)
        ? Math.max(0, Math.min(8, capability.loraBudget)) : 0,
      multiCharacterPreservation: capability.multiCharacterPreservation === true,
      ...(capability.kind === 'video' ? {
        firstFrame: capability.firstFrame === true,
        lastFrame: capability.lastFrame === true,
        extension: capability.extension === true,
      } : {}),
    },
    bindings: {
      inferred: bindings.inferred === true,
      characterAppearances: list(bindings.characterAppearances, LOOM_LIMITS.VISUAL_BINDINGS_MAX)
        .filter((item) => item && typeof item === 'object' && nullableRef(item.characterId))
        .map((item) => ({
          characterId: nullableRef(item.characterId),
          wardrobeId: nullableRef(item.wardrobeId),
          expression: trimTo(item.expression, LOOM_LIMITS.VISUAL_NOTE_MAX),
          continuityNotes: trimTo(item.continuityNotes, LOOM_LIMITS.VISUAL_NOTE_MAX),
        })),
      placeId: nullableRef(bindings.placeId),
      objectIds: list(bindings.objectIds, LOOM_LIMITS.VISUAL_BINDINGS_MAX)
        .map(nullableRef).filter(Boolean),
      ...(protagonistBinding ? { protagonist: protagonistBinding } : {}),
    },
    assets: list(raw.assets, LOOM_LIMITS.VISUAL_PROVENANCE_ASSETS_MAX)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        role: trimTo(item.role, 64), bindingId: nullableRef(item.bindingId),
        required: item.required === true, filename: trimTo(item.filename, 256),
      })),
    adapters: list(raw.adapters, 8)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        characterId: nullableRef(item.characterId), filename: trimTo(item.filename, 256),
        scale: Number.isFinite(item.scale) ? Math.max(0, Math.min(2, item.scale)) : 1,
        sha256: typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(item.sha256) ? item.sha256 : null,
      })),
    omitted: list(raw.omitted, LOOM_LIMITS.VISUAL_PROVENANCE_MESSAGES_MAX)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        role: trimTo(item.role, 64), bindingId: nullableRef(item.bindingId),
        reason: trimTo(item.reason, 80),
        ...(item.filename ? { filename: trimTo(item.filename, 256) } : {}),
      })),
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : [])
      .map((item) => trimTo(item, LOOM_LIMITS.VISUAL_NOTE_MAX)).filter(Boolean)
      .slice(0, LOOM_LIMITS.VISUAL_PROVENANCE_MESSAGES_MAX),
    temporalSourceNodeId: nullableRef(raw.temporalSourceNodeId),
    ...(typeof raw.compiledPrompt === 'string' ? { compiledPrompt: trimTo(raw.compiledPrompt, 8000) } : {}),
    ...(typeof raw.compiledNegativePrompt === 'string' ? { compiledNegativePrompt: trimTo(raw.compiledNegativePrompt, 8000) } : {}),
    referenceImageStrengths: (Array.isArray(raw.referenceImageStrengths) ? raw.referenceImageStrengths : [])
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.max(0, Math.min(1, value)))
      .slice(0, LOOM_LIMITS.VISUAL_PROVENANCE_ASSETS_MAX),
    ...(isStr(raw.assetId) ? { assetId: nullableRef(raw.assetId) } : {}),
    ...(raw.render && typeof raw.render === 'object' ? {
      render: {
        provider: trimTo(raw.render.provider, 40),
        modelId: nullableRef(raw.render.modelId),
        modelRevision: nullableRef(raw.render.modelRevision),
        parameters: productionParameters,
      },
    } : {}),
    compiledAt: isStr(raw.compiledAt) ? raw.compiledAt : null,
  };
}

/**
 * Check if a manifest or asset is safe for live voice.
 */
export function isAssetSafeForLiveVoice(manifest) {
  if (!manifest) return true;
  return validateAudioOccupancy(manifest).safeForLiveVoice === true;
}

/**
 * Helper to build an audio occupancy manifest.
 */
export function createAudioOccupancyManifest({
  durationMs = 0,
  characterDialogue = [],
  music = [],
  effects = [],
} = {}) {
  return validateAudioOccupancy({ durationMs, characterDialogue, music, effects });
}

/**
 * Mux audio tracks into a single unified occupancy manifest.
 */
export function muxAudioTracks({
  durationMs = 0,
  characterDialogue = [],
  music = [],
  effects = [],
} = {}) {
  const manifest = createAudioOccupancyManifest({ durationMs, characterDialogue, music, effects });
  return {
    manifest,
    totalDialogueMs: manifest.characterDialogue.reduce((sum, d) => sum + Math.max(0, d.endMs - d.startMs), 0),
    totalMusicMs: manifest.music.reduce((sum, m) => sum + Math.max(0, m.endMs - m.startMs), 0),
    totalEffectsMs: manifest.effects.reduce((sum, e) => sum + Math.max(0, e.endMs - e.startMs), 0),
    safeForLiveVoice: manifest.safeForLiveVoice,
  };
}

/**
 * Compute ducking and audio level adjustments when live voice or dialogue is active.
 */
export function computeAudioMix({
  assetManifest = null,
  liveVoiceActive = false,
  baseDuckDb = LOOM_LIMITS.AMBIENT_DUCK_DB_DEFAULT || -8,
  currentTimeMs = 0,
} = {}) {
  const manifest = validateAudioOccupancy(assetManifest);
  const duckDb = clamp(
    Number.isFinite(baseDuckDb) ? baseDuckDb : (LOOM_LIMITS.AMBIENT_DUCK_DB_DEFAULT || -8),
    LOOM_LIMITS.AMBIENT_DUCK_DB_MIN || -60,
    LOOM_LIMITS.AMBIENT_DUCK_DB_MAX || 0,
  );

  const duckFactor = liveVoiceActive ? 10 ** (duckDb / 20) : 1.0;

  const dialogueActive = manifest.characterDialogue.some(
    (d) => currentTimeMs >= d.startMs && currentTimeMs <= d.endMs,
  );

  const blockingEffectActive = manifest.effects.some(
    (e) => e.blocking && currentTimeMs >= e.startMs && currentTimeMs <= e.endMs,
  );

  return {
    duckDb: liveVoiceActive ? duckDb : 0,
    duckFactor: Math.round(duckFactor * 1000) / 1000,
    musicLevel: duckFactor,
    effectsLevel: blockingEffectActive ? 1.0 : duckFactor,
    dialogueActive,
    blockingEffectActive,
    safeForLiveVoice: manifest.safeForLiveVoice,
    canOpenLiveVoice: manifest.safeForLiveVoice && !dialogueActive && !blockingEffectActive,
  };
}

/**
 * Sanitize asset provenance envelope.
 */
export function sanitizeProvenance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    version: Number.isFinite(raw.version) ? Math.max(1, Math.round(raw.version)) : 1,
    loomId: isStr(raw.loomId) ? trimTo(raw.loomId, 80) : null,
    episodeId: isStr(raw.episodeId) ? trimTo(raw.episodeId, 80) : null,
    nodeId: isStr(raw.nodeId) ? trimTo(raw.nodeId, 80) : null,
    universeId: isStr(raw.universeId) ? trimTo(raw.universeId, 80) : null,
    characters: (Array.isArray(raw.characters) ? raw.characters : [])
      .filter((c) => c && typeof c === 'object' && isStr(c.characterId))
      .slice(0, LOOM_LIMITS.PROVENANCE_CHARACTERS_MAX || 12)
      .map((c) => ({
        characterId: trimTo(c.characterId, 80),
        wardrobeId: isStr(c.wardrobeId) ? trimTo(c.wardrobeId, 80) : null,
        identityAssets: Array.isArray(c.identityAssets) ? c.identityAssets.filter(isStr).slice(0, 5) : [],
        lora: c.lora && typeof c.lora === 'object' ? {
          filename: trimTo(c.lora.filename, 200),
          sha256: trimTo(c.lora.sha256, 128),
          scale: Number.isFinite(c.lora.scale) ? c.lora.scale : 1.0,
        } : null,
        voice: c.voice && typeof c.voice === 'object' ? {
          profileId: trimTo(c.voice.profileId, 80),
          profileVersion: Number.isFinite(c.voice.profileVersion) ? Math.round(c.voice.profileVersion) : 1,
          engine: trimTo(c.voice.engine, 80),
          modelRevision: trimTo(c.voice.modelRevision, 120),
          pronunciationRevision: Number.isFinite(c.voice.pronunciationRevision)
            ? Math.max(1, Math.round(c.voice.pronunciationRevision))
            : null,
        } : null,
      })),
    visualConditioningVersion: Number.isFinite(raw.visualConditioningVersion) ? raw.visualConditioningVersion : 1,
    promptCompilerVersion: Number.isFinite(raw.promptCompilerVersion) ? raw.promptCompilerVersion : 1,
    audioMixVersion: Number.isFinite(raw.audioMixVersion) ? raw.audioMixVersion : 1,
    omitted: Array.isArray(raw.omitted) ? raw.omitted.filter(isStr).slice(0, 20) : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter(isStr).slice(0, 20) : [],
  };
}

/**
 * Sanitize playbackAssets node field.
 */
export function sanitizePlaybackAssets(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const entryVideoHistoryId = isSafeVideoHistoryId(raw.entryVideoHistoryId)
    ? raw.entryVideoHistoryId
    : null;

  const holdLoopVideoHistoryIds = (Array.isArray(raw.holdLoopVideoHistoryIds) ? raw.holdLoopVideoHistoryIds : [])
    .filter(isSafeVideoHistoryId)
    .slice(0, LOOM_LIMITS.HOLD_LOOPS_MAX || 8);

  const exitByTransition = {};
  if (raw.exitByTransition && typeof raw.exitByTransition === 'object') {
    for (const [trId, vid] of Object.entries(raw.exitByTransition)) {
      if (isStr(trId) && isSafeVideoHistoryId(vid)) {
        exitByTransition[trId.slice(0, 80)] = vid;
      }
    }
  }

  const audioOccupancy = {};
  if (raw.audioOccupancy && typeof raw.audioOccupancy === 'object') {
    for (const [assetId, occ] of Object.entries(raw.audioOccupancy)) {
      if (isStr(assetId) && occ && typeof occ === 'object') {
        audioOccupancy[assetId.slice(0, 200)] = validateAudioOccupancy(occ);
      }
    }
  }

  const provenance = sanitizeProvenance(raw.provenance);
  const visualConditioningByAsset = {};
  if (raw.visualConditioningByAsset && typeof raw.visualConditioningByAsset === 'object') {
    for (const [assetId, manifest] of Object.entries(raw.visualConditioningByAsset)) {
      if (!isSafeVideoHistoryId(assetId)) continue;
      const sanitized = sanitizeVisualConditioning(manifest);
      if (sanitized) visualConditioningByAsset[assetId] = sanitized;
    }
  }

  // If completely empty, return null
  if (!entryVideoHistoryId
    && !holdLoopVideoHistoryIds.length
    && !Object.keys(exitByTransition).length
    && !Object.keys(audioOccupancy).length
    && !provenance
    && !Object.keys(visualConditioningByAsset).length) {
    return null;
  }

  return {
    entryVideoHistoryId,
    holdLoopVideoHistoryIds,
    exitByTransition,
    audioOccupancy,
    ...(provenance ? { provenance } : {}),
    ...(Object.keys(visualConditioningByAsset).length ? { visualConditioningByAsset } : {}),
  };
}

/**
 * Sanitize interactionWindow node field.
 */
export function sanitizeInteractionWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const enabled = raw.enabled === true;
  const protagonistCharacterId = isStr(raw.protagonistCharacterId)
    ? trimTo(raw.protagonistCharacterId, LOOM_LIMITS.REF_ID_MAX || 64)
    : null;

  const protagonistPresence = FABLELOOM_PROTAGONIST_PRESENCE.includes(raw.protagonistPresence)
    ? raw.protagonistPresence
    : FABLELOOM_PROTAGONIST_PRESENCE_DEFAULT;

  const audioTarget = FABLELOOM_AUDIO_TARGETS.includes(raw.audioTarget)
    ? raw.audioTarget
    : FABLELOOM_AUDIO_TARGET_DEFAULT;

  const ambientDuckDb = Number.isFinite(raw.ambientDuckDb)
    ? clamp(
      Math.round(raw.ambientDuckDb),
      LOOM_LIMITS.AMBIENT_DUCK_DB_MIN || -60,
      LOOM_LIMITS.AMBIENT_DUCK_DB_MAX || 0,
    )
    : (LOOM_LIMITS.AMBIENT_DUCK_DB_DEFAULT || -8);

  const holdLoopRotation = FABLELOOM_HOLD_ROTATION_MODES.includes(raw.holdLoopRotation)
    ? raw.holdLoopRotation
    : FABLELOOM_HOLD_ROTATION_MODE_DEFAULT;

  return {
    enabled,
    protagonistCharacterId,
    protagonistPresence,
    audioTarget,
    ambientDuckDb,
    holdLoopRotation,
  };
}

/**
 * Resolve which video asset should be active for a given playback phase and node.
 * Backward compatible with legacy nodes having only videoHistoryId.
 */
export function resolvePlaybackPhaseAsset({
  node,
  phase = 'entry',
  activeHoldIndex = 0,
  transitionId = null,
  seed = 0,
  iteration = 0,
} = {}) {
  if (!node) {
    return {
      phase: 'ended',
      videoHistoryId: null,
      audioOccupancy: null,
      safeForLiveVoice: true,
      isEntry: false,
      isHold: false,
      isExit: false,
    };
  }

  const assets = node.playbackAssets || null;
  const legacyVideoId = node.videoHistoryId || null;

  let selectedVideoId = null;
  let effectivePhase = phase;

  if (effectivePhase === 'entry') {
    selectedVideoId = assets?.entryVideoHistoryId || legacyVideoId || null;
    // If no entry video, try to fall back to hold loop or legacy video
    if (!selectedVideoId && assets?.holdLoopVideoHistoryIds?.length) {
      selectedVideoId = assets.holdLoopVideoHistoryIds[0];
      effectivePhase = 'hold';
    }
  } else if (effectivePhase === 'hold') {
    const holdIds = (assets?.holdLoopVideoHistoryIds?.length)
      ? assets.holdLoopVideoHistoryIds
      : (assets?.entryVideoHistoryId ? [assets.entryVideoHistoryId] : (legacyVideoId ? [legacyVideoId] : []));

    if (holdIds.length > 0) {
      const rotationMode = node.interactionWindow?.holdLoopRotation || 'deterministic';
      let index = 0;
      if (rotationMode === 'sequential') {
        index = Math.abs(activeHoldIndex) % holdIds.length;
      } else if (rotationMode === 'shuffle') {
        // deterministic pseudo-random from seed and iteration
        const hash = Math.abs((Number(seed) || 0) * 31 + (Number(iteration) || 0) * 17 + Number(activeHoldIndex));
        index = hash % holdIds.length;
      } else {
        // deterministic
        index = (Math.abs(Number(seed) || 0) + Number(iteration) + Number(activeHoldIndex)) % holdIds.length;
      }
      selectedVideoId = holdIds[index] || holdIds[0];
    }
  } else if (effectivePhase === 'exit') {
    if (transitionId && assets?.exitByTransition?.[transitionId]) {
      selectedVideoId = assets.exitByTransition[transitionId];
    } else {
      selectedVideoId = null;
    }
  } else if (effectivePhase === 'ended') {
    selectedVideoId = null;
  }

  const audioOccupancy = (selectedVideoId && assets?.audioOccupancy?.[selectedVideoId])
    ? validateAudioOccupancy(assets.audioOccupancy[selectedVideoId])
    : null;

  const safeForLiveVoice = audioOccupancy ? audioOccupancy.safeForLiveVoice : true;

  return {
    phase: effectivePhase,
    videoHistoryId: selectedVideoId,
    audioOccupancy,
    safeForLiveVoice,
    isEntry: effectivePhase === 'entry',
    isHold: effectivePhase === 'hold',
    isExit: effectivePhase === 'exit',
  };
}

/**
 * Inspect a scene node for production readiness and live voice safety.
 * Pure deterministic preflight check — NO AI / provider calls!
 */
export function inspectNodeProductionReadiness(node, { universe = null, loom = null } = {}) {
  const findings = [];
  const push = (code, severity, message, remediation, extra = {}) => {
    findings.push({ code, severity, message, remediation, ...extra });
  };

  if (!node) {
    return { ready: false, findings: [{ code: 'NO_NODE', severity: 'error', message: 'No scene provided.', remediation: 'Select a scene.' }] };
  }

  const assets = node.playbackAssets;
  const interaction = node.interactionWindow;

  // Check audio occupancy safety on hold loops
  if (assets?.holdLoopVideoHistoryIds?.length) {
    for (const holdId of assets.holdLoopVideoHistoryIds) {
      const occ = assets.audioOccupancy?.[holdId];
      if (occ) {
        const validated = validateAudioOccupancy(occ);
        if (validated.characterDialogue.length > 0) {
          push(
            'HOLD_ASSET_HAS_DIALOGUE',
            'error',
            `Hold loop "${holdId}" contains rendered character dialogue and cannot open a live voice window.`,
            'Render dialogue separately or remove speech lane from hold loop.',
            { assetId: holdId },
          );
        }
        if (validated.effects.some((e) => e.blocking)) {
          push(
            'HOLD_ASSET_HAS_BLOCKING_EFFECTS',
            'warning',
            `Hold loop "${holdId}" contains author-marked voice-blocking sound effects.`,
            'Adjust effect intervals or unmark blocking flag.',
            { assetId: holdId },
          );
        }
      }
    }
  }

  // Check interaction window prerequisites
  if (interaction?.enabled) {
    if (node.isEnding) {
      push(
        'INTERACTION_ON_ENDING',
        'error',
        'Live interaction cannot be enabled on an ending scene.',
        'Disable live interaction on ending scene.',
      );
    }

    if (node.playbackMode === 'cut') {
      push(
        'INTERACTION_ON_CUT',
        'warning',
        'Scene is an automatic cut; live voice interaction will be bypassed.',
        'Change playback behavior to decision point or disable interaction.',
      );
    }

    if (interaction.protagonistPresence === 'onscreen') {
      push(
        'PROTAGONIST_ONSCREEN',
        'warning',
        'Live voice currently requires off-screen protagonist presence to avoid lip-sync mismatch.',
        'Set protagonist presence to off-screen.',
      );
    }

    if (!interaction.protagonistCharacterId) {
      push(
        'MISSING_PROTAGONIST_CHARACTER',
        'error',
        'Live interaction is enabled but no protagonist character is bound.',
        'Select a protagonist character in scene settings.',
      );
    } else if (universe && Array.isArray(universe.characters)) {
      const found = universe.characters.some((c) => c.id === interaction.protagonistCharacterId);
      if (!found) {
        push(
          'PROTAGONIST_NOT_IN_UNIVERSE',
          'error',
          `Bound protagonist character "${interaction.protagonistCharacterId}" does not exist in the linked Universe.`,
          'Re-bind a valid character from the Universe.',
        );
      }
    }

    if (loom?.participationMode === 'helper' && node.audienceConnection !== 'connected') {
      push(
        'DISCONNECTED_INTERACTION',
        'error',
        'Live interaction is enabled while the audience communication channel is disconnected.',
        'Set audience connection to connected or disable interaction.',
      );
    }

    const hasHoldAsset = (assets?.holdLoopVideoHistoryIds?.length > 0)
      || !!assets?.entryVideoHistoryId
      || !!node.videoHistoryId;

    if (!hasHoldAsset) {
      push(
        'NO_HOLD_ASSET',
        'warning',
        'No hold loop or video asset is rendered for this live conversation scene.',
        'Generate or attach a hold loop video asset.',
      );
    }
  }

  // Optional transition exit check
  const transitions = node.transitions || [];
  if (assets && transitions.length > 0) {
    const missingExits = transitions.filter((t) => !assets.exitByTransition?.[t.id]);
    if (missingExits.length > 0 && Object.keys(assets.exitByTransition || {}).length > 0) {
      push(
        'PARTIAL_EXIT_CLIPS',
        'info',
        `${missingExits.length} of ${transitions.length} transition(s) do not have exit clips and will cut directly to target scene.`,
        'Render and attach matching exit clips if continuous transition is desired.',
      );
    }
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  return {
    ready: errorCount === 0,
    errorCount,
    warningCount,
    findings,
  };
}

/**
 * Inspect all scenes in an episode for production readiness.
 */
export function inspectEpisodeProductionReadiness(episode, { universe = null, loom = null } = {}) {
  const nodes = Array.isArray(episode?.nodes) ? episode.nodes : [];
  const nodeResults = {};
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const node of nodes) {
    const res = inspectNodeProductionReadiness(node, { universe, loom });
    nodeResults[node.id] = res;
    totalErrors += res.errorCount;
    totalWarnings += res.warningCount;
  }

  return {
    ready: totalErrors === 0,
    totalErrors,
    totalWarnings,
    nodeResults,
  };
}
