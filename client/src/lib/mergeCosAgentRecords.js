/** Overlays a CoS agent update while retaining release metadata omitted by partial snapshots and socket events. */
export function mergeAgentRecords(base, update) {
  if (!base) return update;
  if (!update) return base;
  return {
    ...base,
    ...update,
    metadata: {
      ...base.metadata,
      ...update.metadata,
      ...(base.metadata?.releasePublication && !update.metadata?.releasePublication
        ? { releasePublication: base.metadata.releasePublication }
        : {}),
      ...(base.metadata?.releaseSynchronization && !update.metadata?.releaseSynchronization
        ? { releaseSynchronization: base.metadata.releaseSynchronization }
        : {}),
    },
  };
}
