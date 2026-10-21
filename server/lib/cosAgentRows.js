/**
 * Row model for `cos_agents`: one row per CoS agent record in the runtime
 * working set (running agents plus finished ones not yet archived to
 * `data/cos/agents/<date>/`).
 *
 * The record is stored as its exact JSON text, so a read returns the same bytes
 * (key order included) that the caller wrote. `planAgentSave` turns "here is the
 * whole agents map" into "only these rows changed" by comparing each record's
 * serialization with the one last persisted, which is what keeps a status or
 * output update for one agent from rewriting every other agent.
 */

const timestamp = (value) => {
  const ms = typeof value === 'string' || typeof value === 'number' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** The projection columns the queries read, derived from one record. */
export function agentRowColumns(agent) {
  return {
    taskId: typeof agent?.taskId === 'string' ? agent.taskId : null,
    status: typeof agent?.status === 'string' ? agent.status : 'unknown',
    startedAt: timestamp(agent?.startedAt),
    completedAt: timestamp(agent?.completedAt),
    pid: Number.isSafeInteger(agent?.pid) && agent.pid > 0 && agent.pid <= 2_147_483_647 ? agent.pid : null,
  };
}

/**
 * Diff the next agents map against the persisted serializations.
 *
 * @param {{
 *   persisted: Map<string, string>,
 *   next: object,
 *   changedAgentIds?: Iterable<string> | string,
 *   serialize?: (agent: object) => string
 * }} input
 *   `persisted` maps agent id to the JSON text last stored for it.
 *   `changedAgentIds` is an optional hint of agent ids modified in memory.
 *   When provided, only those ids plus any added/removed keys are serialized.
 *   When omitted, all records are serialized to detect changes.
 * @returns {{ upserts: Array<{ id: string, body: string, agent: object }>, deletes: string[], persisted: Map<string, string> }}
 *   `persisted` is what the store holds once the plan is applied.
 */
export function planAgentSave({ persisted, next, changedAgentIds, serialize = JSON.stringify }) {
  const upserts = [];
  const after = new Map();
  const nextEntries = Object.entries(next ?? {});

  if (changedAgentIds == null) {
    for (const [id, agent] of nextEntries) {
      // An undefined entry is absent, exactly as JSON.stringify of the map drops it.
      if (agent === undefined) continue;
      const body = serialize(agent);
      after.set(id, body);
      if (persisted.get(id) !== body) upserts.push({ id, body, agent });
    }
    const deletes = [...persisted.keys()].filter((id) => !after.has(id));
    return { upserts, deletes, persisted: after };
  }

  const dirty = new Set(typeof changedAgentIds === 'string' ? [changedAgentIds] : changedAgentIds);
  for (const [id, agent] of nextEntries) {
    if (agent === undefined) continue;
    const isDirty = dirty.has(id);
    const isPersisted = persisted.has(id);
    if (isDirty || !isPersisted) {
      const body = serialize(agent);
      after.set(id, body);
      if (persisted.get(id) !== body) {
        upserts.push({ id, body, agent });
      }
    } else {
      after.set(id, persisted.get(id));
    }
  }

  const deletes = [...persisted.keys()].filter((id) => !after.has(id));
  return { upserts, deletes, persisted: after };
}
