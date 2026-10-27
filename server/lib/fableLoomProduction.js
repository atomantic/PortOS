/**
 * FableLoom production batch planning and topological orchestration.
 *
 * Pure, side-effect-free helpers for enumerating planned production assets
 * across reachable graph nodes, computing topological execution batches,
 * evaluating readiness gates, and verifying exact-input provenance.
 */

import { analyzeEpisodeShots } from './fableLoomShots.js';
import { computeGraphLayers } from './fableLoomGraph.js';
import { EFFORT_LEVELS } from './providerModels.js';
import { validateAudioOccupancy } from './fableLoomPlayback.js';
import { QUEUEABLE_IMAGE_MODES, VIDEO_GEN_MODES } from './generationModes.js';
import { isNonBlankStr } from './textUtils.js';

export const FABLELOOM_PRODUCTION_MODES = Object.freeze(['current_canon', 'exact_inputs']);
export const FABLELOOM_PRODUCTION_MODE_DEFAULT = 'current_canon';

// One format owns both storyboard stills and motion renders so an episode
// cannot accidentally mix a portrait image with a landscape clip. These are
// deliberately concrete render sizes, not ratio labels alone: every provider
// receives an explicit width/height instead of falling through to its own
// (often square or portrait) default. 16:9 is the FableLoom default because the
// hosted experience is composed as a cinematic screen.
export const FABLELOOM_RENDER_FORMATS = Object.freeze([
  Object.freeze({ formatId: 'landscape-16-9', label: '16:9 landscape', aspectRatio: '16:9', width: 1024, height: 576 }),
  Object.freeze({ formatId: 'portrait-9-16', label: '9:16 portrait', aspectRatio: '9:16', width: 576, height: 1024 }),
  Object.freeze({ formatId: 'square-1-1', label: '1:1 square', aspectRatio: '1:1', width: 1024, height: 1024 }),
  Object.freeze({ formatId: 'classic-4-3', label: '4:3 landscape', aspectRatio: '4:3', width: 1024, height: 768 }),
]);
export const FABLELOOM_RENDER_FORMAT_IDS = Object.freeze(
  FABLELOOM_RENDER_FORMATS.map((format) => format.formatId),
);
export const FABLELOOM_DEFAULT_RENDER_FORMAT_ID = 'landscape-16-9';

// These preferences are intentionally part of the loom's persisted render
// settings rather than the production panel's transient request controls. A
// story can therefore render the same way from a scene card, a batch, or a
// fresh page load; the production panel may still override them for one run.
export const FABLELOOM_RENDER_PREFERENCE_KEYS = Object.freeze([
  'imageMode', 'imageModel', 'videoMode', 'videoModel', 'effort',
]);

const isRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.hasOwn(value, key);
const trimModelId = (value) => (typeof value === 'string' && value.trim()
  ? value.trim().slice(0, 64)
  : null);

const recordedFileChecksumIssue = ({ label, filename, relativePath, sha256 }, installedByFilename) => {
  if (!isNonBlankStr(filename)) return `Recorded character ${label} has no filename.`;
  if (!isNonBlankStr(sha256)) {
    return `Recorded character ${label} "${filename}" has no checksum to verify exact inputs.`;
  }
  const installedFile = installedByFilename.find((file) => file?.filename === filename
    && (relativePath ? file.relativePath === relativePath : !file.relativePath || file.relativePath === filename));
  if (!installedFile) return `Recorded character ${label} "${filename}" is not installed locally.`;
  if (!isNonBlankStr(installedFile.sha256)) {
    return `Installed character ${label} "${filename}" has no checksum to verify exact inputs.`;
  }
  if (installedFile.sha256 !== sha256) {
    return `Recorded character ${label} "${filename}" checksum mismatch (expected ${sha256}, found ${installedFile.sha256}).`;
  }
  return null;
};

const exactVoiceProfileIssues = ({ characterId, universeId, recordedVersion, recordedEngine, recordedModelRev, profile }) => {
  const issues = [];
  if (profile.binding?.characterId && profile.binding.characterId !== characterId) {
    issues.push(`Recorded voice profile "${profile.id}" is bound to a different character.`);
  }
  if (universeId && profile.binding?.universeId && profile.binding.universeId !== universeId) {
    issues.push(`Recorded voice profile "${profile.id}" belongs to a different Universe.`);
  }
  if (!Number.isFinite(recordedVersion) || profile.version !== recordedVersion) {
    issues.push(`Recorded voice profile "${profile.id}" version mismatch (recorded v${recordedVersion ?? 'unknown'}, current local v${profile.version ?? 'unknown'}).`);
  }
  if (!isNonBlankStr(recordedEngine) || !isNonBlankStr(profile.engine) || profile.engine !== recordedEngine) {
    issues.push(`Recorded voice profile "${profile.id}" engine mismatch (recorded ${recordedEngine || 'unknown'}, current local ${profile.engine || 'unknown'}).`);
  }
  if (!isNonBlankStr(recordedModelRev) || !isNonBlankStr(profile.modelRevision) || profile.modelRevision !== recordedModelRev) {
    issues.push(`Recorded voice profile "${profile.id}" model revision mismatch (recorded ${recordedModelRev || 'unknown'}, current local ${profile.modelRevision || 'unknown'}).`);
  }
  return issues;
};

/**
 * Normalize the optional provider/model preferences on a loom render pin.
 * Image and video model ids are local-model selections; cloud backends use
 * their configured model, so a cloud mode clears an accidentally retained
 * local model rather than presenting a misleading pin to the planner.
 */
