import { useSocketResource } from './useSocketResource';

const IMAGE_EVENTS = ['image-to-3d:changed'];
const THREEJS_EVENTS = ['threejs-model:changed'];

/** One routed/generated model, with bounded recovery for a lost final read. */
export function useModelLifecycle(id, readModel, { procedural = false } = {}) {
  return useSocketResource(async ({ signal }) => {
    if (!id) return null;
    const read = () => readModel(id, { silent: true, signal }).catch(error => {
      if (error?.status === 404) return null;
      throw error;
    });
    // Retry a transient failure once; future events/reconnect/tab-show can
    // recover a longer outage. Never turn a missing record into a retry loop.
    return read().catch(error => {
      if (signal.aborted || (error?.status && error.status < 500)) throw error;
      return read();
    });
  }, {
    resourceKey: id,
    events: procedural ? THREEJS_EVENTS : IMAGE_EVENTS,
    matchesEvent: payload => !!id && payload?.id === id,
    requestTimeoutMs: 30_000,
  });
}
