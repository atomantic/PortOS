/**
 * FableLoom episodic continuity review.
 *
 * Deterministic, multi-vector continuity checks across an episode graph:
 * - Visual entity bindings (characters, wardrobes, places, objects)
 * - Graph convergence & temporal continuity source unambiguousness
 * - Voice profile consistency & revision drift detection
 * - Pronunciation anchor coverage for Universe terminology
 * - Audio occupancy safety (no dialogue on hold loops, blocking effects)
 * - Live interaction window readiness & protagonist presence safety
 *
 * Produces structured findings without automatic mutations.
 */

import { computeTopologicalNodeOrder } from './fableLoomProduction.js';
import { validateAudioOccupancy } from './fableLoomPlayback.js';

export const CONTINUITY_CATEGORIES = Object.freeze(['visual', 'voice', 'playback', 'graph']);

export const CONTINUITY_CODES = Object.freeze({
  MISSING_UNIVERSE_CHARACTER: 'MISSING_UNIVERSE_CHARACTER',
  MISSING_UNIVERSE_PLACE: 'MISSING_UNIVERSE_PLACE',
  MISSING_UNIVERSE_OBJECT: 'MISSING_UNIVERSE_OBJECT',
  MISSING_WARDROBE_REFERENCE: 'MISSING_WARDROBE_REFERENCE',
  WARDROBE_DRIFT: 'WARDROBE_DRIFT',
  AMBIGUOUS_CONVERGENCE: 'AMBIGUOUS_CONVERGENCE',
  VOICE_PROFILE_REVISION_DRIFT: 'VOICE_PROFILE_REVISION_DRIFT',
  VOICE_ENGINE_DRIFT: 'VOICE_ENGINE_DRIFT',
  NO_APPROVED_VOICE_PROFILE: 'NO_APPROVED_VOICE_PROFILE',
  MISSING_PRONUNCIATION_ANCHOR: 'MISSING_PRONUNCIATION_ANCHOR',
  HOLD_LOOP_HAS_DIALOGUE: 'HOLD_LOOP_HAS_DIALOGUE',
  HOLD_LOOP_HAS_BLOCKING_EFFECTS: 'HOLD_LOOP_HAS_BLOCKING_EFFECTS',
  HOLD_LOOP_HAS_CLIPPING: 'HOLD_LOOP_HAS_CLIPPING',
  PROTAGONIST_ONSCREEN_INTERACTION: 'PROTAGONIST_ONSCREEN_INTERACTION',
  INTERACTION_ON_ENDING_OR_CUT: 'INTERACTION_ON_ENDING_OR_CUT',
  DISCONNECTED_INTERACTION_CHANNEL: 'DISCONNECTED_INTERACTION_CHANNEL',
  UNREACHABLE_SCENE_CONTINUITY: 'UNREACHABLE_SCENE_CONTINUITY',
  VOICE_MODEL_REVISION_DRIFT: 'VOICE_MODEL_REVISION_DRIFT',
  VOICE_PROFILE_BINDING_MISMATCH: 'VOICE_PROFILE_BINDING_MISMATCH',
  PRONUNCIATION_REVISION_DRIFT: 'PRONUNCIATION_REVISION_DRIFT',
});

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Run comprehensive episodic continuity review.
 * Pure deterministic rule evaluation — NO unsolicited AI calls.
 */
