// Return a copy of the choices ordered by their displayed labels.

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

export function sortByLabel(choices, getLabel = (choice) => choice.name) {
  return [...choices].sort((a, b) => collator.compare(getLabel(a) ?? '', getLabel(b) ?? ''));
}
