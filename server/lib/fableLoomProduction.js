/**
 * FableLoom production batch planning and topological orchestration.
 *
 * Pure, side-effect-free helpers for enumerating planned production assets
 * across reachable graph nodes, computing topological execution batches,
 * evaluating readiness gates, and verifying exact-input provenance.
 */

import { computeGraphLayers } from './fableLoomGraph.js';
import { validateAudioOccupancy } from './fableLoomPlayback.js';

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

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
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
  if (['aspectRatio', 'mode', 'videoMode', 'tiling'].includes(key)) return isStr(value);
  if (key === 'disableAudio') return typeof value === 'boolean';
  if (key === 'quantize') return isStr(value) || Number.isFinite(value);
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
      if (isStr(node.image)) continue;
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
  const errors = [];
  const warnings = [];
  const installedVoiceProfiles = Array.isArray(localVoiceProfiles) ? localVoiceProfiles : [];
  const installedLoras = Array.isArray(localLoras) ? localLoras : [];

  if (!recordedProvenance || typeof recordedProvenance !== 'object') {
    return {
      valid: false,
      errors: ['No recorded provenance manifest found for exact-input reproduction.'],
      warnings: [],
    };
  }

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
  // manifest than the original dialogue provenance envelope below. Keep both
  // shapes readable so older renders remain reproducible, but never treat a
  // visual manifest as verified merely because it has a `version` field.
  const hasVisualManifest = recordedProvenance.capability
    || recordedProvenance.bindings
    || recordedProvenance.assets
    || recordedProvenance.compilerVersion;
  if (hasVisualManifest) {
    if (recordedProvenance.version !== 1) {
      errors.push(`Recorded visual conditioning manifest version "${recordedProvenance.version ?? 'unknown'}" is unsupported.`);
    }
    if (!isStr(recordedProvenance.compilerVersion)) {
      errors.push('Recorded visual conditioning has no compiler revision.');
    }
    if (recordedProvenance.status !== 'locked') {
      errors.push('Recorded visual conditioning is not canon-locked, so exact reproduction cannot be proven.');
    }

    const capability = recordedProvenance.capability;
    if (!capability || typeof capability !== 'object') {
      errors.push('Recorded visual conditioning has no provider capability manifest.');
    } else {
      if (!isStr(capability.backend)) errors.push('Recorded visual conditioning has no backend.');
      if (!isStr(capability.modelId)) errors.push('Recorded visual conditioning has no model revision or model id.');
      if (capability.backend === 'local' && !isStr(capability.modelRevision)) {
        errors.push(`Recorded local ${capability.kind || 'media'} model "${capability.modelId || 'unknown'}" has no immutable model revision to verify exact inputs.`);
      }
      // Local model registries can only verify local manifests. Cloud model ids
      // are provider-owned and are not present in the local registry, so do not
      // mistake a perfectly valid cloud provenance record for a missing local
      // model.
      const availableModels = capability.backend === 'local'
        ? (capability.kind === 'video' ? availableVideoModels : availableImageModels)
        : null;
      if (Array.isArray(availableModels) && isStr(capability.modelId)) {
        const matchingModel = availableModels.find((model) => model?.id === capability.modelId);
        if (!matchingModel) {
          errors.push(`Recorded ${capability.kind || 'media'} model "${capability.modelId}" is not available locally.`);
        } else if (isStr(capability.modelRevision)
          && (!isStr(matchingModel.revision) || matchingModel.revision !== capability.modelRevision)) {
          errors.push(`Recorded ${capability.kind || 'media'} model "${capability.modelId}" revision mismatch (recorded ${capability.modelRevision}, current local ${matchingModel.revision || 'unknown'}).`);
        }
      }
    }
    errors.push(...exactRenderParameterIssues(recordedProvenance));

    const bindings = recordedProvenance.bindings;
    if (!bindings || typeof bindings !== 'object') {
      errors.push('Recorded visual conditioning has no scene bindings.');
    } else {
      const appearances = Array.isArray(bindings.characterAppearances)
        ? bindings.characterAppearances
        : [];
      if (universe && Array.isArray(universe.characters)) {
        for (const appearance of appearances) {
          const charId = appearance?.characterId;
          const canonChar = universe.characters.find((character) => character.id === charId);
          if (!canonChar) {
            errors.push(`Character "${charId || 'unknown'}" in recorded visual bindings no longer exists in Universe.`);
          } else if (isStr(appearance.wardrobeId)
            && (!Array.isArray(canonChar.wardrobes)
              || !canonChar.wardrobes.some((wardrobe) => wardrobe.id === appearance.wardrobeId))) {
            errors.push(`Wardrobe "${appearance.wardrobeId}" in recorded visual bindings is not present on character "${charId}".`);
          }
        }
      }
      if (universe && isStr(bindings.placeId)
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
    }

    if (!Array.isArray(recordedProvenance.assets)) {
      errors.push('Recorded visual conditioning has no asset manifest.');
    } else {
      for (const asset of recordedProvenance.assets) {
        if (!isStr(asset?.filename)) {
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
        if (!isStr(adapter?.filename)) {
          errors.push('Recorded visual conditioning contains an adapter with no filename.');
          continue;
        }
        if (!isStr(adapter.sha256)) {
          errors.push(`Recorded character adapter "${adapter.filename}" has no checksum to verify exact inputs.`);
          continue;
        }
        const matchedLora = installedLoras.find((lora) => lora?.filename === adapter.filename);
        if (!matchedLora) {
          errors.push(`Recorded character adapter "${adapter.filename}" is not installed locally.`);
        } else if (!isStr(matchedLora.sha256)) {
          errors.push(`Installed character adapter "${adapter.filename}" has no checksum to verify exact inputs.`);
        } else if (matchedLora.sha256 !== adapter.sha256) {
          errors.push(`Recorded character adapter "${adapter.filename}" checksum mismatch (expected ${adapter.sha256}, found ${matchedLora.sha256}).`);
        }
      }
    }
    if (!Array.isArray(recordedProvenance.omitted)) {
      errors.push('Recorded visual conditioning has no omitted-input manifest.');
    }
    if (!Array.isArray(recordedProvenance.warnings)) {
      warnings.push('Recorded visual conditioning has no warnings manifest.');
    }
  } else if (!Array.isArray(recordedProvenance.characters)) {
    errors.push('Recorded provenance has no recognized asset bindings.');
  }

  const characters = Array.isArray(recordedProvenance.characters) ? recordedProvenance.characters : [];

  for (const char of characters) {
    const charId = char?.characterId;
    if (!charId) continue;

    // Check Universe Character existence if universe provided
    if (universe && Array.isArray(universe.characters)) {
      const canonChar = universe.characters.find((c) => c.id === charId);
      if (!canonChar) {
        errors.push(`Character "${charId}" in recorded provenance no longer exists in Universe.`);
      }
    }

    // Check LoRA matching
    if (char.lora) {
      const recordedFilename = char.lora.filename;
      if (!isStr(recordedFilename)) {
        errors.push(`Recorded character LoRA binding for "${charId}" has no filename.`);
      } else {
        const recordedSha = char.lora.sha256;
        const matchedLora = installedLoras.find((l) => l.filename === recordedFilename);
        if (!matchedLora) {
          errors.push(`Recorded character LoRA "${recordedFilename}" is not installed locally.`);
        } else if (!isStr(recordedSha)) {
          errors.push(`Recorded character LoRA "${recordedFilename}" has no checksum to verify.`);
        } else if (!isStr(matchedLora.sha256)) {
          errors.push(`Installed character LoRA "${recordedFilename}" has no checksum to verify exact inputs.`);
        } else if (matchedLora.sha256 !== recordedSha) {
          errors.push(`Recorded character LoRA "${recordedFilename}" checksum mismatch (expected ${recordedSha}, found ${matchedLora.sha256}).`);
        }
      }
    }

    // Check Voice Profile matching
    if (char.voice) {
      const recordedProfileId = char.voice.profileId;
      const recordedVersion = char.voice.profileVersion;
      const recordedEngine = char.voice.engine;
      const recordedModelRev = char.voice.modelRevision;
      if (!isStr(recordedProfileId)) {
        errors.push(`Recorded voice binding for character "${charId}" has no profile id.`);
        continue;
      }

      const matchedProfile = installedVoiceProfiles.find((p) => p.id === recordedProfileId);
      if (!matchedProfile) {
        errors.push(`Recorded voice profile "${recordedProfileId}" is not installed locally.`);
        continue;
      }
      if (matchedProfile.binding?.characterId && matchedProfile.binding.characterId !== charId) {
        errors.push(`Recorded voice profile "${recordedProfileId}" is bound to a different character.`);
      }
      if (recordedProvenance.universeId
        && matchedProfile.binding?.universeId
        && matchedProfile.binding.universeId !== recordedProvenance.universeId) {
        errors.push(`Recorded voice profile "${recordedProfileId}" belongs to a different Universe.`);
      }
      if (!Number.isFinite(recordedVersion) || matchedProfile.version !== recordedVersion) {
        errors.push(`Recorded voice profile "${recordedProfileId}" version mismatch (recorded v${recordedVersion ?? 'unknown'}, current local v${matchedProfile.version ?? 'unknown'}).`);
      }
      if (!isStr(recordedEngine) || !isStr(matchedProfile.engine) || matchedProfile.engine !== recordedEngine) {
        errors.push(`Recorded voice profile "${recordedProfileId}" engine mismatch (recorded ${recordedEngine || 'unknown'}, current local ${matchedProfile.engine || 'unknown'}).`);
      }
      if (!isStr(recordedModelRev) || !isStr(matchedProfile.modelRevision) || matchedProfile.modelRevision !== recordedModelRev) {
        errors.push(`Recorded voice profile "${recordedProfileId}" model revision mismatch (recorded ${recordedModelRev || 'unknown'}, current local ${matchedProfile.modelRevision || 'unknown'}).`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
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

  let totalImageAssets = 0;
  let totalVideoAssets = 0;
  let totalDialogueAssets = 0;

  for (const node of orderedNodes) {
    const depth = depthById.get(node.id) ?? 0;
    const preds = predecessorsByNodeId.get(node.id) || [];
    const nodeBlockers = [];
    const visualCanon = node.visualCanon || null;
    const lockedCanon = isLockedCanon(node);
    const universeCharacters = Array.isArray(universe?.characters) ? universe.characters : [];
    const characterById = new Map(universeCharacters.map((character) => [character.id, character]));
    const canonicalProtagonistId = isStr(loom?.protagonistCharacterId)
      ? loom.protagonistCharacterId
      : null;
    const canonicalProtagonist = canonicalProtagonistId
      ? characterById.get(canonicalProtagonistId)
      : null;

    if (lockedCanon && !universe) {
      nodeBlockers.push('Locked visual canon cannot be resolved because its Universe is unavailable.');
    }
    if (canonicalProtagonistId && !universe) {
      nodeBlockers.push('The canonical protagonist cannot be resolved because the linked Universe is unavailable.');
    } else if (canonicalProtagonistId && !canonicalProtagonist) {
      nodeBlockers.push(`Canonical protagonist "${canonicalProtagonistId}" is not present in the linked Universe.`);
    } else if (canonicalProtagonist?.id && loom.protagonistWardrobeId
      && !canonicalProtagonist.wardrobes?.some((wardrobe) => wardrobe.id === loom.protagonistWardrobeId)) {
      nodeBlockers.push(`Canonical wardrobe "${loom.protagonistWardrobeId}" is not present on protagonist "${canonicalProtagonistId}".`);
    }
    if (visualCanon && universe) {
      for (const appearance of (Array.isArray(visualCanon.characterAppearances)
        ? visualCanon.characterAppearances
        : [])) {
        const character = characterById.get(appearance.characterId);
        if (!character) {
          nodeBlockers.push(`Bound character "${appearance.characterId}" is not present in the linked Universe.`);
        } else if (appearance.wardrobeId
          && !character.wardrobes?.some((wardrobe) => wardrobe.id === appearance.wardrobeId)) {
          nodeBlockers.push(`Bound wardrobe "${appearance.wardrobeId}" is not present on character "${appearance.characterId}".`);
        }
      }
      if (visualCanon.placeId && !universe.places?.some((place) => place.id === visualCanon.placeId)) {
        nodeBlockers.push(`Bound place "${visualCanon.placeId}" is not present in the linked Universe.`);
      }
      for (const objectId of (Array.isArray(visualCanon.objectIds) ? visualCanon.objectIds : [])) {
        if (!universe.objects?.some((object) => object.id === objectId)) {
          nodeBlockers.push(`Bound object "${objectId}" is not present in the linked Universe.`);
        }
      }
    }

    let temporalSourceNodeId = null;
    const explicitTemporalSource = isStr(visualCanon?.continuitySourceNodeId)
      ? visualCanon.continuitySourceNodeId
      : null;

    if (explicitTemporalSource && !preds.some((pred) => pred.nodeId === explicitTemporalSource)) {
      convergenceDetails.push({
        nodeId: node.id,
        nodeTitle: node.title || node.id,
        predecessorCount: preds.length,
        selectedPredecessorId: null,
        policy: 'no-inheritance',
        reason: 'invalid-explicit-source',
        remediation: 'Set visualCanon.continuitySourceNodeId to an incoming predecessor of this scene.',
      });
      if (lockedCanon) nodeBlockers.push('Locked visual canon names a predecessor that does not lead into this scene.');
    } else if (preds.length === 1) {
      temporalSourceNodeId = explicitTemporalSource || preds[0].nodeId;
    } else if (preds.length > 1) {
      if (explicitTemporalSource) {
        temporalSourceNodeId = explicitTemporalSource;
      } else {
        // Convergent scenes never inherit an arbitrary predecessor. Drafts may
        // still render from their own prompt, while locked canon must choose an
        // explicit incoming source before continuity can be approved.
        convergenceDetails.push({
          nodeId: node.id,
          nodeTitle: node.title || node.id,
          predecessorCount: preds.length,
          selectedPredecessorId: null,
          policy: 'no-inheritance',
          remediation: 'Set visualCanon.continuitySourceNodeId on this scene to explicitly select temporal continuity source.',
        });
        if (lockedCanon) nodeBlockers.push('Locked convergent scene needs an explicit temporal continuity source.');
      }
    }

    const assets = node.playbackAssets || null;
    const existingStill = isStr(node.image) ? node.image : null;
    const existingEntryVideo = isStr(assets?.entryVideoHistoryId) ? assets.entryVideoHistoryId : (isStr(node.videoHistoryId) ? node.videoHistoryId : null);

    // Exact input provenance verification if requested
    if (effectiveMode === 'exact_inputs') {
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
      for (const recordedProvenance of provenanceManifests) {
        const provCheck = verifyExactInputProvenance(recordedProvenance, {
          universe,
          localVoiceProfiles,
          localLoras,
          availableImageModels,
          availableVideoModels,
          resolveAsset,
        });
        if (!provCheck.valid) {
          exactInputIssues.push({
            nodeId: node.id,
            errors: provCheck.errors,
            warnings: provCheck.warnings,
          });
        }
      }
    }

    if (node.interactionWindow?.enabled) {
      const interactionCharacterId = node.interactionWindow.protagonistCharacterId;
      const interactionCharacter = characterById.get(interactionCharacterId);
      if (!interactionCharacterId) {
        nodeBlockers.push('Live interaction is enabled without a protagonist character binding.');
      } else if (!universe || !interactionCharacter) {
        nodeBlockers.push(`Live interaction protagonist "${interactionCharacterId}" is not present in the linked Universe.`);
      }
      if (canonicalProtagonistId && interactionCharacterId && interactionCharacterId !== canonicalProtagonistId) {
        nodeBlockers.push(`Live interaction protagonist "${interactionCharacterId}" differs from the loom's canonical protagonist "${canonicalProtagonistId}".`);
      }

      const approvedProfile = localVoiceProfiles?.find((profile) => (
        profile.binding?.characterId === interactionCharacterId
        && (!universe?.id || profile.binding?.universeId === universe.id)
        && profile.approval?.status === 'approved'
      ));
      if (!approvedProfile && !interactionCharacter?.voiceId && !loom?.defaultVoiceId) {
        nodeBlockers.push(`Live interaction protagonist "${interactionCharacterId || 'unknown'}" has no approved voice binding.`);
      }

      const holdIds = Array.isArray(assets?.holdLoopVideoHistoryIds)
        ? assets.holdLoopVideoHistoryIds
        : [];
      if (!holdIds.length) {
        nodeBlockers.push('Live interaction requires a dedicated hold loop asset.');
      }
      for (const holdId of holdIds) {
        const occupancy = assets?.audioOccupancy?.[holdId];
        if (occupancy && !validateAudioOccupancy(occupancy).safeForLiveVoice) {
          nodeBlockers.push(`Hold loop "${holdId}" is not safe for live voice.`);
        }
      }
    }

    // 1. Image still asset
    const imageAssetId = `asset-${node.id}-still`;
    const imageDependencies = temporalSourceNodeId ? [`asset-${temporalSourceNodeId}-still`] : [];
    const imageReady = Boolean(node.imagePrompt || node.prose) && nodeBlockers.length === 0;
    const imageBlockers = [...nodeBlockers];
    const imageHasPrompt = Boolean(node.imagePrompt || node.prose);
    if (!imageHasPrompt) imageBlockers.push('Scene has neither imagePrompt nor prose.');

    plannedAssets.push({
      id: imageAssetId,
      nodeId: node.id,
      nodeTitle: node.title || node.id,
      depth,
      type: 'image',
      role: 'image',
      prompt: node.imagePrompt || node.prose || '',
      temporalSourceNodeId,
      dependencies: imageDependencies,
      existingAssetId: existingStill,
      status: existingStill && nodeBlockers.length === 0 && effectiveMode !== 'exact_inputs'
        ? 'already_rendered'
        : (imageHasPrompt && nodeBlockers.length === 0 ? 'ready' : 'blocked'),
      readiness: {
        ready: imageReady,
        reasons: imageBlockers,
      },
    });
    totalImageAssets += 1;

    // 2. Video entry asset
    const videoEntryAssetId = `asset-${node.id}-video-entry`;
    const videoPrompt = node.videoPrompt || node.prose || '';
    const videoHasPrompt = Boolean(videoPrompt);
    const videoBlockers = [...nodeBlockers];
    if (!videoHasPrompt) videoBlockers.push('Scene has neither videoPrompt nor prose for video.');
    if (lockedCanon && !existingEntryVideo && node.visualCanon?.storyboardImageApproved !== true) {
      videoBlockers.push('Locked canon video requires an author-approved storyboard image.');
    }
    const videoReady = videoBlockers.length === 0;

    plannedAssets.push({
      id: videoEntryAssetId,
      nodeId: node.id,
      nodeTitle: node.title || node.id,
      depth,
      type: 'video_entry',
      role: 'entry',
      prompt: videoPrompt,
      cameraMovement: node.cameraMovement || null,
      dependencies: [imageAssetId],
      existingAssetId: existingEntryVideo,
      status: existingEntryVideo && nodeBlockers.length === 0 && effectiveMode !== 'exact_inputs'
        ? 'already_rendered'
        : (videoReady ? 'ready' : 'blocked'),
      readiness: {
        ready: videoReady,
        reasons: videoBlockers,
      },
    });
    totalVideoAssets += 1;

    // 3. Video hold loop assets (for non-cut decision / interactive scenes)
    if (!node.isEnding && node.playbackMode !== 'cut') {
      const holdLoops = Array.isArray(assets?.holdLoopVideoHistoryIds) ? assets.holdLoopVideoHistoryIds : [];
      const holdAssetId = `asset-${node.id}-video-hold-0`;
      const existingHold = holdLoops[0] || null;
      const holdBlockers = [...nodeBlockers];
      if (lockedCanon && !existingHold && node.visualCanon?.storyboardImageApproved !== true) {
        holdBlockers.push('Locked canon video requires an author-approved storyboard image.');
      }
      if (node.interactionWindow?.enabled) {
        for (const holdId of holdLoops) {
          const occupancy = assets?.audioOccupancy?.[holdId];
          if (occupancy && !validateAudioOccupancy(occupancy).safeForLiveVoice) {
            holdBlockers.push(`Hold loop "${holdId}" is not safe for live voice.`);
          }
        }
      }

      plannedAssets.push({
        id: holdAssetId,
        nodeId: node.id,
        nodeTitle: node.title || node.id,
        depth,
        type: 'video_hold',
        role: 'hold',
        prompt: videoPrompt,
        cameraMovement: node.cameraMovement || null,
        dependencies: [imageAssetId],
        existingAssetId: existingHold,
        status: existingHold && holdBlockers.length === 0 && effectiveMode !== 'exact_inputs'
          ? 'already_rendered'
          : (videoHasPrompt && holdBlockers.length === 0 ? 'ready' : 'blocked'),
        readiness: {
          ready: videoHasPrompt && holdBlockers.length === 0,
          reasons: videoHasPrompt ? holdBlockers : [...holdBlockers, 'Scene has neither videoPrompt nor prose for video.'],
        },
      });
      totalVideoAssets += 1;
    }

    // 4. Video exit assets for transitions
    for (const tr of (node.transitions || [])) {
      const exitAssetId = `asset-${node.id}-video-exit-${tr.id}`;
      const existingExit = assets?.exitByTransition?.[tr.id] || null;
      const exitHasPrompt = Boolean(tr.description || videoPrompt);
      const exitBlockers = [...nodeBlockers];
      if (!exitHasPrompt) exitBlockers.push('Transition has no description or scene video prompt.');
      if (lockedCanon && !existingExit && node.visualCanon?.storyboardImageApproved !== true) {
        exitBlockers.push('Locked canon video requires an author-approved storyboard image.');
      }
      plannedAssets.push({
        id: exitAssetId,
        nodeId: node.id,
        nodeTitle: node.title || node.id,
        transitionId: tr.id,
        intent: tr.intent || '',
        depth,
        type: 'video_exit',
        role: 'exit',
        prompt: tr.description || videoPrompt,
        dependencies: [imageAssetId],
        existingAssetId: existingExit,
        status: existingExit && exitBlockers.length === 0 && effectiveMode !== 'exact_inputs'
          ? 'already_rendered'
          : (exitHasPrompt && exitBlockers.length === 0 ? 'ready' : 'blocked'),
        readiness: {
          ready: exitHasPrompt && exitBlockers.length === 0,
          reasons: exitBlockers,
        },
      });
      totalVideoAssets += 1;
    }

    // 5. Dialogue assets if character interaction is configured
    if (node.interactionWindow?.enabled && node.interactionWindow?.protagonistCharacterId) {
      const charId = node.interactionWindow.protagonistCharacterId;
      const dialogueAssetId = `asset-${node.id}-dialogue-${charId}`;
      const character = characterById.get(charId);
      const charInUniverse = Boolean(character);
      const profile = localVoiceProfiles?.find((p) => (
        p.binding?.characterId === charId
        && (!universe?.id || p.binding?.universeId === universe.id)
        && p.approval?.status === 'approved'
      ));

      const dialogueBlockers = [];
      if (!charInUniverse && universe) dialogueBlockers.push(`Protagonist "${charId}" not found in Universe.`);
      if (!profile && !character?.voiceId && !loom?.defaultVoiceId) dialogueBlockers.push(`No approved voice binding for "${charId}".`);
      dialogueBlockers.push(...nodeBlockers);
      const dialogueBlocked = dialogueBlockers.length > 0;

      plannedAssets.push({
        id: dialogueAssetId,
        nodeId: node.id,
        nodeTitle: node.title || node.id,
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
            ? dialogueBlockers
            : ['Live dialogue is generated per hosted interaction; no standalone batch audio is created.'],
        },
      });
      totalDialogueAssets += 1;
    }
  }

  // Compute execution stages from asset dependencies, not only node depth.
  // A scene's video depends on its still, so grouping by scene depth alone
  // would incorrectly expose both as independent work in one batch.
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
  const executionStages = Array.from(stageGroups.entries()).map(([stageIndex, stageAssets]) => ({
    stageIndex,
    depth: Math.min(...stageAssets.map((asset) => asset.depth)),
    assetCount: stageAssets.length,
    assetIds: stageAssets.map((asset) => asset.id),
  }));

  const readyAssetsCount = plannedAssets.filter((a) => a.status === 'ready').length;
  const alreadyRenderedCount = plannedAssets.filter((a) => a.status === 'already_rendered').length;
  const skippedAssetsCount = plannedAssets.filter((a) => a.status === 'skipped').length;
  const blockedAssetsCount = plannedAssets.filter((a) => a.status === 'blocked').length;

  return {
    mode: effectiveMode,
    totalNodes: (episode?.nodes || []).length,
    reachableNodeCount: orderedNodes.length,
    unreachableNodeCount: unreachableNodeIds.size,
    unreachableNodeIds: Array.from(unreachableNodeIds),
    totalAssets: plannedAssets.length,
    assetsByType: {
      image: totalImageAssets,
      video: totalVideoAssets,
      dialogue: totalDialogueAssets,
    },
    readyAssetsCount,
    alreadyRenderedCount,
    skippedAssetsCount,
    blockedAssetsCount,
    isFullyReady: blockedAssetsCount === 0 && exactInputIssues.length === 0 && planningIssues.length === 0,
    planningIssues,
    convergenceIssues: convergenceDetails,
    exactInputIssues,
    plannedAssets,
    executionStages,
  };
}