export function analyzeEpisodeContinuity({
  loom = null,
  episode = null,
  universe = null,
  localVoiceProfiles = [],
} = {}) {
  const findings = [];
  const push = ({ category, severity, code, message, remediation, nodeId = null, characterId = null, assetId = null }) => {
    findings.push({
      id: `finding-${findings.length + 1}`,
      category,
      severity, // 'error' | 'warning' | 'info'
      code,
      message,
      remediation,
      ...(nodeId ? { nodeId } : {}),
      ...(characterId ? { characterId } : {}),
      ...(assetId ? { assetId } : {}),
    });
  };

  const nodes = Array.isArray(episode?.nodes) ? episode.nodes : [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const {
    orderedNodes,
    depthById,
    predecessorsByNodeId,
    convergenceNodeIds,
    unreachableNodeIds,
  } = computeTopologicalNodeOrder(episode);

  // Track character voice profile revisions seen across all nodes in the episode
  // characterId -> Map of profile/engine/model revision -> array of nodeIds
  const characterVoiceRevisions = new Map();

  // Universe Terminology collection for pronunciation checking
  const universeTerms = new Set();
  const definedPronunciations = new Set();

  if (universe) {
    if (Array.isArray(universe.characters)) {
      for (const char of universe.characters) {
        if (char.name) universeTerms.add(char.name.toLowerCase());
        if (Array.isArray(char.aliases)) {
          for (const alias of char.aliases) universeTerms.add(alias.toLowerCase());
        }
        if (char.voiceCanon?.pronunciations && Array.isArray(char.voiceCanon.pronunciations)) {
          for (const p of char.voiceCanon.pronunciations) {
            if (p.term) definedPronunciations.add(p.term.toLowerCase());
          }
        }
      }
    }
    if (Array.isArray(universe.places)) {
      for (const place of universe.places) {
        if (place.name) universeTerms.add(place.name.toLowerCase());
      }
    }
    if (Array.isArray(universe.objects)) {
      for (const obj of universe.objects) {
        if (obj.name) universeTerms.add(obj.name.toLowerCase());
      }
    }
  }

  // 1. Graph & Convergence Continuity
  for (const nodeId of unreachableNodeIds) {
    const node = nodeById.get(nodeId);
    push({
      category: 'graph',
      severity: 'warning',
      code: CONTINUITY_CODES.UNREACHABLE_SCENE_CONTINUITY,
      message: `Scene "${node?.title || nodeId}" is unreachable from opening scene and will not be reached in story continuity.`,
      remediation: 'Connect an incoming transition from a reachable scene or mark as opening scene.',
      nodeId,
    });
  }

  for (const nodeId of convergenceNodeIds) {
    const node = nodeById.get(nodeId);
    const preds = predecessorsByNodeId.get(nodeId) || [];
    const explicitSource = node.visualCanon?.continuitySourceNodeId;
    const hasValidSource = explicitSource && preds.some((pred) => pred.nodeId === explicitSource);
    if (!hasValidSource) {
      push({
        category: 'graph',
        severity: explicitSource ? 'error' : 'info',
        code: CONTINUITY_CODES.AMBIGUOUS_CONVERGENCE,
        message: explicitSource
          ? `Convergence scene "${node?.title || nodeId}" names a predecessor that is not one of its ${preds.length} incoming paths.`
          : `Convergence scene "${node?.title || nodeId}" has ${preds.length} incoming paths without an explicit visual continuity source.`,
        remediation: 'Set visualCanon.continuitySourceNodeId to one incoming predecessor to lock deterministic continuity.',
        nodeId,
      });
    }
  }

  // 2. Node-by-Node Analysis
  for (const node of orderedNodes) {
    const visualCanon = node.visualCanon || {};
    const interaction = node.interactionWindow || {};
    const assets = node.playbackAssets || {};

    // Visual entity validation
    if (universe) {
      // Check character appearances
      const appearances = Array.isArray(visualCanon.characterAppearances) ? visualCanon.characterAppearances : [];
      for (const app of appearances) {
        const charId = app.characterId;
        const char = universe.characters?.find((c) => c.id === charId);
        if (!char) {
          push({
            category: 'visual',
            severity: 'error',
            code: CONTINUITY_CODES.MISSING_UNIVERSE_CHARACTER,
            message: `Bound character "${charId}" in scene "${node.title || node.id}" does not exist in Universe.`,
            remediation: 'Rebind to an existing Universe character or create the character in Universe.',
            nodeId: node.id,
            characterId: charId,
          });
        } else if (app.wardrobeId) {
          const wardrobeExists = Array.isArray(char.wardrobes) && char.wardrobes.some((w) => w.id === app.wardrobeId);
          if (!wardrobeExists) {
            push({
              category: 'visual',
              severity: 'warning',
              code: CONTINUITY_CODES.MISSING_WARDROBE_REFERENCE,
              message: `Bound wardrobe "${app.wardrobeId}" for character "${char.name || charId}" is not in Universe character wardrobes.`,
              remediation: 'Select an approved wardrobe from Universe character sheet.',
              nodeId: node.id,
              characterId: charId,
            });
          }
        }
      }

      // Check places
      if (visualCanon.placeId) {
        const place = universe.places?.find((p) => p.id === visualCanon.placeId);
        if (!place) {
          push({
            category: 'visual',
            severity: 'error',
            code: CONTINUITY_CODES.MISSING_UNIVERSE_PLACE,
            message: `Bound place "${visualCanon.placeId}" in scene "${node.title || node.id}" does not exist in Universe.`,
            remediation: 'Rebind to an existing Universe location.',
            nodeId: node.id,
          });
        }
      }

      // Check objects
      const objectIds = Array.isArray(visualCanon.objectIds) ? visualCanon.objectIds : [];
      for (const objId of objectIds) {
        const obj = universe.objects?.find((o) => o.id === objId);
        if (!obj) {
          push({
            category: 'visual',
            severity: 'error',
            code: CONTINUITY_CODES.MISSING_UNIVERSE_OBJECT,
            message: `Bound object "${objId}" in scene "${node.title || node.id}" does not exist in Universe.`,
            remediation: 'Rebind to an existing Universe object.',
            nodeId: node.id,
          });
        }
      }
    }

    // Check Predecessor Wardrobe Continuity
    const preds = predecessorsByNodeId.get(node.id) || [];
    const explicitSource = visualCanon.continuitySourceNodeId;
    const continuityPreds = preds.length === 1
      ? preds
      : (explicitSource ? preds.filter((pred) => pred.nodeId === explicitSource) : []);
    if (continuityPreds.length === 1) {
      const predNode = nodeById.get(continuityPreds[0].nodeId);
      const predAppearances = Array.isArray(predNode?.visualCanon?.characterAppearances)
        ? predNode.visualCanon.characterAppearances
        : [];
      const currentAppearances = Array.isArray(visualCanon.characterAppearances)
        ? visualCanon.characterAppearances
        : [];
      if (predAppearances.length && currentAppearances.length) {
        for (const app of currentAppearances) {
          const predApp = predAppearances.find((a) => a.characterId === app.characterId);
          if (predApp && predApp.wardrobeId && app.wardrobeId && predApp.wardrobeId !== app.wardrobeId) {
            push({
              category: 'visual',
              severity: 'info',
              code: CONTINUITY_CODES.WARDROBE_DRIFT,
              message: `Character "${app.characterId}" changes wardrobe from "${predApp.wardrobeId}" to "${app.wardrobeId}" across adjacent scenes.`,
              remediation: 'Confirm wardrobe change is intentional in narrative continuity.',
              nodeId: node.id,
              characterId: app.characterId,
            });
          }
        }
      }
    }

    // Voice & Provenance Review
    if (Array.isArray(assets?.provenance?.characters)) {
      const visualCharacterIds = new Set(
        (Array.isArray(visualCanon.characterAppearances) ? visualCanon.characterAppearances : [])
          .map((appearance) => appearance.characterId)
          .filter(Boolean),
      );
      for (const charProv of assets.provenance.characters) {
        const charId = charProv.characterId;
        const voiceInfo = charProv.voice;
        if (charId && visualCharacterIds.size > 0 && !visualCharacterIds.has(charId)) {
          push({
            category: 'voice',
            severity: 'error',
            code: CONTINUITY_CODES.VOICE_PROFILE_BINDING_MISMATCH,
            message: `Voice provenance for character "${charId}" is not bound to a character visible in scene "${node.title || node.id}".`,
            remediation: 'Re-render the asset with the scene character binding or correct the voice binding.',
            nodeId: node.id,
            characterId: charId,
          });
        }
        if (charId && voiceInfo) {
          const key = `${voiceInfo.profileId || 'default'}@v${voiceInfo.profileVersion || 1} (${voiceInfo.engine || 'preset'}:${voiceInfo.modelRevision || 'unknown'})`;
          if (!characterVoiceRevisions.has(charId)) {
            characterVoiceRevisions.set(charId, new Map());
          }
          const revMap = characterVoiceRevisions.get(charId);
          const nodeList = revMap.get(key) || [];
          nodeList.push(node.id);
          revMap.set(key, nodeList);

          const canonCharacter = universe?.characters?.find((character) => character.id === charId);
          const pronunciationRevision = Number.isFinite(voiceInfo.pronunciationRevision)
            ? voiceInfo.pronunciationRevision
            : null;
          if (pronunciationRevision !== null
            && Number.isFinite(canonCharacter?.voiceCanon?.version)
            && pronunciationRevision !== canonCharacter.voiceCanon.version) {
            push({
              category: 'voice',
              severity: 'warning',
              code: CONTINUITY_CODES.PRONUNCIATION_REVISION_DRIFT,
              message: `Character "${charId}" audio uses pronunciation revision ${pronunciationRevision}, but the current Universe voice canon is revision ${canonCharacter.voiceCanon.version}.`,
              remediation: 'Re-render dialogue after confirming the current pronunciation anchors.',
              nodeId: node.id,
              characterId: charId,
            });
          }

          const matchingProfile = localVoiceProfiles?.find((profile) => profile.id === voiceInfo.profileId);
          if (matchingProfile) {
            if (matchingProfile.binding?.characterId && matchingProfile.binding.characterId !== charId) {
              push({
                category: 'voice',
                severity: 'error',
                code: CONTINUITY_CODES.VOICE_PROFILE_BINDING_MISMATCH,
                message: `Voice profile "${voiceInfo.profileId}" is bound to a different character than scene provenance expects.`,
                remediation: 'Select the voice profile bound to this scene character and re-render the dialogue asset.',
                nodeId: node.id,
                characterId: charId,
              });
            }
            if (Number.isFinite(voiceInfo.profileVersion) && matchingProfile.version !== voiceInfo.profileVersion) {
              push({
                category: 'voice',
                severity: 'warning',
                code: CONTINUITY_CODES.VOICE_PROFILE_REVISION_DRIFT,
                message: `Character "${charId}" audio uses voice profile revision ${voiceInfo.profileVersion}, while the installed profile is revision ${matchingProfile.version}.`,
                remediation: 'Re-render dialogue assets with the installed approved voice profile revision.',
                nodeId: node.id,
                characterId: charId,
              });
            }
            if (voiceInfo.engine && matchingProfile.engine && voiceInfo.engine !== matchingProfile.engine) {
              push({
                category: 'voice',
                severity: 'warning',
                code: CONTINUITY_CODES.VOICE_ENGINE_DRIFT,
                message: `Character "${charId}" audio uses engine "${voiceInfo.engine}", while the installed profile uses "${matchingProfile.engine}".`,
                remediation: 'Re-render dialogue with the approved profile engine.',
                nodeId: node.id,
                characterId: charId,
              });
            }
            if (voiceInfo.modelRevision && matchingProfile.modelRevision
              && voiceInfo.modelRevision !== matchingProfile.modelRevision) {
              push({
                category: 'voice',
                severity: 'warning',
                code: CONTINUITY_CODES.VOICE_MODEL_REVISION_DRIFT,
                message: `Character "${charId}" audio uses model revision "${voiceInfo.modelRevision}", while the installed profile uses "${matchingProfile.modelRevision}".`,
                remediation: 'Re-render dialogue with the model revision recorded by the approved profile.',
                nodeId: node.id,
                characterId: charId,
              });
            }
          }
        }
      }
    }

    // Interaction & Voice Binding check
    if (interaction.enabled && interaction.protagonistCharacterId) {
      const charId = interaction.protagonistCharacterId;
      const approvedProfile = localVoiceProfiles?.find(
        (p) => p.binding?.characterId === charId && p.approval?.status === 'approved',
      );
      if (!approvedProfile) {
        push({
          category: 'voice',
          severity: 'warning',
          code: CONTINUITY_CODES.NO_APPROVED_VOICE_PROFILE,
          message: `Live interaction protagonist "${charId}" has no approved local voice profile in Voice Lab.`,
          remediation: 'Create and approve a local voice profile for this character in Voice Lab.',
          nodeId: node.id,
          characterId: charId,
        });
      }
    }

    // Pronunciation anchor check in scene prose
    const sceneText = `${node.prose || ''} ${node.title || ''}`.toLowerCase();
    for (const term of universeTerms) {
      if (term.length >= 4 && sceneText.includes(term) && !definedPronunciations.has(term)) {
        push({
          category: 'voice',
          severity: 'info',
          code: CONTINUITY_CODES.MISSING_PRONUNCIATION_ANCHOR,
          message: `Universe term "${term}" appears in scene dialogue/prose without a defined pronunciation anchor.`,
          remediation: 'Add a pronunciation guide for this term in Universe voiceCanon.pronunciations.',
          nodeId: node.id,
        });
      }
    }

    // Playback & Hosted Safety Review
    if (Array.isArray(assets.holdLoopVideoHistoryIds) && assets.holdLoopVideoHistoryIds.length) {
      for (const holdId of assets.holdLoopVideoHistoryIds) {
        const occ = assets.audioOccupancy?.[holdId];
        if (occ) {
          const validated = validateAudioOccupancy(occ);
          if (validated.characterDialogue.length > 0) {
            push({
              category: 'playback',
              severity: 'error',
              code: CONTINUITY_CODES.HOLD_LOOP_HAS_DIALOGUE,
              message: `Hold loop "${holdId}" in scene "${node.title || node.id}" contains rendered dialogue and cannot be used for live interaction.`,
              remediation: 'Remove dialogue from hold loop or render as separate entry clip.',
              nodeId: node.id,
              assetId: holdId,
            });
          }
          if (validated.effects.some((e) => e.blocking)) {
            push({
              category: 'playback',
              severity: 'warning',
              code: CONTINUITY_CODES.HOLD_LOOP_HAS_BLOCKING_EFFECTS,
              message: `Hold loop "${holdId}" contains author-marked voice-blocking sound effects.`,
              remediation: 'Unmark blocking flag or adjust effect timing.',
              nodeId: node.id,
              assetId: holdId,
            });
          }
          if (validated.clipping) {
            push({
              category: 'playback',
              severity: 'error',
              code: CONTINUITY_CODES.HOLD_LOOP_HAS_CLIPPING,
              message: `Hold loop "${holdId}" contains clipped audio${validated.peakDb !== undefined ? ` (peak ${validated.peakDb} dBFS)` : ''}.`,
              remediation: 'Remaster the hold loop below digital full scale before enabling hosted interaction.',
              nodeId: node.id,
              assetId: holdId,
            });
          }
        }
      }
    }

    if (interaction.enabled) {
      if (interaction.protagonistPresence === 'onscreen') {
        push({
          category: 'playback',
          severity: 'warning',
          code: CONTINUITY_CODES.PROTAGONIST_ONSCREEN_INTERACTION,
          message: `Scene "${node.title || node.id}" has live voice enabled with onscreen protagonist presence.`,
          remediation: 'Change protagonist presence to off-screen for seamless live voice conversation.',
          nodeId: node.id,
        });
      }
      if (node.isEnding || node.playbackMode === 'cut') {
        push({
          category: 'playback',
          severity: 'error',
          code: CONTINUITY_CODES.INTERACTION_ON_ENDING_OR_CUT,
          message: `Scene "${node.title || node.id}" has live interaction enabled on an ending or automatic cut scene.`,
          remediation: 'Disable live interaction on this scene or change playbackMode to decision.',
          nodeId: node.id,
        });
      }
      if (loom?.participationMode === 'helper' && node.audienceConnection !== 'connected') {
        push({
          category: 'playback',
          severity: 'error',
          code: CONTINUITY_CODES.DISCONNECTED_INTERACTION_CHANNEL,
          message: `Scene "${node.title || node.id}" has live voice enabled while audience communication channel is disconnected.`,
          remediation: 'Set audience connection to connected or disable live interaction.',
          nodeId: node.id,
        });
      }
    }
  }

  // Check for voice profile revision drift across the episode
  for (const [charId, revMap] of characterVoiceRevisions.entries()) {
    const revisions = Array.from(revMap.keys());
    const profileRevisions = new Set(revisions.map((value) => value.replace(/\s+\([^)]*\)$/, '')));
    const engines = new Set(revisions.map((value) => value.match(/\(([^:]+):/)?.[1] || 'unknown'));
    const modelRevisions = new Set(revisions.map((value) => value.match(/\([^:]+:(.*)\)$/)?.[1] || 'unknown'));
    if (profileRevisions.size > 1) {
      push({
        category: 'voice',
        severity: 'warning',
        code: CONTINUITY_CODES.VOICE_PROFILE_REVISION_DRIFT,
        message: `Character "${charId}" has assets rendered with different voice profile revisions across scenes (${revisions.join(', ')}).`,
        remediation: 'Re-render dialogue assets with the latest approved voice profile for consistent character voice.',
        characterId: charId,
      });
    }
    if (engines.size > 1) {
      push({
        category: 'voice',
        severity: 'warning',
        code: CONTINUITY_CODES.VOICE_ENGINE_DRIFT,
        message: `Character "${charId}" has assets rendered with different voice engines across scenes (${Array.from(engines).join(', ')}).`,
        remediation: 'Re-render dialogue assets with one approved voice engine for the episode.',
        characterId: charId,
      });
    }
    if (modelRevisions.size > 1) {
      push({
        category: 'voice',
        severity: 'warning',
        code: CONTINUITY_CODES.VOICE_MODEL_REVISION_DRIFT,
        message: `Character "${charId}" has assets rendered with different voice model revisions across scenes (${Array.from(modelRevisions).join(', ')}).`,
        remediation: 'Re-render dialogue assets with one recorded model revision for the episode.',
        characterId: charId,
      });
    }
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;

  const categoryCounts = {
    visual: findings.filter((f) => f.category === 'visual').length,
    voice: findings.filter((f) => f.category === 'voice').length,
    playback: findings.filter((f) => f.category === 'playback').length,
    graph: findings.filter((f) => f.category === 'graph').length,
  };

  return {
    passed: errorCount === 0,
    summary: {
      totalFindings: findings.length,
      errors: errorCount,
      warnings: warningCount,
      info: infoCount,
      categoryCounts,
    },
    nodesEvaluated: orderedNodes.length,
    findings,
  };
}
