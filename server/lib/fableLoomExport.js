import { BIBLE_LIMITS } from './bibleLimits.js';
import { narrationFormatContract } from './fableLoomFormats.js';
import { analyzeEpisodeGraph, computeGraphLayers } from './fableLoomGraph.js';
import { analyzeSeriesStoryOutlines } from './fableLoomOutline.js';
import {
  asFableLoomPlaybackMode, FABLELOOM_RUNTIME_VERSION,
  inspectEpisodeProductionReadiness, resolveFableLoomProtagonistPresence,
  sanitizeInteractionWindow, validateAudioOccupancy,
} from './fableLoomPlayback.js';
import { trimTo } from './textUtils.js';

export const FABLELOOM_EXPORT_SCHEMA_VERSION = '1.0.0';
export const FABLELOOM_EXPORT_LIMITS = Object.freeze({
  maxJobs: 4,
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxAssetBytes: 64 * 1024 * 1024,
  maxPackageBytes: 256 * 1024 * 1024,
});

/** Only reachable scenes need media; structural and outline errors still block export. */
export function inspectFableLoomExport(loom, episodes, universe) {
  const selected = new Set(episodes.map(e => e.id));
  const findings = analyzeSeriesStoryOutlines(loom).issues
    .filter(issue => selected.has(issue.episodeId))
    .map(issue => ({ ...issue, gate: 'outline' }));
  if (selected.size !== episodes.length || episodes.some(e => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(e.id))) {
    findings.push({ gate: 'graph', code: 'INVALID_EXPORT_EPISODES', severity: 'error',
      message: 'Episode identifiers must be unique portable identifiers.' });
  }
  for (const episode of episodes) {
    const graph = analyzeEpisodeGraph(episode, {
      participationMode: loom.participationMode,
      requireAudienceIntroduction: episode.id === loom.episodes[0]?.id,
    });
    findings.push(...graph.issues.map(issue => ({ ...issue, gate: 'graph', episodeId: episode.id })));
    const ids = new Set();
    for (const node of episode.nodes) {
      const transitionIds = new Set();
      for (const id of [node.id, ...node.transitions.map(t => t.id)]) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
          findings.push({ gate: 'graph', code: 'INVALID_EXPORT_ID', severity: 'error', episodeId: episode.id,
            message: 'Scene and transition identifiers must be portable identifiers.' });
        }
      }
      if (ids.has(node.id) || node.transitions.some(t => {
        const duplicate = transitionIds.has(t.id);
        transitionIds.add(t.id);
        return duplicate;
      })) {
        findings.push({ gate: 'graph', code: 'DUPLICATE_EXPORT_ID', severity: 'error', episodeId: episode.id,
          message: 'Scene identifiers and each scene’s transition identifiers must be unique.' });
      }
      ids.add(node.id);
    }
    const reachable = computeGraphLayers(episode).depthById;
    const ready = inspectEpisodeProductionReadiness({
      ...episode, nodes: episode.nodes.filter(n => reachable.has(n.id)),
    }, { loom, universe });
    for (const [nodeId, result] of Object.entries(ready.nodeResults)) {
      findings.push(...result.findings.map(issue => ({ ...issue, gate: 'production', episodeId: episode.id, nodeId })));
    }
  }
  return findings;
}

/** Explicit source references, never filenames reconstructed from a history id. */
export function fableLoomExportAssetRequests(node) {
  const assets = node.playbackAssets;
  const entryId = assets?.entryVideoHistoryId || node.videoHistoryId || null;
  const holds = node.isEnding || asFableLoomPlaybackMode(node.playbackMode) === 'cut'
    ? [] : (assets?.holdLoopVideoHistoryIds?.length ? assets.holdLoopVideoHistoryIds : [entryId]);
  return [
    { role: 'still', kind: 'image', sourceId: node.image },
    { role: 'entry', kind: 'video', sourceId: entryId },
    ...holds.map((sourceId, index) => ({ role: 'hold', kind: 'video', sourceId, index })),
    ...node.transitions.filter(t => assets?.exitByTransition?.[t.id])
      .map(t => ({ role: 'exit', kind: 'video', sourceId: assets.exitByTransition[t.id], transitionId: t.id })),
  ];
}

