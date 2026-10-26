import { BIBLE_LIMITS as L } from './bibleLimits.js';

// Shared by the conversation, editor and output validator: proposals never
// touch runtime bindings, approvals, relationships or production associations.
export const CATALOG_REDESIGN_FIELDS = Object.assign(Object.create(null), {
  character: { physicalDescription: L.PHYSICAL_DESCRIPTION_MAX, visualNotes: L.VISUAL_NOTES_MAX, silhouetteNotes: L.SILHOUETTE_NOTES_MAX, postureNotes: L.POSTURE_NOTES_MAX, prompt: L.PROMPT_MAX },
  place: { description: L.PLACE_DESCRIPTION_MAX, palette: L.PALETTE_MAX, era: L.ERA_MAX, weather: L.WEATHER_MAX, prompt: L.PROMPT_MAX },
  object: { description: L.OBJECT_DESCRIPTION_MAX, significance: L.SIGNIFICANCE_MAX, prompt: L.PROMPT_MAX },
});
