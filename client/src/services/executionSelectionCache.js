// A selection returned by a save is immediately available to its caller's
// model hook, before the shared provider-list invalidation finishes.
const selections = new Map();
export const getCreatedExecutionSelection = id => selections.get(id);
export function rememberExecutionSelection(selection) {
  selections.set(selection.id, selection);
  if (selections.size > 200) selections.delete(selections.keys().next().value);
}