export function asFableLoomRenderPreferences(raw) {
  const source = isRecord(raw) ? raw : {};
  const imageMode = QUEUEABLE_IMAGE_MODES.includes(source.imageMode) ? source.imageMode : null;
  const videoMode = VIDEO_GEN_MODES.includes(source.videoMode) ? source.videoMode : null;
  return {
    imageMode,
    imageModel: imageMode && imageMode !== 'local' ? null : trimModelId(source.imageModel),
    videoMode,
    videoModel: videoMode && videoMode !== 'local' ? null : trimModelId(source.videoModel),
    effort: EFFORT_LEVELS.includes(source.effort) ? source.effort : null,
  };
}

/**
 * Sanitize the full persisted render-settings shape while keeping legacy
 * records byte-compatible when they have no provider preferences yet.
 */
export function sanitizeFableLoomRenderSettings(raw) {
  const geometry = asFableLoomRenderSettings(raw);
  if (!isRecord(raw) || !FABLELOOM_RENDER_PREFERENCE_KEYS.some((key) => hasOwn(raw, key))) {
    return geometry;
  }
  return { ...geometry, ...asFableLoomRenderPreferences(raw) };
}

/** Merge a partial format/preferences PATCH before the record is re-sanitized. */
export function mergeFableLoomRenderSettings(current, patch) {
  if (!isRecord(patch)) return patch;
  return { ...(isRecord(current) ? current : {}), ...patch };
}

export function asFableLoomRenderSettings(raw) {
  const requestedId = typeof raw === 'string' ? raw : raw?.formatId;
  const selected = FABLELOOM_RENDER_FORMATS.find((format) => format.formatId === requestedId)
    || FABLELOOM_RENDER_FORMATS.find((format) => format.formatId === FABLELOOM_DEFAULT_RENDER_FORMAT_ID);
  return {
    formatId: selected.formatId,
    aspectRatio: selected.aspectRatio,
    width: selected.width,
    height: selected.height,
  };
}

export const FABLELOOM_ASSET_TYPES = Object.freeze([
  'image',
  'video_entry',
  'video_hold',
  'video_exit',
  'dialogue',
]);

const isLockedCanon = (node) => Boolean(node?.visualCanon && node.visualCanon.mode !== 'draft');

const EXACT_RENDER_KEYS = Object.freeze({
  image: Object.freeze({
    local: Object.freeze(['width', 'height', 'aspectRatio', 'steps', 'guidance', 'quantize', 'seed']),
    cloud: Object.freeze(['width', 'height', 'aspectRatio', 'mode']),
  }),
  video: Object.freeze({
    local: Object.freeze([
      'width', 'height', 'aspectRatio', 'numFrames', 'fps', 'steps', 'guidanceScale', 'seed', 'mode',
      'tiling', 'disableAudio',
    ]),
    cloud: Object.freeze(['width', 'height', 'aspectRatio', 'mode', 'videoMode']),
  }),
});

const validRenderParameter = (key, value) => {
  if (['aspectRatio', 'mode', 'videoMode', 'tiling'].includes(key)) return isNonBlankStr(value);
  if (key === 'disableAudio') return typeof value === 'boolean';
  if (key === 'quantize') return isNonBlankStr(value) || Number.isFinite(value);
  if (!Number.isFinite(value)) return false;
  if (['seed', 'guidance', 'guidanceScale'].includes(key)) return value >= 0;
  return value > 0;
};

/** Validate the atomic render tuple required for exact-input reproduction. */
export function exactRenderParameterIssues(recordedProvenance) {
  const capability = recordedProvenance?.capability || {};
  const kind = capability.kind;
  const backendFamily = capability.backend === 'local' ? 'local' : 'cloud';
  const required = EXACT_RENDER_KEYS[kind]?.[backendFamily];
  if (!required) return ['Recorded visual conditioning has no supported render capability.'];
  const parameters = recordedProvenance?.render?.parameters;
  if (!parameters || typeof parameters !== 'object') {
    return ['Recorded visual conditioning has no effective render parameters.'];
  }
  const issues = required
    .filter((key) => !validRenderParameter(key, parameters[key]))
    .map((key) => `Recorded ${kind} render parameter "${key}" is missing or invalid.`);
  if (issues.length) return issues;
  const [ratioWidth, ratioHeight] = parameters.aspectRatio.split(':').map(Number);
  if (!(ratioWidth > 0 && ratioHeight > 0)) {
    return ['Recorded render aspectRatio is invalid.'];
  }
  const recordedRatio = parameters.width / parameters.height;
  const declaredRatio = ratioWidth / ratioHeight;
  if (Math.abs(recordedRatio - declaredRatio) / declaredRatio > 0.02) {
    return ['Recorded render width, height, and aspectRatio do not describe the same format.'];
  }
  return [];
}

/**
 * Compute the topological ordering of reachable nodes in an episode graph,
 * respecting graph convergence and path-specific predecessors.
 */
