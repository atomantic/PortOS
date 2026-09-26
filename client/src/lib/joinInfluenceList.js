// Joins a universe's chip-token list (embrace OR avoid) into the
// comma-separated string the renderer's composeStyledPrompt consumes. A pure
// leaf re-exported from server/lib/universeVisualStyle.js — see
// `universeVisualStyleTokens` there, which applies the same per-token
// trim/filter to a whole universe (#8442).
export { joinInfluenceList } from '../../../server/lib/universeVisualStyle.js';
