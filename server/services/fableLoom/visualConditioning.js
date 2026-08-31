/**
 * FableLoom visual-canon compiler.
 *
 * Turns stable scene bindings into the exact prompt, typed input images and
 * local character adapters a render can actually consume. The returned v1
 * manifest is durable provenance: unsupported/over-budget inputs are named,
 * never silently discarded, and a locked scene fails before enqueue.
 */

import { basename, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, resolveImageInputPath, sha256File } from '../../lib/fileUtils.js';
import { characterIdentityPackReadiness } from '../../lib/storyBible.js';
import {
  matchCharactersInText, matchObjectsInText, matchPlacesInText,
} from '../../lib/scenePrompt.js';
import { resolveFableLoomProtagonistPresence } from '../../lib/fableLoomPlayback.js';
import {
  mergeNegativePromptTokens, stripStyleClause, universeVisualStyleTokens,
} from '../../lib/universeVisualStyle.js';
import { getUniverse } from '../universeBuilder.js';
import { resolveCharacterLoras } from '../characterLoraResolver.js';
import { getSeries } from '../pipeline/series.js';
import { getLoom } from './records.js';

export const FABLELOOM_VISUAL_COMPILER_VERSION = '1.0.0';

const byId = (list) => new Map((Array.isArray(list) ? list : []).filter((item) => item?.id).map((item) => [item.id, item]));
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const compact = (values) => values.map(text).filter(Boolean);
const unique = (values) => [...new Set(values.filter(Boolean))];
const publicAsset = (path, role, bindingId, required = false) => ({
  role, bindingId, required, filename: basename(path), path,
});
const adapterDigestCache = new Map();

const adapterDigest = async (path, hashFile) => {
  if (hashFile !== sha256File) return hashFile(path);
  const info = await stat(path);
  const key = `${info.size}:${info.mtimeMs}`;
  const cached = adapterDigestCache.get(path);
  if (cached?.key === key) return cached.sha256;
  const sha256 = await hashFile(path);
  adapterDigestCache.set(path, { key, sha256 });
  if (adapterDigestCache.size > 64) adapterDigestCache.delete(adapterDigestCache.keys().next().value);
  return sha256;
};

const visualPromptForCharacter = (character, appearance, triggerWords) => {
  const wardrobe = character.wardrobes?.find((item) => item.id === appearance?.wardrobeId);
  return compact([
    `Character: ${character.name}`,
    character.physicalDescription || character.visualIdentity || character.visualNotes,
    wardrobe && `Wardrobe: ${wardrobe.name || wardrobe.label || ''} ${wardrobe.description || wardrobe.prompt || ''}`,
    appearance?.expression && `Expression: ${appearance.expression}`,
    appearance?.continuityNotes && `Continuity: ${appearance.continuityNotes}`,
    triggerWords.length && `Identity adapter triggers: ${triggerWords.join(', ')}`,
  ]).join('. ');
};

const resolveTemporalNode = (episode, node, explicitId) => {
  if (episode.startNodeId === node.id) return { node: null, reason: 'opening-scene' };
  const incoming = episode.nodes.filter((candidate) => candidate.id !== node.id
    && candidate.transitions?.some((transition) => transition.targetNodeId === node.id));
  if (explicitId) {
    const explicit = incoming.find((candidate) => candidate.id === explicitId);
    return explicit ? { node: explicit, reason: 'explicit' } : { node: null, reason: 'invalid-explicit-source' };
  }
  if (incoming.length === 1) return { node: incoming[0], reason: 'single-predecessor' };
  return { node: null, reason: incoming.length > 1 ? 'ambiguous-convergence' : 'no-predecessor' };
};