export function computeTopologicalNodeOrder(episode) {
  const nodes = Array.isArray(episode?.nodes) ? episode.nodes : [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const startId = episode?.startNodeId;

  if (!startId || !nodeById.has(startId)) {
    return {
      orderedNodes: [],
      depthById: new Map(),
      predecessorsByNodeId: new Map(),
      convergenceNodeIds: new Set(),
      unreachableNodeIds: new Set(nodes.map((n) => n.id)),
    };
  }

  const { depthById } = computeGraphLayers(episode);
  const predecessorsByNodeId = new Map();
  for (const node of nodes) {
    predecessorsByNodeId.set(node.id, []);
  }

  for (const node of nodes) {
    if (!depthById.has(node.id)) continue;
    for (const tr of (node.transitions || [])) {
      const targetId = tr?.targetNodeId;
      if (targetId && nodeById.has(targetId)) {
        const preds = predecessorsByNodeId.get(targetId) || [];
        if (!preds.some((p) => p.nodeId === node.id && p.transitionId === tr.id)) {
          preds.push({ nodeId: node.id, transitionId: tr.id, intent: tr.intent || '' });
        }
        predecessorsByNodeId.set(targetId, preds);
      }
    }
  }

  const convergenceNodeIds = new Set();
  for (const [nodeId, preds] of predecessorsByNodeId.entries()) {
    if (preds.length > 1) {
      convergenceNodeIds.add(nodeId);
    }
  }

  // Sort reachable nodes by BFS layer depth, then by array position for deterministic ordering
  const orderedNodes = nodes
    .filter((n) => depthById.has(n.id))
    .sort((a, b) => {
      const depthDiff = (depthById.get(a.id) ?? 0) - (depthById.get(b.id) ?? 0);
      if (depthDiff !== 0) return depthDiff;
      return nodes.indexOf(a) - nodes.indexOf(b);
    });

  const unreachableNodeIds = new Set(
    nodes.filter((n) => !depthById.has(n.id)).map((n) => n.id),
  );

  return {
    orderedNodes,
    depthById,
    predecessorsByNodeId,
    convergenceNodeIds,
    unreachableNodeIds,
  };
}

/**
 * Keep episodic storyboard production in narrative order. A later episode may
 * be planned at any time, but it cannot start rendering until every reachable
 * scene in the preceding episodes has a still that can serve as the visual
 * continuity baseline for the next production pass.
 *
 * The check intentionally follows the loom's episode array (the same ordered
 * sequence used by the player and series plan), not numeric labels that an
 * author may have edited independently.
 */
export function inspectEpisodeProductionOrder(loom, episode) {
  const episodes = Array.isArray(loom?.episodes) ? loom.episodes : [];
  const currentIndex = episodes.findIndex((candidate) => candidate?.id === episode?.id);
  if (currentIndex < 0) {
    return {
      ready: false,
      currentEpisodeId: episode?.id || null,
      currentEpisodeNumber: episode?.number || null,
      previousEpisodeCount: 0,
      blockedBy: [],
      missingScenes: [],
      reason: 'The selected episode is not present in the loom episode order.',
    };
  }

  const missingScenes = [];
  const blockedBy = [];
  for (const [index, priorEpisode] of episodes.slice(0, currentIndex).entries()) {
    const { orderedNodes } = computeTopologicalNodeOrder(priorEpisode);
    if (!orderedNodes.length) {
      blockedBy.push({
        episodeId: priorEpisode.id,
        episodeNumber: priorEpisode.number || index + 1,
        episodeTitle: priorEpisode.title || `Episode ${priorEpisode.number || index + 1}`,
        reason: 'no-reachable-scenes',
      });
      continue;
    }
    for (const node of orderedNodes) {
      if (isNonBlankStr(node.image)) continue;
      const missing = {
        episodeId: priorEpisode.id,
        episodeNumber: priorEpisode.number || index + 1,
        episodeTitle: priorEpisode.title || `Episode ${priorEpisode.number || index + 1}`,
        nodeId: node.id,
        nodeTitle: node.title || node.id,
      };
      missingScenes.push(missing);
      if (!blockedBy.some((item) => item.episodeId === priorEpisode.id)) {
        blockedBy.push({
          episodeId: priorEpisode.id,
          episodeNumber: missing.episodeNumber,
          episodeTitle: missing.episodeTitle,
          reason: 'missing-storyboard-images',
        });
      }
    }
  }

  const currentEpisodeNumber = episode.number || currentIndex + 1;
  const firstBlocker = blockedBy[0];
  return {
    ready: blockedBy.length === 0,
    currentEpisodeId: episode.id,
    currentEpisodeNumber,
    previousEpisodeCount: currentIndex,
    blockedBy,
    missingScenes,
    reason: firstBlocker
      ? `Finish storyboard images for Episode ${firstBlocker.episodeNumber} before generating Episode ${currentEpisodeNumber}.`
      : `Episode ${currentEpisodeNumber} is next in the ordered storyboard production sequence.`,
  };
}

function verifyVisualCapabilityAndModel(capability, { availableImageModels, availableVideoModels }) {
  if (!capability || typeof capability !== 'object') {
    return ['Recorded visual conditioning has no provider capability manifest.'];
  }
  const errors = [];
  if (!isNonBlankStr(capability.backend)) errors.push('Recorded visual conditioning has no backend.');
  if (!isNonBlankStr(capability.modelId)) errors.push('Recorded visual conditioning has no model revision or model id.');
  if (capability.backend === 'local' && !isNonBlankStr(capability.modelRevision)) {
    errors.push(`Recorded local ${capability.kind || 'media'} model "${capability.modelId || 'unknown'}" has no immutable model revision to verify exact inputs.`);
  }
  // Local model registries can only verify local manifests. Cloud model ids
  // are provider-owned and are not present in the local registry, so do not
  // mistake a perfectly valid cloud provenance record for a missing local
  // model.
  const availableModels = capability.backend === 'local'
    ? (capability.kind === 'video' ? availableVideoModels : availableImageModels)
    : null;
  if (Array.isArray(availableModels) && isNonBlankStr(capability.modelId)) {
    const matchingModel = availableModels.find((model) => model?.id === capability.modelId);
    if (!matchingModel) {
      errors.push(`Recorded ${capability.kind || 'media'} model "${capability.modelId}" is not available locally.`);
    } else if (isNonBlankStr(capability.modelRevision)
      && (!isNonBlankStr(matchingModel.revision) || matchingModel.revision !== capability.modelRevision)) {
      errors.push(`Recorded ${capability.kind || 'media'} model "${capability.modelId}" revision mismatch (recorded ${capability.modelRevision}, current local ${matchingModel.revision || 'unknown'}).`);
    }
  }
  return errors;
}

function verifyRecordedVisualBindings(bindings, universe) {
  if (!bindings || typeof bindings !== 'object') {
    return ['Recorded visual conditioning has no scene bindings.'];
  }
  const errors = [];
  const appearances = Array.isArray(bindings.characterAppearances)
    ? bindings.characterAppearances
    : [];
  if (universe && Array.isArray(universe.characters)) {
    for (const appearance of appearances) {
      const charId = appearance?.characterId;
      const canonChar = universe.characters.find((character) => character.id === charId);
      if (!canonChar) {
        errors.push(`Character "${charId || 'unknown'}" in recorded visual bindings no longer exists in Universe.`);
      } else if (isNonBlankStr(appearance.wardrobeId)
        && (!Array.isArray(canonChar.wardrobes)
          || !canonChar.wardrobes.some((wardrobe) => wardrobe.id === appearance.wardrobeId))) {
        errors.push(`Wardrobe "${appearance.wardrobeId}" in recorded visual bindings is not present on character "${charId}".`);
      }
    }
  }
  if (universe && isNonBlankStr(bindings.placeId)
    && Array.isArray(universe.places)
    && !universe.places.some((place) => place.id === bindings.placeId)) {
    errors.push(`Place "${bindings.placeId}" in recorded visual bindings no longer exists in Universe.`);
  }
  if (universe && Array.isArray(bindings.objectIds) && Array.isArray(universe.objects)) {
    for (const objectId of bindings.objectIds) {
      if (!universe.objects.some((object) => object.id === objectId)) {
        errors.push(`Object "${objectId}" in recorded visual bindings no longer exists in Universe.`);
      }
    }
  }
  return errors;
}

function verifyVisualManifestEnvelopes(recordedProvenance, { installedLoras, resolveAsset }) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(recordedProvenance.assets)) {
    errors.push('Recorded visual conditioning has no asset manifest.');
  } else {
    for (const asset of recordedProvenance.assets) {
      if (!isNonBlankStr(asset?.filename)) {
        errors.push(`Recorded visual conditioning asset "${asset?.role || 'unknown'}" has no filename.`);
      } else if (typeof resolveAsset === 'function' && !resolveAsset(asset.filename)) {
        errors.push(`Recorded visual conditioning asset "${asset.filename}" is unavailable locally.`);
      }
    }
  }

  if (!Array.isArray(recordedProvenance.adapters)) {
    errors.push('Recorded visual conditioning has no adapter manifest.');
  } else {
    for (const adapter of recordedProvenance.adapters) {
      const issue = recordedFileChecksumIssue({ ...adapter, label: 'adapter' }, installedLoras);
      if (issue) errors.push(issue);
    }
  }
  if (!Array.isArray(recordedProvenance.omitted)) {
    errors.push('Recorded visual conditioning has no omitted-input manifest.');
  }
  if (!Array.isArray(recordedProvenance.warnings)) {
    warnings.push('Recorded visual conditioning has no warnings manifest.');
  }
  return { errors, warnings };
}

