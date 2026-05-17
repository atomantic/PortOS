import { joinInfluenceList } from './joinInfluenceList';

// Build the client-side style preset that `composeStyledPrompt` layers on top
// of per-entity image-gen prompts. Mirrors `applyWorldStyle` /
// `buildStyleClause` on the server so canon ref renders share the same visual
// language as comic-page renders.
//
// `universe` may be null — the server-side path still applies the series
// override when only the series has style content (orphan or failed load), so
// the client must do the same. `series` is optional; when omitted the result
// is the universe-only preset (Universe Builder canon section).
export const universeStylePreset = (universe, series = null) => {
  const override = (series?.stylePromptOverride || '').trim();
  const embrace = universe ? joinInfluenceList(universe.influences?.embrace) : '';
  const avoid = universe ? joinInfluenceList(universe.influences?.avoid) : '';
  const prompt = [override, embrace].filter(Boolean).join('. ');
  if (!prompt && !avoid) return null;
  return { prompt, negativePrompt: avoid };
};