const bindScene = ({ node, episode, universe, loom }) => {
  const declared = node.visualCanon;
  const characters = Array.isArray(universe.characters) ? universe.characters : [];
  const places = Array.isArray(universe.places) ? universe.places : [];
  const objects = Array.isArray(universe.objects) ? universe.objects : [];
  const sourceText = compact([node.title, node.prose, node.imagePrompt, node.videoPrompt]).join('\n');
  const characterMap = byId(characters);
  const placeMap = byId(places);
  const objectMap = byId(objects);
  const protagonistIds = unique([
    loom?.protagonistCharacterId,
    node.interactionWindow?.protagonistCharacterId,
  ].map(text));
  const protagonistId = protagonistIds[0] || null;
  const protagonistPresence = resolveFableLoomProtagonistPresence(node, loom);
  const rawAppearances = declared
    ? declared.characterAppearances || []
    : matchCharactersInText(sourceText, characters).map((character) => ({ characterId: character.id }));
  const hasCanonicalProtagonist = rawAppearances.some((appearance) => (
    appearance?.characterId === loom?.protagonistCharacterId
  ));
  const appearancesWithImplicitProtagonist = loom?.protagonistCharacterId
    && protagonistPresence !== 'offscreen'
    && characterMap.has(loom.protagonistCharacterId)
    && !hasCanonicalProtagonist
    ? [...rawAppearances, { characterId: loom.protagonistCharacterId }]
    : rawAppearances;
  const appearancesWithBaselineWardrobe = appearancesWithImplicitProtagonist.map((appearance) => {
    if (appearance?.characterId !== loom?.protagonistCharacterId || !loom?.protagonistWardrobeId) {
      return appearance;
    }
    // A selected wardrobe is the default for the protagonist. A locked
    // wardrobe also overrides a stale scene-local selection so a re-render
    // cannot silently change clothes between episodes.
    return loom.protagonistWardrobeLocked || !appearance.wardrobeId
      ? { ...appearance, wardrobeId: loom.protagonistWardrobeId }
      : appearance;
  });
  const offscreenAppearances = protagonistPresence === 'offscreen'
    ? appearancesWithBaselineWardrobe.filter((appearance) => protagonistIds.includes(appearance?.characterId))
    : [];
  const appearances = appearancesWithBaselineWardrobe.filter(
    (appearance) => !offscreenAppearances.includes(appearance),
  );
  const boundCharacters = appearances.map((appearance) => ({ appearance, character: characterMap.get(appearance.characterId) }))
    .filter((item) => item.character);
  const boundPlace = declared
    ? placeMap.get(declared.placeId) || null
    : matchPlacesInText(sourceText, places)[0] || null;
  const boundObjects = declared
    ? (declared.objectIds || []).map((id) => objectMap.get(id)).filter(Boolean)
    : matchObjectsInText(sourceText, objects);
  const missing = declared ? [
    ...appearances.filter((item) => !characterMap.has(item.characterId)).map((item) => ({ role: 'character', bindingId: item.characterId, reason: 'binding-not-found' })),
    ...appearances.filter((item) => {
      const character = characterMap.get(item.characterId);
      return item.wardrobeId && character && !character.wardrobes?.some((wardrobe) => wardrobe.id === item.wardrobeId);
    }).map((item) => ({ role: 'wardrobe', bindingId: item.wardrobeId, reason: 'binding-not-found' })),
    ...(declared.placeId && !boundPlace ? [{ role: 'environment', bindingId: declared.placeId, reason: 'binding-not-found' }] : []),
    ...(declared.objectIds || []).filter((id) => !objectMap.has(id)).map((id) => ({ role: 'object', bindingId: id, reason: 'binding-not-found' })),
    ...(loom?.protagonistCharacterId && !characterMap.has(loom.protagonistCharacterId)
      ? [{ role: 'protagonist', bindingId: loom.protagonistCharacterId, reason: 'binding-not-found' }]
      : []),
    ...(protagonistPresence !== 'offscreen'
      && loom?.protagonistWardrobeId
      && characterMap.has(loom.protagonistCharacterId)
      && !characterMap.get(loom.protagonistCharacterId).wardrobes?.some((wardrobe) => wardrobe.id === loom.protagonistWardrobeId)
      ? [{ role: 'protagonist-wardrobe', bindingId: loom.protagonistWardrobeId, reason: 'binding-not-found' }]
      : []),
  ] : [];
  return {
    declared: Boolean(declared),
    appearances,
    boundCharacters,
    boundPlace,
    boundObjects,
    missing,
    protagonistId,
    protagonistPresence,
    protagonistWardrobeId: loom?.protagonistWardrobeId || null,
    offscreenAppearances,
  };
};

