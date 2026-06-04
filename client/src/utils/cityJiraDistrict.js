// Pure, deterministic helpers for CyberCity's JIRA sprint district (roadmap 3.7): the current
// sprint's tickets become a small construction yard southeast-north of downtown. Each ticket is
// a structure whose form reads its workflow state — To-Do tickets are stacked crates waiting to
// be built, In-Progress tickets are under-construction frames (scaffold), and Done tickets are
// finished, lit buildings. Tickets are gathered across every JIRA-enabled app, deduped by key.
// No three.js / React imports so the topology is unit-testable (mirrors cityTaskQueue.js etc.).

export const JIRA_DISTRICT = {
  // North-east-of-north: a yard between the goal monuments (NE, +30,-40) and downtown, on the
  // -X side so it doesn't collide with the artifact hall (+44,-28) or memory district (-44,-30).
  base: [-20, 0, -44],
  columns: 6, // structures per row before wrapping toward -Z
  spacing: 3.2, // distance between adjacent structures
  maxStructures: 24, // cap; overflow folds into a "+N MORE" marker
  crateSize: 1.1,
  maxHeight: 4.5,
};

// JIRA's three status categories. We normalize the API's statusCategory name to one of these
// buckets; an unrecognized/blank category is treated as 'todo' (safest — it shows as unbuilt).
export const SPRINT_STATES = {
  todo: { key: 'todo', label: 'TO DO', color: '#64748b' }, // slate — not started
  inProgress: { key: 'inProgress', label: 'IN PROGRESS', color: '#f59e0b' }, // amber — building
  done: { key: 'done', label: 'DONE', color: '#22c55e' }, // green — complete
};

// Map a ticket's JIRA statusCategory to one of our three buckets. JIRA uses the category names
// "To Do" / "In Progress" / "Done" (and the key forms new/indeterminate/done); accept both.
export function ticketState(ticket) {
  const raw = String(ticket?.statusCategory || '').toLowerCase().trim();
  if (raw === 'done' || raw === 'complete') return 'done';
  if (raw === 'in progress' || raw === 'indeterminate') return 'inProgress';
  return 'todo'; // "to do" / "new" / unknown / blank
}

// Story-point-driven height so a chunky ticket reads as a taller structure; defaults to a 1-point
// floor when the ticket carries no estimate so every ticket is at least a visible crate.
export function structureHeight(storyPoints) {
  const pts = Number.isFinite(storyPoints) && storyPoints > 0 ? storyPoints : 1;
  return Math.min(JIRA_DISTRICT.maxHeight, 0.9 + Math.log2(1 + pts) * 1.1);
}

// Dedupe tickets across apps by key (the same JIRA ticket can surface under two apps that share a
// project) and sort into a stable render order: done → in-progress → to-do, then by key, so the
// yard reads left-to-right as "finished work piling up" with active work in the middle.
const STATE_ORDER = { done: 0, inProgress: 1, todo: 2 };
export function dedupeAndSort(tickets) {
  const byKey = new Map();
  for (const t of Array.isArray(tickets) ? tickets : []) {
    if (!t?.key || byKey.has(t.key)) continue;
    byKey.set(t.key, t);
  }
  return [...byKey.values()].sort((a, b) => {
    const sa = STATE_ORDER[ticketState(a)] ?? 3;
    const sb = STATE_ORDER[ticketState(b)] ?? 3;
    return sa - sb || String(a.key).localeCompare(String(b.key));
  });
}

// Grid position for the i-th structure in the yard: rows wrap toward -Z, centered on the base X.
export function structurePosition(index, opts = {}) {
  const base = opts.base || JIRA_DISTRICT.base;
  const columns = opts.columns ?? JIRA_DISTRICT.columns;
  const spacing = opts.spacing ?? JIRA_DISTRICT.spacing;
  const col = index % columns;
  const row = Math.floor(index / columns);
  const offsetX = ((columns - 1) * spacing) / 2;
  return [base[0] + col * spacing - offsetX, base[1], base[2] - row * spacing];
}

// Tally tickets by bucket — drives the district label ("3/8 DONE") and per-state counts.
export function tallyStates(tickets) {
  const counts = { todo: 0, inProgress: 0, done: 0 };
  for (const t of Array.isArray(tickets) ? tickets : []) counts[ticketState(t)] += 1;
  return counts;
}

// Full derived view-model for the component: positioned structures (capped, overflow summarized)
// + per-state tallies. `tickets` is the merged sprint-ticket list across all JIRA-enabled apps.
// Pure + deterministic — same tickets in, same yard out — so the whole thing is headless-testable.
export function computeJiraDistrict(tickets, opts = {}) {
  const sorted = dedupeAndSort(tickets);
  const counts = tallyStates(sorted);
  const total = sorted.length;
  const maxStructures = opts.maxStructures ?? JIRA_DISTRICT.maxStructures;

  const shown = sorted.slice(0, maxStructures);
  const structures = shown.map((t, i) => {
    const state = ticketState(t);
    return {
      key: t.key,
      summary: t.summary || t.key,
      state,
      color: SPRINT_STATES[state].color,
      height: structureHeight(t.storyPoints),
      position: structurePosition(i, opts),
      url: t.url || null,
    };
  });

  const overflow = total > maxStructures ? total - maxStructures : 0;

  return {
    base: opts.base || JIRA_DISTRICT.base,
    structures,
    counts,
    total,
    overflow,
    // Overflow marker sits just past the last rendered structure.
    overflowPosition: overflow > 0 ? structurePosition(maxStructures, opts) : null,
    empty: total === 0,
  };
}