function verifyVisualManifest(recordedProvenance, {
  universe, installedLoras, availableImageModels, availableVideoModels, resolveAsset,
}) {
  const errors = [];
  if (recordedProvenance.version !== 1) {
    errors.push(`Recorded visual conditioning manifest version "${recordedProvenance.version ?? 'unknown'}" is unsupported.`);
  }
  if (!isNonBlankStr(recordedProvenance.compilerVersion)) {
    errors.push('Recorded visual conditioning has no compiler revision.');
  }
  if (recordedProvenance.status !== 'locked') {
    errors.push('Recorded visual conditioning is not canon-locked, so exact reproduction cannot be proven.');
  }
  errors.push(
    ...verifyVisualCapabilityAndModel(recordedProvenance.capability, { availableImageModels, availableVideoModels }),
    ...exactRenderParameterIssues(recordedProvenance),
    ...verifyRecordedVisualBindings(recordedProvenance.bindings, universe),
  );
  const envelopes = verifyVisualManifestEnvelopes(recordedProvenance, { installedLoras, resolveAsset });
  errors.push(...envelopes.errors);
  return { errors, warnings: envelopes.warnings };
}

function verifyCharacterProvenanceEntries(recordedProvenance, { universe, installedLoras, installedVoiceProfiles }) {
  const errors = [];
  const characters = Array.isArray(recordedProvenance.characters) ? recordedProvenance.characters : [];

  for (const char of characters) {
    const charId = char?.characterId;
    if (!charId) continue;

    if (universe && Array.isArray(universe.characters)
      && !universe.characters.some((c) => c.id === charId)) {
      errors.push(`Character "${charId}" in recorded provenance no longer exists in Universe.`);
    }

    if (char.lora) {
      const issue = recordedFileChecksumIssue({ ...char.lora, label: 'LoRA' }, installedLoras);
      if (issue) errors.push(issue);
    }

    if (char.voice) {
      const recordedProfileId = char.voice.profileId;
      if (!isNonBlankStr(recordedProfileId)) {
        errors.push(`Recorded voice binding for character "${charId}" has no profile id.`);
        continue;
      }

      const matchedProfile = installedVoiceProfiles.find((p) => p.id === recordedProfileId);
      if (!matchedProfile) {
        errors.push(`Recorded voice profile "${recordedProfileId}" is not installed locally.`);
        continue;
      }
      errors.push(...exactVoiceProfileIssues({
        characterId: charId,
        universeId: recordedProvenance.universeId,
        recordedVersion: char.voice.profileVersion,
        recordedEngine: char.voice.engine,
        recordedModelRev: char.voice.modelRevision,
        profile: matchedProfile,
      }));
    }
  }
  return errors;
}

/**
 * Verify recorded asset provenance against the current local environment.
 * For `exact_inputs` mode: refuses when a recorded revision/hash/model is missing
 * or mismatched, preventing silent substitution.
 */