const imageAssetsForCharacter = (character, locked, resolveAsset) => {
  const readiness = characterIdentityPackReadiness(character);
  const roleRank = new Map(['neutral', 'profile', 'full-body', 'expression-gesture', 'wardrobe', 'prop-scale', 'negative-identity']
    .map((role, index) => [role, index]));
  const unavailable = [];
  const approved = [...readiness.assets].sort((left, right) => (
    (roleRank.get(left.role) ?? 99) - (roleRank.get(right.role) ?? 99)
  )).map((asset) => {
    const path = resolveAsset(asset.imageRef);
    if (!path) unavailable.push({
      role: `character-${asset.role}`, bindingId: character.id, reason: 'asset-unavailable',
    });
    return path ? publicAsset(path, `character-${asset.role}`, character.id) : null;
  }).filter(Boolean);
  if (approved.length) return {
    primary: [{ ...approved[0], required: true }], supplemental: approved.slice(1), readiness, unavailable,
  };
  if (locked) return { primary: [], supplemental: [], readiness, unavailable };
  const fallback = resolveAsset(character.primaryImageRef || character.referenceSheetImageRef);
  return {
    primary: fallback ? [publicAsset(fallback, 'character-draft-reference', character.id)] : [],
    supplemental: [], readiness, unavailable,
  };
};

const allocateAssets = (candidates, capability) => {
  const supported = new Set(capability.referenceRoles || []);
  const accepted = [];
  const omitted = [];
  for (const candidate of candidates) {
    if (!supported.has(candidate.role) && !supported.has(candidate.role.split('-').slice(0, 2).join('-'))) {
      omitted.push({ role: candidate.role, bindingId: candidate.bindingId, reason: 'capability-unsupported' });
    } else if (accepted.length >= capability.referenceBudget) {
      omitted.push({ role: candidate.role, bindingId: candidate.bindingId, reason: 'reference-budget' });
    } else {
      accepted.push(candidate);
    }
  }
  return { accepted, omitted };
};

const blockedError = (messages, manifest) => new ServerError(
  `Canon-locked render cannot preserve the declared scene: ${messages.join('; ')}`,
  {
    status: 409,
    code: 'FABLELOOM_CANON_CONDITIONING_UNAVAILABLE',
    context: { details: { visualConditioning: manifest } },
  },
);

/**
 * Compile one tagged render. Dependencies are injectable so tests exercise
 * the real public compiler contract without touching the live universe store.
 */