/** Machine-local configuration and provider prompts are deliberately absent. */
export function projectFableLoomExportNode(node, loom, assets) {
  const window = sanitizeInteractionWindow(node.interactionWindow);
  return {
    id: node.id, title: node.title, prose: node.prose,
    playbackMode: asFableLoomPlaybackMode(node.playbackMode),
    audienceConnection: node.audienceConnection,
    protagonistPresence: resolveFableLoomProtagonistPresence(node, loom) || 'offscreen',
    challengePhase: node.challengePhase ?? null,
    isEnding: node.isEnding === true, endingLabel: node.endingLabel || '',
    transitions: node.transitions.map(t => ({
      id: t.id, intent: t.intent, triggers: t.triggers, description: t.description, targetNodeId: t.targetNodeId,
    })),
    interactionWindow: window && {
      enabled: window.enabled, protagonistPresence: window.protagonistPresence,
      audioTarget: window.audioTarget, ambientDuckDb: window.ambientDuckDb, holdLoopRotation: window.holdLoopRotation,
    },
    playbackAssets: {
      still: assets.find(a => a.role === 'still')?.playback ?? null,
      entry: assets.find(a => a.role === 'entry')?.playback ?? null,
      holds: assets.filter(a => a.role === 'hold').map(a => a.playback),
      exits: Object.fromEntries(assets.filter(a => a.role === 'exit').map(a => [a.transitionId, a.playback])),
    },
  };
}

export function projectFableLoomExportManifest(loom, episodes, portosVersion) {
  return {
    schemaVersion: FABLELOOM_EXPORT_SCHEMA_VERSION, runtimeVersion: FABLELOOM_RUNTIME_VERSION, portosVersion,
    loom: {
      name: loom.name, logline: loom.logline, participationMode: loom.participationMode,
      audienceCommunicationMedium: loom.audienceCommunicationMedium, format: loom.format, episodes,
    },
  };
}

const PORTABLE_CHARACTER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VOICE_PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const VOICE_AUDIO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(wav|mp3|flac|ogg|m4a)$/i;
const VOICE_REFERENCE_POSTURES = new Set([
  'generated-original-voice', 'licensed', 'designed', 'consented-performance',
]);
// Same portable postures as Universe voiceCanon.sourcePolicy. Duplicated so this
// projection does not import the story-bible sanitizer (crypto + file IO).
const VOICE_CANON_SOURCE_POLICIES = new Set(['designed', 'consented-performance', 'licensed']);

const text = (value, max) => trimTo(value, max);
const textList = (value, itemMax, max) => {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const line = text(item, itemMax);
    if (!line) continue;
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
};

/**
 * Canonical cast for one export: the loom protagonist plus characters staged
 * on reachable scenes (visual bindings and interaction speakers). Unreachable
 * scenes and the rest of the universe stay out — a universe is not the cast.
 */
export function fableLoomExportCastIds(loom, episodes) {
  const ids = new Set();
  if (typeof loom?.protagonistCharacterId === 'string' && loom.protagonistCharacterId) {
    ids.add(loom.protagonistCharacterId);
  }
  for (const episode of episodes || []) {
    const reachable = computeGraphLayers(episode).depthById;
    for (const node of episode?.nodes || []) {
      if (!reachable.has(node?.id)) continue;
      for (const appearance of node.visualCanon?.characterAppearances || []) {
        if (typeof appearance?.characterId === 'string' && appearance.characterId) ids.add(appearance.characterId);
      }
      const speaker = node.interactionWindow?.protagonistCharacterId;
      if (typeof speaker === 'string' && speaker) ids.add(speaker);
    }
  }
  return [...ids].sort();
}

