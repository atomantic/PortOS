import { randomUUID } from 'node:crypto';

/** Track per-job cancellation until a provider installs its render handle. */
export function createMediaJobPreparation() {
  const preparing = new Map();
  return {
    async run(params, generate) {
      const jobId = params.jobId || randomUUID();
      const entry = { aborted: false };
      preparing.set(jobId, entry);
      try {
        return await generate({ ...params, jobId });
      } finally {
        if (preparing.get(jobId) === entry) preparing.delete(jobId);
      }
    },
    cancel(jobId) {
      const entry = preparing.get(jobId);
      if (!entry) return false;
      entry.aborted = true;
      return 'pending';
    },
    // Called synchronously at the spawn/submit handoff; no await may separate
    // this gate from installing the provider's active handle.
    take(jobId) {
      const entry = preparing.get(jobId);
      preparing.delete(jobId);
      return entry?.aborted === true;
    },
    ids: () => [...preparing.keys()],
  };
}
