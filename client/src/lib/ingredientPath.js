/**
 * Pure route builder for a catalog ingredient's detail page without pulling in server vocabularies.
 */

const LIBRARY_PATH_BY_TYPE = Object.freeze({
  character: '/casting',
  place: '/environments',
  object: '/objects',
});

// Detail route for an ingredient: its creative library page when it has one,
// otherwise the generic catalog editor.
export function ingredientPath(ingredient) {
  const id = encodeURIComponent(ingredient?.id || '');
  const basePath = LIBRARY_PATH_BY_TYPE[ingredient?.type];
  return basePath ? `${basePath}/${id}` : `/catalog/${encodeURIComponent(ingredient?.type || 'idea')}/${id}`;
}
