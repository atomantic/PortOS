// A selection returned by a save is immediately available to its caller's
// model hook, before the shared provider-list invalidation finishes.
//
// Bounded client-local saved selection handoff from a successful save to model hooks while provider
// lists refresh; no HTTP calls.
const selections = new Map();
export const getCreatedExecutionSelection = id => selections.get(id);
export function rememberExecutionSelection(selection) {
  selections.set(selection.id, selection);
  if (selections.size > 200) selections.delete(selections.keys().next().value);
}