export function verifyExactInputProvenance(recordedProvenance, {
  universe = null,
  localVoiceProfiles = [],
  localLoras = [],
  availableImageModels = null,
  availableVideoModels = null,
  resolveAsset = null,
} = {}) {
  if (!recordedProvenance || typeof recordedProvenance !== 'object') {
    return {
      valid: false,
      errors: ['No recorded provenance manifest found for exact-input reproduction.'],
      warnings: [],
    };
  }

  const errors = [];
  const warnings = [];
  const installedVoiceProfiles = Array.isArray(localVoiceProfiles) ? localVoiceProfiles : [];
  const installedLoras = Array.isArray(localLoras) ? localLoras : [];

  if (recordedProvenance.universeId) {
    if (!universe) {
      errors.push('The recorded Universe is unavailable for exact-input reproduction.');
    } else if (universe.id && universe.id !== recordedProvenance.universeId) {
      errors.push(`Recorded Universe "${recordedProvenance.universeId}" does not match the current Universe "${universe.id}".`);
    }
  }
  if (Array.isArray(recordedProvenance.omitted) && recordedProvenance.omitted.length > 0) {
    errors.push('The recorded provenance contains omitted inputs, so exact reproduction cannot be proven.');
  }

  // The visual-conditioning compiler writes a different, capability-based
  // manifest than the original dialogue provenance envelope. Keep both
  // shapes readable so older renders remain reproducible, but never treat a
  // visual manifest as verified merely because it has a `version` field.
  const hasVisualManifest = recordedProvenance.capability
    || recordedProvenance.bindings
    || recordedProvenance.assets
    || recordedProvenance.compilerVersion;
  if (hasVisualManifest) {
    const visual = verifyVisualManifest(recordedProvenance, {
      universe, installedLoras, availableImageModels, availableVideoModels, resolveAsset,
    });
    errors.push(...visual.errors);
    warnings.push(...visual.warnings);
  } else if (!Array.isArray(recordedProvenance.characters)) {
    errors.push('Recorded provenance has no recognized asset bindings.');
  }

  errors.push(...verifyCharacterProvenanceEntries(recordedProvenance, {
    universe, installedLoras, installedVoiceProfiles,
  }));

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// One status policy for the still/entry/hold/exit media assets: an existing asset
// is reused unless exact_inputs demands a re-render; everything else is ready or
// blocked. `reuseAllowed` is supplied per asset (it is deliberately not derived
// from `ready`: an existing still or entry stays reusable without a prompt).
const plannedMediaAssetStatus = ({ existingAssetId, reuseAllowed, ready, mode }) => {
  if (existingAssetId && reuseAllowed && mode !== 'exact_inputs') return 'already_rendered';
  return ready ? 'ready' : 'blocked';
};

const LOCKED_STORYBOARD_APPROVAL_BLOCKER = 'Locked canon video requires an author-approved storyboard image.';

// Locked canon may only render a missing video from an author-approved storyboard.
const needsLockedStoryboardApproval = (lockedCanon, existingAssetId, node) => (
  lockedCanon && !existingAssetId && node.visualCanon?.storyboardImageApproved !== true
);

// Episode-invariant: the Universe lookup table and the canonical protagonist /
// wardrobe blockers are identical for every node, so resolve them once.
function resolveEpisodeProtagonistContext(loom, universe) {
  const universeCharacters = Array.isArray(universe?.characters) ? universe.characters : [];
  const characterById = new Map(universeCharacters.map((character) => [character.id, character]));
  const canonicalProtagonistId = isNonBlankStr(loom?.protagonistCharacterId)
    ? loom.protagonistCharacterId
    : null;
  const canonicalProtagonist = canonicalProtagonistId
    ? characterById.get(canonicalProtagonistId)
    : null;

  const canonicalProtagonistBlockers = [];
  if (canonicalProtagonistId && !universe) {
    canonicalProtagonistBlockers.push('The canonical protagonist cannot be resolved because the linked Universe is unavailable.');
  } else if (canonicalProtagonistId && !canonicalProtagonist) {
    canonicalProtagonistBlockers.push(`Canonical protagonist "${canonicalProtagonistId}" is not present in the linked Universe.`);
  } else if (canonicalProtagonist?.id && loom.protagonistWardrobeId
    && !canonicalProtagonist.wardrobes?.some((wardrobe) => wardrobe.id === loom.protagonistWardrobeId)) {
    canonicalProtagonistBlockers.push(`Canonical wardrobe "${loom.protagonistWardrobeId}" is not present on protagonist "${canonicalProtagonistId}".`);
  }
  return { characterById, canonicalProtagonistId, canonicalProtagonistBlockers };
}

function collectBoundVisualCanonBlockers(visualCanon, universe, characterById) {
  const blockers = [];
  for (const appearance of (Array.isArray(visualCanon.characterAppearances)
    ? visualCanon.characterAppearances
    : [])) {
    const character = characterById.get(appearance.characterId);
    if (!character) {
      blockers.push(`Bound character "${appearance.characterId}" is not present in the linked Universe.`);
    } else if (appearance.wardrobeId
      && !character.wardrobes?.some((wardrobe) => wardrobe.id === appearance.wardrobeId)) {
      blockers.push(`Bound wardrobe "${appearance.wardrobeId}" is not present on character "${appearance.characterId}".`);
    }
  }
  if (visualCanon.placeId && !universe.places?.some((place) => place.id === visualCanon.placeId)) {
    blockers.push(`Bound place "${visualCanon.placeId}" is not present in the linked Universe.`);
  }
  for (const objectId of (Array.isArray(visualCanon.objectIds) ? visualCanon.objectIds : [])) {
    if (!universe.objects?.some((object) => object.id === objectId)) {
      blockers.push(`Bound object "${objectId}" is not present in the linked Universe.`);
    }
  }
  return blockers;
}

// Convergent scenes never inherit an arbitrary predecessor. Drafts may still
// render from their own prompt, while locked canon must choose an explicit
// incoming source before continuity can be approved.
function resolveTemporalContinuity(node, preds, lockedCanon) {
  const explicitSource = isNonBlankStr(node.visualCanon?.continuitySourceNodeId)
    ? node.visualCanon.continuitySourceNodeId
    : null;
  const noInheritance = (extra) => ({
    nodeId: node.id,
    nodeTitle: node.title || node.id,
    predecessorCount: preds.length,
    selectedPredecessorId: null,
    policy: 'no-inheritance',
    ...extra,
  });

  if (explicitSource && !preds.some((pred) => pred.nodeId === explicitSource)) {
    return {
      temporalSourceNodeId: null,
      convergenceDetail: noInheritance({
        reason: 'invalid-explicit-source',
        remediation: 'Set visualCanon.continuitySourceNodeId to an incoming predecessor of this scene.',
      }),
      blocker: lockedCanon ? 'Locked visual canon names a predecessor that does not lead into this scene.' : null,
    };
  }
  if (preds.length === 1) {
    return { temporalSourceNodeId: explicitSource || preds[0].nodeId, convergenceDetail: null, blocker: null };
  }
  if (preds.length > 1) {
    if (explicitSource) return { temporalSourceNodeId: explicitSource, convergenceDetail: null, blocker: null };
    return {
      temporalSourceNodeId: null,
      convergenceDetail: noInheritance({
        remediation: 'Set visualCanon.continuitySourceNodeId on this scene to explicitly select temporal continuity source.',
      }),
      blocker: lockedCanon ? 'Locked convergent scene needs an explicit temporal continuity source.' : null,
    };
  }
  return { temporalSourceNodeId: null, convergenceDetail: null, blocker: null };
}

function evaluateNodeVisualAndConvergence({
  node, preds, universe, characterById, canonicalProtagonistBlockers,
}) {
  const nodeBlockers = analyzeEpisodeShots({ nodes: [node] }).issues.map((issue) => issue.message);
  const lockedCanon = isLockedCanon(node);
  if (lockedCanon && !universe) {
    nodeBlockers.push('Locked visual canon cannot be resolved because its Universe is unavailable.');
  }
  nodeBlockers.push(...canonicalProtagonistBlockers);
  if (node.visualCanon && universe) {
    nodeBlockers.push(...collectBoundVisualCanonBlockers(node.visualCanon, universe, characterById));
  }
  const { temporalSourceNodeId, convergenceDetail, blocker } = resolveTemporalContinuity(node, preds, lockedCanon);
  if (blocker) nodeBlockers.push(blocker);
  return { nodeBlockers, lockedCanon, temporalSourceNodeId, convergenceDetail };
}

function collectNodeExactInputIssues(node, provenanceOptions) {
  const assets = node.playbackAssets || null;
  const seenManifestKeys = new Set();
  const provenanceManifests = [
    assets?.provenance,
    node.visualConditioning,
    ...Object.values(assets?.visualConditioningByAsset || {}),
  ].filter((manifest) => {
    if (!manifest) return false;
    const key = manifest.assetId || JSON.stringify(manifest);
    if (seenManifestKeys.has(key)) return false;
    seenManifestKeys.add(key);
    return true;
  });
  if (provenanceManifests.length === 0) provenanceManifests.push(null);

  const issues = [];
  for (const recordedProvenance of provenanceManifests) {
    const provCheck = verifyExactInputProvenance(recordedProvenance, provenanceOptions);
    if (!provCheck.valid) {
      issues.push({ nodeId: node.id, errors: provCheck.errors, warnings: provCheck.warnings });
    }
  }
  return issues;
}

function collectLiveInteractionBlockers({
  node, assets, loom, universe, characterById, canonicalProtagonistId, localVoiceProfiles,
}) {
  const blockers = [];
  const interactionCharacterId = node.interactionWindow.protagonistCharacterId;
  const interactionCharacter = characterById.get(interactionCharacterId);
  if (!interactionCharacterId) {
    blockers.push('Live interaction is enabled without a protagonist character binding.');
  } else if (!universe || !interactionCharacter) {
    blockers.push(`Live interaction protagonist "${interactionCharacterId}" is not present in the linked Universe.`);
  }
  if (canonicalProtagonistId && interactionCharacterId && interactionCharacterId !== canonicalProtagonistId) {
    blockers.push(`Live interaction protagonist "${interactionCharacterId}" differs from the loom's canonical protagonist "${canonicalProtagonistId}".`);
  }

  const approvedProfile = localVoiceProfiles?.find((profile) => (
    profile.binding?.characterId === interactionCharacterId
    && (!universe?.id || profile.binding?.universeId === universe.id)
    && profile.approval?.status === 'approved'
    && profile.routes?.interactive?.enabled === true
  ));
  if (!approvedProfile && !interactionCharacter?.voiceId && !loom?.defaultVoiceId) {
    blockers.push(`Live interaction protagonist "${interactionCharacterId || 'unknown'}" has no approved voice binding.`);
  }

  const holdIds = Array.isArray(assets?.holdLoopVideoHistoryIds)
    ? assets.holdLoopVideoHistoryIds
    : [];
  if (!holdIds.length) {
    blockers.push('Live interaction requires a dedicated hold loop asset.');
  }
  for (const holdId of holdIds) {
    const occupancy = assets?.audioOccupancy?.[holdId];
    if (occupancy && !validateAudioOccupancy(occupancy).safeForLiveVoice) {
      blockers.push(`Hold loop "${holdId}" is not safe for live voice.`);
    }
  }
  return blockers;
}

function buildNodePlannedAssets({
  node, depth, assets, lockedCanon, temporalSourceNodeId, nodeBlockers, effectiveMode,
}) {
  const planned = [];
  const nodeBase = { nodeId: node.id, nodeTitle: node.title || node.id };
  const existingStill = isNonBlankStr(node.image) ? node.image : null;
  const existingEntryVideo = isNonBlankStr(assets?.entryVideoHistoryId) ? assets.entryVideoHistoryId : (isNonBlankStr(node.videoHistoryId) ? node.videoHistoryId : null);

  // 1. Image still asset
  const imageAssetId = `asset-${node.id}-still`;
  const imageDependencies = temporalSourceNodeId ? [`asset-${temporalSourceNodeId}-still`] : [];
  const imageHasPrompt = Boolean(node.imagePrompt || node.prose);
  const imageReady = imageHasPrompt && nodeBlockers.length === 0;
  const imageBlockers = [...nodeBlockers];
  if (!imageHasPrompt) imageBlockers.push('Scene has neither imagePrompt nor prose.');

  planned.push({
    id: imageAssetId,
    ...nodeBase,
    depth,
    type: 'image',
    role: 'image',
    prompt: node.imagePrompt || node.prose || '',
    temporalSourceNodeId,
    dependencies: imageDependencies,
    existingAssetId: existingStill,
    status: plannedMediaAssetStatus({
      existingAssetId: existingStill,
      reuseAllowed: nodeBlockers.length === 0,
      ready: imageReady,
      mode: effectiveMode,
    }),
    readiness: {
      ready: imageReady,
      reasons: imageBlockers,
    },
  });

  // 2. Video entry asset
  const videoPrompt = node.videoPrompt || node.prose || '';
  const videoHasPrompt = Boolean(videoPrompt);
  const videoBlockers = [...nodeBlockers];
  if (!videoHasPrompt) videoBlockers.push('Scene has neither videoPrompt nor prose for video.');
  if (needsLockedStoryboardApproval(lockedCanon, existingEntryVideo, node)) {
    videoBlockers.push(LOCKED_STORYBOARD_APPROVAL_BLOCKER);
  }
  const videoReady = videoBlockers.length === 0;

  planned.push({
    id: `asset-${node.id}-video-entry`,
    ...nodeBase,
    depth,
    type: 'video_entry',
    role: 'entry',
    prompt: videoPrompt,
    cameraMovement: node.cameraMovement || null,
    dependencies: [imageAssetId],
    existingAssetId: existingEntryVideo,
    status: plannedMediaAssetStatus({
      existingAssetId: existingEntryVideo,
      reuseAllowed: nodeBlockers.length === 0,
      ready: videoReady,
      mode: effectiveMode,
    }),
    readiness: {
      ready: videoReady,
      reasons: videoBlockers,
    },
  });

  // 3. Video hold loop assets (for non-cut decision / interactive scenes)
  if (!node.isEnding && node.playbackMode !== 'cut') {
    const holdLoops = Array.isArray(assets?.holdLoopVideoHistoryIds) ? assets.holdLoopVideoHistoryIds : [];
    const existingHold = holdLoops[0] || null;
    const holdBlockers = [...nodeBlockers];
    if (needsLockedStoryboardApproval(lockedCanon, existingHold, node)) {
      holdBlockers.push(LOCKED_STORYBOARD_APPROVAL_BLOCKER);
    }

    const holdReady = videoHasPrompt && holdBlockers.length === 0;
    planned.push({
      id: `asset-${node.id}-video-hold-0`,
      ...nodeBase,
      depth,
      type: 'video_hold',
      role: 'hold',
      prompt: videoPrompt,
      cameraMovement: node.cameraMovement || null,
      dependencies: [imageAssetId],
      existingAssetId: existingHold,
      status: plannedMediaAssetStatus({
        existingAssetId: existingHold,
        reuseAllowed: holdBlockers.length === 0,
        ready: holdReady,
        mode: effectiveMode,
      }),
      readiness: {
        ready: holdReady,
        reasons: videoHasPrompt ? holdBlockers : [...holdBlockers, 'Scene has neither videoPrompt nor prose for video.'],
      },
    });
  }

  // 4. Video exit assets for transitions
  for (const tr of (node.transitions || [])) {
    const existingExit = assets?.exitByTransition?.[tr.id] || null;
    const exitHasPrompt = Boolean(tr.description || videoPrompt);
    const exitBlockers = [...nodeBlockers];
    if (!exitHasPrompt) exitBlockers.push('Transition has no description or scene video prompt.');
    if (needsLockedStoryboardApproval(lockedCanon, existingExit, node)) {
      exitBlockers.push(LOCKED_STORYBOARD_APPROVAL_BLOCKER);
    }
    const exitReady = exitHasPrompt && exitBlockers.length === 0;
    planned.push({
      id: `asset-${node.id}-video-exit-${tr.id}`,
      ...nodeBase,
      transitionId: tr.id,
      intent: tr.intent || '',
      depth,
      type: 'video_exit',
      role: 'exit',
      prompt: tr.description || videoPrompt,
      dependencies: [imageAssetId],
      existingAssetId: existingExit,
      status: plannedMediaAssetStatus({
        existingAssetId: existingExit,
        reuseAllowed: exitBlockers.length === 0,
        ready: exitReady,
        mode: effectiveMode,
      }),
      readiness: {
        ready: exitReady,
        reasons: exitBlockers,
      },
    });
  }

  // 5. Dialogue assets if character interaction is configured
  if (node.interactionWindow?.enabled && node.interactionWindow?.protagonistCharacterId) {
    const charId = node.interactionWindow.protagonistCharacterId;
    // Protagonist and voice-binding blockers are already in nodeBlockers.
    const dialogueBlocked = nodeBlockers.length > 0;
    planned.push({
      id: `asset-${node.id}-dialogue-${charId}`,
      ...nodeBase,
      characterId: charId,
      depth,
      type: 'dialogue',
      role: 'dialogue',
      dependencies: [imageAssetId],
      existingAssetId: null,
      status: dialogueBlocked ? 'blocked' : 'skipped',
      skipReason: dialogueBlocked ? null : 'Live dialogue is generated per hosted interaction; no standalone batch audio is created.',
      readiness: {
        ready: !dialogueBlocked,
        reasons: dialogueBlocked
          ? [...nodeBlockers]
          : ['Live dialogue is generated per hosted interaction; no standalone batch audio is created.'],
      },
    });
  }
  return planned;
}

// Execution stages come from asset dependencies, not only node depth. A scene's
// video depends on its still, so grouping by scene depth alone would
// incorrectly expose both as independent work in one batch. Stamps
// `stageIndex` onto each asset.
function buildExecutionStages(plannedAssets) {
  const stageByAssetId = new Map();
  for (const asset of plannedAssets) {
    const stageIndex = (asset.dependencies || []).reduce(
      (maxStage, dependencyId) => Math.max(maxStage, (stageByAssetId.get(dependencyId) ?? -1) + 1),
      0,
    );
    stageByAssetId.set(asset.id, stageIndex);
    asset.stageIndex = stageIndex;
  }
  const stageGroups = new Map();
  for (const asset of plannedAssets) {
    const stage = stageGroups.get(asset.stageIndex) || [];
    stage.push(asset);
    stageGroups.set(asset.stageIndex, stage);
  }
  return Array.from(stageGroups.entries()).map(([stageIndex, stageAssets]) => ({
    stageIndex,
    depth: Math.min(...stageAssets.map((asset) => asset.depth)),
    assetCount: stageAssets.length,
    assetIds: stageAssets.map((asset) => asset.id),
  }));
}

/**
 * Enumerate and plan all production assets for an episode.
 * Pure deterministic preflight and DAG generation.
 */
export function buildEpisodeProductionPlan({
  loom = null,
  episode = null,
  universe = null,
  mode = FABLELOOM_PRODUCTION_MODE_DEFAULT,
  localVoiceProfiles = [],
  localLoras = [],
  availableImageModels = null,
  availableVideoModels = null,
  resolveAsset = null,
} = {}) {
  const effectiveMode = FABLELOOM_PRODUCTION_MODES.includes(mode)
    ? mode
    : FABLELOOM_PRODUCTION_MODE_DEFAULT;

  const {
    orderedNodes,
    depthById,
    predecessorsByNodeId,
    unreachableNodeIds,
  } = computeTopologicalNodeOrder(episode);

  const plannedAssets = [];
  const convergenceDetails = [];
  const exactInputIssues = [];
  const planningIssues = [];

  if (!orderedNodes.length) {
    planningIssues.push('Episode has no reachable scenes from a valid start node.');
  }

  const { characterById, canonicalProtagonistId, canonicalProtagonistBlockers } = resolveEpisodeProtagonistContext(loom, universe);
  const provenanceOptions = {
    universe,
    localVoiceProfiles,
    localLoras,
    availableImageModels,
    availableVideoModels,
    resolveAsset,
  };

  for (const node of orderedNodes) {
    const assets = node.playbackAssets || null;
    const {
      nodeBlockers, lockedCanon, temporalSourceNodeId, convergenceDetail,
    } = evaluateNodeVisualAndConvergence({
      node,
      preds: predecessorsByNodeId.get(node.id) || [],
      universe,
      characterById,
      canonicalProtagonistBlockers,
    });
    if (convergenceDetail) convergenceDetails.push(convergenceDetail);

    if (effectiveMode === 'exact_inputs') {
      exactInputIssues.push(...collectNodeExactInputIssues(node, provenanceOptions));
    }
    if (node.interactionWindow?.enabled) {
      nodeBlockers.push(...collectLiveInteractionBlockers({
        node, assets, loom, universe, characterById, canonicalProtagonistId, localVoiceProfiles,
      }));
    }

    plannedAssets.push(...buildNodePlannedAssets({
      node,
      depth: depthById.get(node.id) ?? 0,
      assets,
      lockedCanon,
      temporalSourceNodeId,
      nodeBlockers,
      effectiveMode,
    }));
  }

  const executionStages = buildExecutionStages(plannedAssets);

  const countByStatus = (status) => plannedAssets.filter((asset) => asset.status === status).length;
  const countByType = (...types) => plannedAssets.filter((asset) => types.includes(asset.type)).length;
  const blockedAssetsCount = countByStatus('blocked');

  return {
    mode: effectiveMode,
    totalNodes: (episode?.nodes || []).length,
    reachableNodeCount: orderedNodes.length,
    unreachableNodeCount: unreachableNodeIds.size,
    unreachableNodeIds: Array.from(unreachableNodeIds),
    totalAssets: plannedAssets.length,
    assetsByType: {
      image: countByType('image'),
      video: countByType('video_entry', 'video_hold', 'video_exit'),
      dialogue: countByType('dialogue'),
    },
    readyAssetsCount: countByStatus('ready'),
    alreadyRenderedCount: countByStatus('already_rendered'),
    skippedAssetsCount: countByStatus('skipped'),
    blockedAssetsCount,
    isFullyReady: blockedAssetsCount === 0 && exactInputIssues.length === 0 && planningIssues.length === 0,
    planningIssues,
    convergenceIssues: convergenceDetails,
    exactInputIssues,
    plannedAssets,
    executionStages,
  };
}