function projectCharacter(character, { role, narrationFormat, draftFlags }) {
  const canon = character.voiceCanon && typeof character.voiceCanon === 'object' ? character.voiceCanon : {};
  const pronunciations = [];
  for (const item of Array.isArray(canon.pronunciations) ? canon.pronunciations : []) {
    const term = text(item?.term, BIBLE_LIMITS.VOICE_CANON_PRONUNCIATION_TERM_MAX);
    const pronunciation = text(item?.pronunciation, BIBLE_LIMITS.VOICE_CANON_PRONUNCIATION_VALUE_MAX);
    if (!term || !pronunciation) continue;
    pronunciations.push({ term, pronunciation });
    if (pronunciations.length >= BIBLE_LIMITS.VOICE_CANON_PRONUNCIATIONS_MAX) break;
  }
  const sourcePolicy = VOICE_CANON_SOURCE_POLICIES.has(canon.sourcePolicy) ? canon.sourcePolicy : null;
  const version = Number.isInteger(canon.version) && canon.version > 0
    && canon.version <= BIBLE_LIMITS.VOICE_CANON_VERSION_MAX ? canon.version : null;
  const approved = canon.approved === true;
  const persona = {
    personality: text(character.personality, BIBLE_LIMITS.PERSONALITY_MAX),
    speechAccent: text(character.speechAccent, BIBLE_LIMITS.SPEECH_ACCENT_MAX),
    speechPattern: text(character.speechPattern, BIBLE_LIMITS.SPEECH_PATTERN_MAX),
    mannerisms: text(character.mannerisms, BIBLE_LIMITS.MANNERISMS_MAX),
  };
  const speech = {
    description: text(canon.description, BIBLE_LIMITS.VOICE_CANON_DESCRIPTION_MAX),
    defaultDelivery: text(canon.defaultDelivery, BIBLE_LIMITS.VOICE_CANON_DELIVERY_MAX),
    emotionalRange: textList(canon.emotionalRange, BIBLE_LIMITS.VOICE_CANON_RANGE_ITEM_MAX, BIBLE_LIMITS.VOICE_CANON_RANGE_MAX),
  };
  const neverSay = textList(canon.avoid, BIBLE_LIMITS.VOICE_CANON_AVOID_ITEM_MAX, BIBLE_LIMITS.VOICE_CANON_AVOID_MAX);
  return {
    schemaVersion: FABLELOOM_EXPORT_SCHEMA_VERSION,
    id: character.id,
    name: text(character.name, BIBLE_LIMITS.NAME_MAX),
    role,
    persona,
    speech,
    pronunciations,
    safety: { neverSay },
    playTurn: {
      promptId: 'fableloom-play-turn',
      contractVersion: FABLELOOM_RUNTIME_VERSION,
      inputs: {
        characterId: character.id,
        name: text(character.name, BIBLE_LIMITS.NAME_MAX),
        role,
        ...persona,
        voiceDescription: speech.description,
        defaultDelivery: speech.defaultDelivery,
        emotionalRange: speech.emotionalRange,
        pronunciations,
        neverSay,
        narrationFormat,
      },
    },
    approval: {
      voiceCanonVersion: version,
      approved,
      sourcePolicy,
      draftFlags,
    },
  };
}

/**
 * Project the canonical cast. voiceCanon.approved is the portable approval
 * contract. allowDraft records the same unapproved/unknown flags as scene
 * media and still emits the projection; it does not invent approval.
 */
export function inspectFableLoomExportCharacters(loom, episodes, universe, { allowDraft = false } = {}) {
  const findings = [];
  const characters = [];
  const ids = fableLoomExportCastIds(loom, episodes);
  if (!ids.length) {
    findings.push({
      gate: 'cast', severity: 'error', code: 'EXPORT_CAST_MISSING',
      message: 'Character export needs a protagonist or a character staged on a reachable scene.',
    });
    return { findings, characters };
  }
  const byId = new Map();
  for (const character of Array.isArray(universe?.characters) ? universe.characters : []) {
    if (character && typeof character.id === 'string' && !byId.has(character.id)) byId.set(character.id, character);
  }
  const narrationFormat = narrationFormatContract(loom?.format);
  for (const id of ids) {
    if (!PORTABLE_CHARACTER_ID.test(id)) {
      findings.push({
        gate: 'cast', severity: 'error', code: 'EXPORT_CHARACTER_ID',
        message: 'Character identifiers must be portable identifiers.',
      });
      continue;
    }
    const character = byId.get(id);
    if (!character) {
      findings.push({
        gate: 'cast', severity: 'error', code: 'EXPORT_CHARACTER_MISSING', characterId: id,
        message: `Character "${id}" is not in the linked universe.`,
      });
      continue;
    }
    const canon = character.voiceCanon;
    const knownCanon = Boolean(canon && typeof canon === 'object' && !Array.isArray(canon));
    const draftFlags = canon?.approved === true ? [] : [knownCanon ? 'unapproved' : 'unknown'];
    if (draftFlags.length) {
      findings.push({
        gate: 'approval', severity: allowDraft ? 'warning' : 'error', code: 'EXPORT_CHARACTER_DRAFT',
        characterId: id,
        message: `Character "${id}" has no approved voice canon.`,
      });
    }
    characters.push(projectCharacter(character, {
      role: id === loom?.protagonistCharacterId ? 'protagonist' : 'cast',
      narrationFormat,
      draftFlags,
    }));
  }
  return { findings, characters };
}

