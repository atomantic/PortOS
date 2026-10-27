import { AsyncLocalStorage } from 'node:async_hooks';

const lifetime = new AsyncLocalStorage();

export const currentGitMutationLifetime = () => lifetime.getStore();

/** Admission outlives every admitted command, including failed siblings. */
export const withGitMutationLifetime = (work, onUncertain) => {
  const owner = { onUncertain, pending: new Set(), closed: false };
  return lifetime.run(owner, async () => {
    try { return await work(); }
    finally {
      while (owner.pending.size) await Promise.allSettled([...owner.pending]);
      owner.closed = true;
    }
  });
};

/** Completion outlives spawn's Git operation. Retain every other caller
 * context; cleanup mutations still acquire their own checkout admission. */
export const outsideGitMutationLifetime = work => lifetime.exit(work);
