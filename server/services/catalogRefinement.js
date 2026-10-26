import { CATALOG_REDESIGN_FIELDS } from '../lib/catalogRedesign.js';
import { ServerError } from '../lib/errorHandler.js';
import { getIngredient } from './catalogDB/ingredients.js';
import { getPrimitiveContext } from './catalogPrimitives.js';
import { composeCreativeRefinement, creativeRefinementAdditions, converseCreativeRefinement } from './creativeRefinement.js';

export async function refineCatalogDraft(id, input, { preview = false } = {}) {
  const item = await getIngredient(id);
  if (!item) throw new ServerError('Ingredient not found', { status: 404 });
  const fields = CATALOG_REDESIGN_FIELDS[item.type];
  if (!fields || Object.keys(input.draft).some(key => !Object.hasOwn(fields, key) || input.draft[key].length > fields[key])) {
    throw new ServerError('Unsupported redesign fields', { status: 400 });
  }
  const ownership = await getPrimitiveContext(id, { includeDerived: false });
  let universe = null;
  if (ownership.owner) {
    const { getUniverse } = await import('./universeBuilder/crud.js');
    const world = await getUniverse(ownership.owner.refId);
    if (world) universe = { name: world.name, logline: world.logline, premise: world.premise, styleNotes: world.styleNotes, influences: world.influences };
  }
  const established = Object.fromEntries(['role', 'coreTheme', 'personality', 'background', 'era', 'significance']
    .filter(key => typeof item.payload?.[key] === 'string').map(key => [key, item.payload[key]]));
  const args = { ...input, fieldLimits: fields, context: { type: item.type, name: item.name, established, universe, fieldLimits: fields } };
  return preview ? { sentPrompt: composeCreativeRefinement(args), promptAdditions: creativeRefinementAdditions(args) } : converseCreativeRefinement(args);
}
