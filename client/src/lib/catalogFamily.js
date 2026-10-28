// Family picks held by a create form before the record exists: `{ kind, id,
// name }` items, sent as the create body's `relations`.
export const addFamilyItem = (list, kind, record) => (list.some((item) => item.kind === kind && item.id === record.id)
  ? list : [...list, { kind, id: record.id, name: record.name }]);

export const removeFamilyItem = (list, target) => list.filter((item) => !(item.kind === target.kind && item.id === target.id));

export const familyRelations = (list) => list.map(({ kind, id }) => ({ kind, toId: id }));
