// Music code languages and source limit shared by authoring and route validation.


// Strudel was the first language; Tone.js the second; SuperCollider is rendered server-side (contained, offline; no browser frame) (client/src/components/music/strudelFrame.js
// mounts a frame document per language, same postMessage protocol for both).
export const MUSIC_CODE_LANGUAGES = Object.freeze(['strudel', 'tonejs', 'supercollider']);

// Longest code the designer accepts, from the LLM or back from the editor.
export const MUSIC_CODE_MAX = 20000;