const referencePosture = (asset, sourcePolicy, kind) => {
  const license = typeof asset?.licensePosture === 'string' ? asset.licensePosture : '';
  // A clone or a consented-performance claim needs the performer's consent even
  // when another posture label is also present. Designed and licensed references
  // are the postures that can travel without that confirmation.
  const needsConsent = kind === 'cloned'
    || sourcePolicy === 'consented-performance'
    || license === 'consented-performance';
  if (needsConsent) return asset?.performerConsentConfirmed === true ? 'ok' : 'consent-missing';
  if (asset?.performerConsentConfirmed === true) return 'ok';
  if (license === 'generated-original-voice' || license === 'licensed' || license === 'designed') return 'ok';
  return 'skip';
};

/**
 * One approved interactive profile, matching the live-voice approval check.
 * Reference bytes export only with consent or an allowlisted designed/licensed
 * posture. Unlabeled and unconsented recordings are never packaged.
 */
export function selectFableLoomExportVoice(profiles, { universeId, characterId, sourcePolicy = null } = {}) {
  const approved = (Array.isArray(profiles) ? profiles : []).filter(profile => (
    profile?.approval?.status === 'approved'
    && profile?.binding?.characterId === characterId
    && profile?.binding?.universeId === universeId
    && profile?.routes?.interactive?.enabled === true
  ));
  if (approved.length === 0) {
    return {
      ok: false, gate: 'approval', code: 'EXPORT_VOICE_UNAPPROVED',
      message: `Character "${characterId}" has no approved interactive voice profile.`,
    };
  }
  if (approved.length > 1) {
    return {
      ok: false, gate: 'approval', code: 'EXPORT_VOICE_AMBIGUOUS',
      message: `Character "${characterId}" has more than one approved interactive voice profile.`,
    };
  }
  const profile = approved[0];
  if (!VOICE_PROFILE_ID.test(profile.id || '')) {
    return {
      ok: false, gate: 'media', code: 'EXPORT_VOICE_REFERENCE_INVALID',
      message: `Character "${characterId}" approved voice reference is not a managed audio asset.`,
    };
  }
  const assets = [];
  let rejectedConsent = false;
  for (const asset of Array.isArray(profile.sourceAssets) ? profile.sourceAssets : []) {
    const filename = typeof asset?.filename === 'string' ? asset.filename : '';
    const sha256 = typeof asset?.sha256 === 'string' ? asset.sha256.toLowerCase() : '';
    if (!VOICE_AUDIO_NAME.test(filename) || !/^[a-f0-9]{64}$/.test(sha256)) continue;
    const posture = referencePosture(asset, sourcePolicy, profile.kind);
    if (posture === 'consent-missing') {
      rejectedConsent = true;
      continue;
    }
    if (posture !== 'ok') continue;
    const licensePosture = VOICE_REFERENCE_POSTURES.has(asset.licensePosture) ? asset.licensePosture : null;
    assets.push({
      filename, sha256, consentConfirmed: asset.performerConsentConfirmed === true, licensePosture,
    });
  }
  assets.sort((a, b) => a.sha256.localeCompare(b.sha256) || a.filename.localeCompare(b.filename));
  const unique = [];
  for (const asset of assets) {
    if (unique.some(item => item.sha256 === asset.sha256)) continue;
    unique.push(asset);
  }
  if (!unique.length) {
    return rejectedConsent ? {
      ok: false, gate: 'approval', code: 'EXPORT_VOICE_CONSENT_MISSING',
      message: `Character "${characterId}" voice reference has no confirmed consent.`,
    } : {
      ok: false, gate: 'media', code: 'EXPORT_VOICE_REFERENCE_MISSING',
      message: `Character "${characterId}" has no approved voice reference audio.`,
    };
  }
  return { ok: true, profileId: profile.id, assets: unique };
}

/** Occupancy keys refer to packaged bytes, and never to a local history record. */
export function fableLoomExportOccupancy(node, sourceId) {
  const raw = node.playbackAssets?.audioOccupancy?.[sourceId];
  if (!raw) return null;
  const occupancy = validateAudioOccupancy(raw);
  const intervals = list => list.map(({ startMs, endMs, blocking }) => ({
    startMs, endMs, ...(blocking === true ? { blocking: true } : {}),
  }));
  return {
    durationMs: occupancy.durationMs, characterDialogue: intervals(occupancy.characterDialogue),
    music: intervals(occupancy.music), effects: intervals(occupancy.effects),
    clipping: occupancy.clipping, safeForLiveVoice: occupancy.safeForLiveVoice,
  };
}