export async function compileFableLoomVisualRequest({
  tag, kind, capability, authoredPrompt = '', authoredNegativePrompt = '', sourceImagePath = null,
  loadLoom = getLoom, loadUniverse = getUniverse, loadSeries = getSeries,
  resolveLoras = resolveCharacterLoras,
  hashFile = sha256File, resolveAsset = resolveImageInputPath,
  now = () => new Date().toISOString(),
}) {
  if (!tag?.loomId || !tag.episodeId || !tag.nodeId) return null;
  const loom = await loadLoom(tag.loomId);
  const episode = loom?.episodes?.find((item) => item.id === tag.episodeId);
  const node = episode?.nodes?.find((item) => item.id === tag.nodeId);
  if (!loom || !episode || !node) throw new ServerError('FableLoom scene not found', { status: 404, code: 'NOT_FOUND' });
  const series = !loom.universeId && loom.seriesId ? await loadSeries(loom.seriesId).catch(() => null) : null;
  const universeId = loom.universeId || series?.universeId || null;
  const universe = universeId ? await loadUniverse(universeId) : null;
  // Legacy/unlinked scenes keep their pre-compiler prompt-only behavior. A
  // scene carrying explicit canon bindings must resolve the canon it names.
  if (!universe && !node.visualCanon) return null;
  if (!universe) throw new ServerError('FableLoom linked universe not found', { status: 409, code: 'FABLELOOM_UNIVERSE_UNAVAILABLE' });

  const bindings = bindScene({ node, episode, universe, loom });
  const locked = bindings.declared && node.visualCanon.mode !== 'draft';
  const warnings = bindings.declared ? [] : ['Bindings inferred from scene text; render is draft-only'];
  const failures = [];
  const omitted = [...bindings.missing];
  omitted.push(...bindings.offscreenAppearances.map((appearance) => ({
    role: 'character',
    bindingId: appearance.characterId,
    reason: 'protagonist-offscreen',
  })));
  if (locked && bindings.missing.length) failures.push('one or more stable bindings no longer resolve');
  if (locked && bindings.boundCharacters.length > 1 && !capability.multiCharacterPreservation) {
    failures.push(`backend does not declare multi-character preservation for ${bindings.boundCharacters.length} characters`);
  }

  const loraMatches = capability.supportsLora
    ? await resolveLoras(bindings.boundCharacters.map(({ character }) => character), {
      compatKey: capability.loraCompatKey || null, max: Number.MAX_SAFE_INTEGER, allPerCharacter: true,
    })
    : [];
  const acceptedLoras = loraMatches.slice(0, capability.loraBudget || 0);
  const omittedLoras = loraMatches.slice(acceptedLoras.length);
  omitted.push(...omittedLoras.map((lora) => ({
    role: 'character-adapter',
    bindingId: lora.character?.entryId || lora.character?.ingredientId || null,
    filename: basename(lora.filename),
    reason: 'adapter-budget',
  })));
  if (locked && omittedLoras.length) failures.push('compatible character adapters exceed the backend adapter budget');
  const adapterTriggerWords = new Map();
  const adapters = [];
  for (const lora of acceptedLoras) {
    const path = join(PATHS.loras, basename(lora.filename));
    const sha256 = await adapterDigest(path, hashFile).catch(() => null);
    adapters.push({
      characterId: lora.character?.entryId || null,
      filename: basename(lora.filename), scale: lora.scale, sha256,
    });
    if (locked && !sha256) failures.push(`adapter ${basename(lora.filename)} could not be fingerprinted`);
    if (lora.triggerWord) {
      const id = lora.character?.entryId;
      adapterTriggerWords.set(id, [...(adapterTriggerWords.get(id) || []), lora.triggerWord]);
    }
  }
  if (!capability.supportsLora && bindings.boundCharacters.length) {
    omitted.push(...bindings.boundCharacters.map(({ character }) => ({ role: 'character-adapter', bindingId: character.id, reason: 'capability-unsupported' })));
  }

  const temporal = resolveTemporalNode(episode, node, node.visualCanon?.continuitySourceNodeId);
  const candidates = [];
  if (kind === 'video') {
    const approvedStoryboardPath = resolveAsset(node.image);
    const requestedCurrentStoryboard = approvedStoryboardPath && sourceImagePath
      && basename(approvedStoryboardPath) === basename(sourceImagePath);
    if (requestedCurrentStoryboard && node.visualCanon?.storyboardImageApproved) {
      candidates.push(publicAsset(approvedStoryboardPath, 'storyboard-first-frame', node.id, locked));
    } else {
      omitted.push({ role: 'storyboard-first-frame', bindingId: node.id, reason: 'missing-stale-or-unapproved' });
      if (locked) failures.push('storyboard first frame is missing, stale, or not author-approved');
    }
  } else {
    if (temporal.node) {
      const path = temporal.node.image ? resolveAsset(temporal.node.image) : null;
      if (path) candidates.push(publicAsset(path, 'temporal-predecessor', temporal.node.id, locked));
      else {
        omitted.push({ role: 'temporal-predecessor', bindingId: temporal.node.id, reason: 'asset-unavailable' });
        if (locked) failures.push('temporal predecessor image is unavailable');
      }
    } else if (temporal.reason === 'invalid-explicit-source' || temporal.reason === 'ambiguous-convergence') {
      omitted.push({ role: 'temporal-predecessor', bindingId: null, reason: temporal.reason });
      if (locked) failures.push(temporal.reason === 'invalid-explicit-source'
        ? 'explicit temporal source is not an incoming graph predecessor'
        : 'convergent scene needs an explicit incoming temporal source');
    }
    const characterAssets = [];
    for (const { character } of bindings.boundCharacters) {
      const resolved = imageAssetsForCharacter(character, locked, resolveAsset);
      if (locked && resolved.readiness.status !== 'ready') failures.push(`${character.name} identity package is ${resolved.readiness.status}`);
      if (locked && resolved.primary.length === 0) failures.push(`${character.name} approved identity assets are unavailable`);
      omitted.push(...resolved.unavailable);
      characterAssets.push(resolved);
    }
    // Guarantee each cast member's primary approved identity anchor is
    // considered before supplemental profile/body sheets consume the budget.
    candidates.push(...characterAssets.flatMap((item) => item.primary));
    candidates.push(...characterAssets.flatMap((item) => item.supplemental));
    if (bindings.boundPlace?.primaryImageRef) {
      const path = resolveAsset(bindings.boundPlace.primaryImageRef);
      if (path) candidates.push(publicAsset(path, 'environment', bindings.boundPlace.id));
      else omitted.push({ role: 'environment', bindingId: bindings.boundPlace.id, reason: 'asset-unavailable' });
    } else if (bindings.boundPlace) {
      omitted.push({ role: 'environment', bindingId: bindings.boundPlace.id, reason: 'reference-not-configured' });
    }
    for (const object of bindings.boundObjects) {
      const path = resolveAsset(object.primaryImageRef);
      if (path) candidates.push(publicAsset(path, 'object', object.id));
      else omitted.push({
        role: 'object', bindingId: object.id,
        reason: object.primaryImageRef ? 'asset-unavailable' : 'reference-not-configured',
      });
    }
  }

  const allocation = allocateAssets(candidates, capability);
  omitted.push(...allocation.omitted);
  if (locked && allocation.omitted.some((item) => candidates.find((asset) => asset.role === item.role && asset.bindingId === item.bindingId)?.required)) {
    failures.push('required canon assets exceed or are unsupported by the backend capability manifest');
  }

  const characterPrompts = bindings.boundCharacters.map(({ character, appearance }) => visualPromptForCharacter(
    character, appearance, adapterTriggerWords.get(character.id) || [],
  ));
  const placePrompt = bindings.boundPlace && compact([
    `Environment: ${bindings.boundPlace.name || bindings.boundPlace.slugline}`,
    bindings.boundPlace.description, bindings.boundPlace.recurringDetails,
  ]).join('. ');
  const objectPrompts = bindings.boundObjects.map((object) => compact([
    `Object: ${object.name}`, object.description, object.significance,
  ]).join('. '));
  // Curated visual tokens only — `universe.styleNotes` is writing-stage
  // direction (see lib/universeVisualStyle.js). The browser composes this same
  // preset onto the scene prompt before POSTing, so strip ITS copy and keep
  // ours: the clause below leads the prompt, and only a leading copy gets the
  // early-token weighting a diffusion model gives style.
  const universeStyle = universeVisualStyleTokens(universe).embrace.join(', ');
  const authoredBody = stripStyleClause(authoredPrompt, universeStyle);
  const protagonistFraming = bindings.protagonistPresence === 'offscreen'
    ? 'Framing constraint: the canonical protagonist is speaking through the communicator off-screen. The camera is the remote witness: show the obstacle or environment the protagonist cannot see around a corner, beyond a bend, at a distance, or otherwise outside their sightline. The communicator stays on the protagonist\'s person and completely out of frame; never use a standalone comms device as the subject. Do not show their face, body, silhouette, or duplicate presence in this storyboard image.'
    : '';
  const positive = compact([
    universeStyle && `Universe style: ${universeStyle}`,
    placePrompt, ...characterPrompts, ...objectPrompts,
    protagonistFraming,
    authoredBody || (kind === 'video' ? node.videoPrompt || node.prose : node.imagePrompt),
    node.visualCanon?.shotNotes && `Shot continuity: ${node.visualCanon.shotNotes}`,
  ]).join('\n\n').slice(0, 8000);
  const identityAvoid = bindings.boundCharacters.flatMap(({ character }) => character.identityPack?.avoid || []);
  const negativePrompt = mergeNegativePromptTokens([
    authoredNegativePrompt,
    bindings.protagonistPresence === 'offscreen' ? 'visible canonical protagonist, protagonist face, protagonist body, protagonist silhouette, standalone communicator, comms device close-up, radio prop hero shot' : '',
    universeVisualStyleTokens(universe).avoid,
    identityAvoid,
  ]).join(', ').slice(0, 8000);
  const manifest = {
    version: 1,
    compilerVersion: FABLELOOM_VISUAL_COMPILER_VERSION,
    status: locked ? 'locked' : (omitted.length || warnings.length ? 'degraded' : 'draft'),
    universeId: universe.id,
    capability,
    bindings: {
      inferred: !bindings.declared,
      ...(bindings.protagonistId ? {
        protagonist: {
          characterId: bindings.protagonistId,
          wardrobeId: bindings.protagonistWardrobeId,
          presence: bindings.protagonistPresence || null,
        },
      } : {}),
      characterAppearances: bindings.boundCharacters.map(({ character, appearance }) => ({
        characterId: character.id, wardrobeId: appearance.wardrobeId || null,
        expression: appearance.expression || '', continuityNotes: appearance.continuityNotes || '',
      })),
      placeId: bindings.boundPlace?.id || null,
      objectIds: bindings.boundObjects.map((object) => object.id),
    },
    assets: allocation.accepted.map(({ path: _path, ...asset }) => asset),
    adapters,
    omitted,
    warnings,
    temporalSourceNodeId: temporal.node?.id || null,
    compiledPrompt: positive,
    compiledNegativePrompt: negativePrompt,
    referenceImageStrengths: allocation.accepted.map((asset) => asset.role === 'temporal-predecessor' ? 0.4 : 1),
    compiledAt: now(),
  };
  if (locked && failures.length) throw blockedError(unique(failures), { ...manifest, status: 'degraded', warnings: unique([...warnings, ...failures]) });
  return {
    prompt: positive,
    negativePrompt,
    referenceImagePaths: allocation.accepted.map((asset) => asset.path),
    referenceImageStrengths: allocation.accepted.map((asset) => asset.role === 'temporal-predecessor' ? 0.4 : 1),
    loraFilenames: adapters.map((adapter) => adapter.filename),
    loraScales: adapters.map((adapter) => adapter.scale),
    sourceImagePath: kind === 'video' ? allocation.accepted[0]?.path || null : null,
    visualConditioning: manifest,
  };
}

