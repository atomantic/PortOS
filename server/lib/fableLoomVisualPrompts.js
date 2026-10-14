/**
 * Pure render-text composition for resolved FableLoom canon.
 * Admission, asset allocation and durable provenance belong to the compiler;
 * this step only formats their resolved inputs, preserving Reactor errors.
 */

import { ServerError } from './errorHandler.js';
import { promptAddition } from './modelInput.js';
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

// One labeled block of the composed prompt (#11317), or null when it adds nothing.
const block = (id, label, value) => promptAddition(id, label, value || '');
const joinBlocks = (blocks, separator) => blocks.filter(Boolean).map((item) => item.text).join(separator);

/**
 * Compose prompts from already resolved bindings and allocated references, without I/O or mutation.
 * Returns `{ prompt, negativePrompt, promptAdditions }`: the scene's own text plus each
 * block the compiler adds around it, listed so the render shows what was added (#11317).
 */
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
  // direction (see lib/universeVisualStyle.js). The shared `universeStylePreset`
  // keeps a series override (prepend, append or override) the same here and in
  // the browser's preview (#8442). The browser no longer prefixes this clause
  // to the scene's text (#11317); a request from a client before that, or a
  // production asset saved with it, still leads with the same clause, and only
  // that exact leading copy is dropped so the style is not sent twice.
  const universeStyle = universeStylePreset(universe, series)?.prompt || '';
  const authoredBody = stripStyleClause(authoredPrompt, universeStyle);
  const protagonistName = (universe.characters || []).find((character) => character.id === bindings.protagonistId)?.name || 'the canonical protagonist';
  const visibleCast = bindings.boundCharacters.map(({ character }) => character.name).filter(Boolean);
  const protagonistFraming = bindings.protagonistPresence === 'offscreen'
    ? visibleCast.length
      ? `Framing constraint: keep ${protagonistName} off-screen. Show the explicitly bound cast (${visibleCast.join(', ')}) in the authored composition. Their close-ups remain visible even while the protagonist speaks off-screen; do not replace them with an empty environment. Do not show ${protagonistName} or a standalone communicator.`
      : `Framing constraint: ${protagonistName}, the canonical protagonist, is speaking through the communicator off-screen. The camera is the remote witness: show the obstacle or environment the protagonist cannot see around a corner, beyond a bend, at a distance, or otherwise outside their sightline. The communicator stays on the protagonist's person and completely out of frame; never use a standalone comms device as the subject. Do not show their face, body, silhouette, or duplicate presence in this storyboard image.`
    : '';
  const authored = text(authoredBody) || text(kind === 'video' ? node.videoPrompt || node.prose : node.imagePrompt);
  let blocks = [
    block('universe-style', 'Universe style', universeStyle && `Universe style: ${universeStyle}`),
    block('environment', 'Environment', placePrompt),
    ...characterPrompts.map((value, index) => block(`character-${index + 1}`, `Character: ${bindings.boundCharacters[index].character.name}`, value)),
    ...objectPrompts.map((value, index) => block(`object-${index + 1}`, `Object: ${bindings.boundObjects[index].name}`, value)),
    block('framing-constraint', 'Off-screen protagonist', protagonistFraming),
    block('presentation', 'No on-screen text', 'Presentation: no subtitles, captions, dialogue lettering, speech balloons, or text overlays. Dialogue is spoken audio only; never draw the script into the image.'),
    block('camera-framing', 'Camera framing', node.shot?.framing && `Current camera framing: ${node.shot.framing}`),
    block('continuity-reference', 'Previous image continuity', kind === 'image' && references.some((asset) => asset.role === 'temporal-predecessor') && (
      node.shot?.dramaticSceneId && node.shot.dramaticSceneId === temporalSourceNode?.shot?.dramaticSceneId
        ? `Same dramatic scene: use the preceding image as the set continuity reference. Preserve room geometry, window and doorway positions, furniture, props, lighting, wardrobe, character positions and screen direction. Apply the current camera framing with physically plausible parallax; do not redesign the room or copy the previous composition when a new angle is specified. Previous framing: ${temporalSourceNode.shot.framing || 'see reference'}.`
        : 'The preceding image is temporal context. Preserve recurring identities and props, but follow the current authored location and camera framing; do not copy the previous location across an intentional scene change.'
    )),
    block('character-references', 'Character references', references.filter((asset) => asset.role === 'character-draft-reference').map((asset) => {
      const character = bindings.boundCharacters.find((binding) => binding.character.id === asset.bindingId)?.character;
      return `Character reference ${asset.filename}: preserve ${character?.name || 'the bound character'} identity, face, hair or fur, clothing and accessories. Use the authored shot for staging; do not copy reference scene events or other figures.`;
    }).join('\n')),
    authored ? { authored: true, text: authored } : null,
    block('shot-script', 'Shot length and script', kind === 'video' && node.shot && `Shot duration: ${node.shot.durationSeconds} seconds. Play only this shot's current script, preserving each named speaker's voice: ${node.prose}`),
    block('shot-continuity', 'Shot continuity', node.visualCanon?.shotNotes && `Shot continuity: ${node.visualCanon.shotNotes}`),
  ];
  let separator = '\n\n';
  if (kind === 'video' && capability.backend === 'reactor') {
    if (!references.some((asset) => asset.role === 'storyboard-first-frame')) throw new ServerError('Review and approve the current storyboard reference before rendering with Reactor.', { status: 422, code: 'FABLELOOM_REACTOR_REFERENCE_REQUIRED' });
    const reactorAuthored = text(authoredBody) || text(node.videoPrompt);
    blocks = [
      block('reactor-animate', 'Animate the storyboard', 'Animate this reference as one continuous shot. Preserve its cast, room, props, lighting and screen direction. No subtitles, captions, speech balloons or text overlays. Dialogue is audio only.'),
      block('camera-framing', 'Camera framing', node.shot?.framing),
      reactorAuthored ? { authored: true, text: reactorAuthored } : null,
      block('shot-script', 'Script', node.prose && `Script: ${node.prose}`),
      block('shot-continuity', 'Shot continuity', node.visualCanon?.shotNotes),
      block('framing-constraint', 'Off-screen protagonist', bindings.protagonistPresence === 'offscreen' && `Keep ${protagonistName} off-screen.`),
    ];
    separator = '\n';
  }
  const positive = joinBlocks(blocks, separator);
  // The model's own limit: refused with the count, never cut (#11317).
  if (kind === 'video' && capability.backend === 'reactor' && positive.length > REACTOR_MAX_PROMPT_LENGTH) {
    throw new ServerError(`Reactor requires a complete shot prompt within ${REACTOR_MAX_PROMPT_LENGTH} characters (this one is ${positive.length}). Shorten the shot direction or split the dialogue; no render was queued.`, { status: 422, code: 'FABLELOOM_REACTOR_PROMPT_TOO_LONG' });
  }
  const identityAvoid = bindings.boundCharacters.flatMap(({ character }) => character.identityPack?.avoid || []);
  const addedAvoid = [
    'subtitles, captions, dialogue lettering, speech balloons, text overlays',
    bindings.protagonistPresence === 'offscreen' ? `visible ${protagonistName}, ${protagonistName} face, ${protagonistName} body, ${protagonistName} silhouette, standalone communicator, comms device close-up, radio prop hero shot` : '',
    universeVisualStyleTokens(universe).avoid,
    identityAvoid,
  ];
  const merged = mergeNegativePromptTokens([authoredNegativePrompt, ...addedAvoid]);
  const negativePrompt = merged.join(', ');
  // The authored negative leads the merge, so what follows it is what the compiler added.
  const avoid = merged.slice(mergeNegativePromptTokens([authoredNegativePrompt]).length).join(', ');
  return {
    prompt: positive,
    negativePrompt,
    promptAdditions: [...blocks.filter((item) => item && !item.authored), block('canon-avoid', 'Added to the negative prompt', avoid)].filter(Boolean),
  };
}
