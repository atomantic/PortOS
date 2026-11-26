// Keep short names for distinct records and identify colliding names by their full record ID.
export function cardRecordLabels(entries) {
  const labels = new Map(entries);
  const owners = new Map();
  for (const [id, label] of labels) {
    const normalized = label.replace(/\s+/g, ' ').trim();
    if (owners.has(normalized)) {
      labels.set(id, `${label} (${id})`);
      const first = owners.get(normalized);
      labels.set(first, `${normalized} (${first})`);
    } else {
      owners.set(normalized, id);
    }
  }
  return labels;
}

export function taskCardLabel(task) {
  return task.description?.trim().slice(0, 60) || task.id;
}