export function fableLoomImageCapabilities({ mode, model = null, inputBudget = 4 }) {
  const localFlux2 = mode === 'local' && model?.runner === 'flux2';
  const cloudEdit = ['codex', 'grok', 'agy'].includes(mode);
  return Object.freeze({
    version: 1, kind: 'image', backend: mode, modelId: model?.id || null,
    modelRevision: model?.revision || null,
    referenceRoles: localFlux2 || cloudEdit
      ? ['temporal-predecessor', 'character-neutral', 'character-profile', 'character-full-body', 'character-expression-gesture', 'character-wardrobe', 'character-prop-scale', 'character-negative-identity', 'character-draft-reference', 'environment', 'object']
      : [],
    referenceBudget: localFlux2 || cloudEdit ? inputBudget : 0,
    supportsLora: localFlux2 || (mode === 'local' && model?.runner === 'mflux'),
    loraCompatKey: model?.loraCompatKey || null,
    loraBudget: 8,
    multiCharacterPreservation: localFlux2,
  });
}

export function fableLoomVideoCapabilities({ backend, model = null }) {
  const supportedModes = Array.isArray(model?.supportedModes) ? model.supportedModes : [];
  return Object.freeze({
    version: 1, kind: 'video', backend, modelId: model?.id || null,
    modelRevision: model?.revision || null,
    referenceRoles: supportedModes.includes('image') ? ['storyboard-first-frame'] : [],
    referenceBudget: supportedModes.includes('image') ? 1 : 0,
    supportsLora: false,
    loraCompatKey: null,
    loraBudget: 0,
    multiCharacterPreservation: model?.fableLoomMultiCharacterPreservation === true,
    firstFrame: supportedModes.includes('image'),
    lastFrame: supportedModes.includes('fflf'),
    extension: supportedModes.includes('extend'),
  });
}
