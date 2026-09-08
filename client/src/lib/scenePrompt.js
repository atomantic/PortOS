/**
 * Scene-prompt composer and the bible matchers it uses.
 *
 * Re-export of `server/lib/scenePrompt.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/scenePrompt` import path in the client is unchanged.
 */
export {
  buildCharByKey,
  buildPlaceByKey,
  buildScenePrompt,
  matchCharactersInText,
  matchObjectsInText,
  matchPlacesInText,
  matchSceneCharacters,
  matchScenePlace,
  normCharKey,
  normalizeSlugline,
} from '../../../server/lib/scenePrompt.js';
