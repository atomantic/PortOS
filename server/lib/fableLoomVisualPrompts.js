/**
 * Pure render-text composition for resolved FableLoom canon.
 * Admission, asset allocation and durable provenance belong to the compiler;
 * this step only formats their resolved inputs, preserving Reactor errors.
 */

import { ServerError } from './errorHandler.js';
import { REACTOR_MAX_PROMPT_LENGTH } from './reactorVideoClip.js';
import {
  mergeNegativePromptTokens, stripStyleClause, universeStylePreset, universeVisualStyleTokens,
} from './universeVisualStyle.js';

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const compact = (values) => values.map(text).filter(Boolean);

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

/** Compose prompts from already resolved bindings and allocated references, without I/O or mutation. */
export function buildFableLoomVisualPrompts({
  node, universe, series, bindings, references, temporalSourceNode,
  adapterTriggerWords, kind, capability, authoredPrompt, authoredNegativePrompt,
}) {
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
  // preset (universe embrace tokens PLUS the series style override, in
  // whichever mode the series is set to) onto the scene prompt before
  // POSTing, so build the identical clause here and strip ITS copy rather
  // than emitting the tokens again: the clause below leads the prompt, and
  // only a leading copy gets the early-token weighting a diffusion model
  // gives style. Using the shared `universeStylePreset` (not just the raw
  // embrace tokens) is what keeps a series override — prepend, append, or
  // override — in sync between the FableLoom preview and the actual render
  // (#8442); the plain embrace-only clause never matched an authored prompt
  // that led with an override.
  const universeStyle = universeStylePreset(universe, series)?.prompt || '';
  const authoredBody = stripStyleClause(authoredPrompt, universeStyle);
  const protagonistName = (universe.characters || []).find((character) => character.id === bindings.protagonistId)?.name || 'the canonical protagonist';
  const visibleCast = bindings.boundCharacters.map(({ character }) => character.name).filter(Boolean);
  const protagonistFraming = bindings.protagonistPresence === 'offscreen'
    ? visibleCast.length
      ? `Framing constraint: keep ${protagonistName} off-screen. Show the explicitly bound cast (${visibleCast.join(', ')}) in the authored composition. Their close-ups remain visible even while the protagonist speaks off-screen; do not replace them with an empty environment. Do not show ${protagonistName} or a standalone communicator.`
      : `Framing constraint: ${protagonistName}, the canonical protagonist, is speaking through the communicator off-screen. The camera is the remote witness: show the obstacle or environment the protagonist cannot see around a corner, beyond a bend, at a distance, or otherwise outside their sightline. The communicator stays on the protagonist's person and completely out of frame; never use a standalone comms device as the subject. Do not show their face, body, silhouette, or duplicate presence in this storyboard image.`
    : '';
  let positive = compact([
    universeStyle && `Universe style: ${universeStyle}`,
    placePrompt, ...characterPrompts, ...objectPrompts,
    protagonistFraming,
    'Presentation: no subtitles, captions, dialogue lettering, speech balloons, or text overlays. Dialogue is spoken audio only; never draw the script into the image.',
    node.shot?.framing && `Current camera framing: ${node.shot.framing}`,
    kind === 'image' && references.some((asset) => asset.role === 'temporal-predecessor') && (
      node.shot?.dramaticSceneId && node.shot.dramaticSceneId === temporalSourceNode?.shot?.dramaticSceneId
        ? `Same dramatic scene: use the preceding image as the set continuity reference. Preserve room geometry, window and doorway positions, furniture, props, lighting, wardrobe, character positions and screen direction. Apply the current camera framing with physically plausible parallax; do not redesign the room or copy the previous composition when a new angle is specified. Previous framing: ${temporalSourceNode.shot.framing || 'see reference'}.`
        : 'The preceding image is temporal context. Preserve recurring identities and props, but follow the current authored location and camera framing; do not copy the previous location across an intentional scene change.'
    ),
    references.filter((asset) => asset.role === 'character-draft-reference').map((asset) => {
      const character = bindings.boundCharacters.find((binding) => binding.character.id === asset.bindingId)?.character;
      return `Character reference ${asset.filename}: preserve ${character?.name || 'the bound character'} identity, face, hair or fur, clothing and accessories. Use the authored shot for staging; do not copy reference scene events or other figures.`;
    }).join('\n'),
    authoredBody || (kind === 'video' ? node.videoPrompt || node.prose : node.imagePrompt),
    kind === 'video' && node.shot && `Shot duration: ${node.shot.durationSeconds} seconds. Play only this shot's current script, preserving each named speaker's voice: ${node.prose}`,
    node.visualCanon?.shotNotes && `Shot continuity: ${node.visualCanon.shotNotes}`,
  ]).join('\n\n').slice(0, 8000);
  if (kind === 'video' && capability.backend === 'reactor') {
    if (!references.some((asset) => asset.role === 'storyboard-first-frame')) throw new ServerError('Review and approve the current storyboard reference before rendering with Reactor.', { status: 422, code: 'FABLELOOM_REACTOR_REFERENCE_REQUIRED' });
    positive = compact([
      'Animate this reference as one continuous shot. Preserve its cast, room, props, lighting and screen direction. No subtitles, captions, speech balloons or text overlays. Dialogue is audio only.',
      node.shot?.framing,
      authoredBody || node.videoPrompt,
      node.prose && `Script: ${node.prose}`,
      node.visualCanon?.shotNotes,
      bindings.protagonistPresence === 'offscreen' && `Keep ${protagonistName} off-screen.`,
    ]).join('\n');
    if (positive.length > REACTOR_MAX_PROMPT_LENGTH) throw new ServerError(`Reactor requires a complete shot prompt within ${REACTOR_MAX_PROMPT_LENGTH} characters. Shorten the shot direction or split the dialogue; no render was queued.`, { status: 422, code: 'FABLELOOM_REACTOR_PROMPT_TOO_LONG' });
  }
  const identityAvoid = bindings.boundCharacters.flatMap(({ character }) => character.identityPack?.avoid || []);
  const negativePrompt = mergeNegativePromptTokens([
    authoredNegativePrompt,
    'subtitles, captions, dialogue lettering, speech balloons, text overlays',
    bindings.protagonistPresence === 'offscreen' ? `visible ${protagonistName}, ${protagonistName} face, ${protagonistName} body, ${protagonistName} silhouette, standalone communicator, comms device close-up, radio prop hero shot` : '',
    universeVisualStyleTokens(universe).avoid,
    identityAvoid,
  ]).join(', ').slice(0, 8000);
  return { prompt: positive, negativePrompt };
}
