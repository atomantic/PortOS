// Pure column logic for the Jira Kanban board (client/src/components/KanbanBoard.jsx).
// Extracted so the bucketing / matching / coloring rules are unit-testable
// without React or dnd-kit. No side effects, no imports.

// Built-in fallback board: the three Jira status categories. Used when no
// board columns could be resolved (no boardId / project, or the fetch failed).
// Empty `statuses` means "match by statusCategory" — see ticketInColumn().
export const FALLBACK_COLUMNS = [
  { name: 'To Do', category: 'To Do', statuses: [] },
  { name: 'In Progress', category: 'In Progress', statuses: [] },
  { name: 'Done', category: 'Done', statuses: [] }
];

const CATEGORY_CONFIG = {
  'To Do': { bg: 'bg-gray-500/10', border: 'border-gray-500/30', dot: 'bg-gray-500', dropBorder: 'border-gray-400' },
  'In Progress': { bg: 'bg-port-accent/10', border: 'border-port-accent/30', dot: 'bg-port-accent', dropBorder: 'border-port-accent' },
  'Done': { bg: 'bg-port-success/10', border: 'border-port-success/30', dot: 'bg-port-success', dropBorder: 'border-port-success' }
};

// Name-based accents so common lifecycle stages read at a glance regardless of
// which statusCategory Jira buckets them under (Blocked/In Review are both
// "In Progress" to Jira). First match wins; otherwise fall back to category.
const NAME_CONFIG = [
  { test: /block|impede/i, config: { bg: 'bg-port-error/10', border: 'border-port-error/30', dot: 'bg-port-error', dropBorder: 'border-port-error' } },
  { test: /review|qa|verify|test/i, config: { bg: 'bg-purple-500/10', border: 'border-purple-500/30', dot: 'bg-purple-500', dropBorder: 'border-purple-400' } }
];

export function columnConfig(column) {
  const named = NAME_CONFIG.find(n => n.test.test(column.name));
  if (named) return named.config;
  return CATEGORY_CONFIG[column.category] || CATEGORY_CONFIG['In Progress'];
}

// Match a ticket to a column: by explicit status name when the column lists
// statuses, otherwise by statusCategory (the fallback three-category board).
export function ticketInColumn(ticket, column) {
  return column.statuses.length
    ? column.statuses.includes(ticket.status)
    : ticket.statusCategory === column.category;
}

// Bucket tickets into the resolved columns. Any ticket whose status maps to no
// column (workflow drift, board misconfiguration) gets its own appended column
// so nothing silently disappears from the board. Each column carries:
//   - a stable unique `id` — Jira boards may have two columns with the same
//     display name (mapped to different statuses), so `name` is NOT unique and
//     must not be used as a React key / droppable id / drop-target lookup;
//     callers route drops by `id`.
//   - its precomputed color `config` so render doesn't re-test the regexes.
export function bucketTickets(columns, tickets) {
  const result = columns.map((c, i) => ({ ...c, id: `col-${i}`, config: columnConfig(c), tickets: [] }));
  const extra = new Map();
  for (const ticket of tickets) {
    const col = result.find(c => ticketInColumn(ticket, c));
    if (col) {
      col.tickets.push(ticket);
      continue;
    }
    const name = ticket.status || 'Unknown';
    let orphan = extra.get(name);
    if (!orphan) {
      orphan = { id: `orphan-${name}`, name, category: ticket.statusCategory || 'In Progress', statuses: [ticket.status].filter(Boolean), tickets: [] };
      orphan.config = columnConfig(orphan);
      extra.set(name, orphan);
    }
    orphan.tickets.push(ticket);
  }
  return [...result, ...extra.values()];
}
