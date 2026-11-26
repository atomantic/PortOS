// The first adjustment saves immediately. While it is in flight, only the
// latest value of each timing field needs to reach disk. The workspace owns
// the queue, so stepping to another shot does not drop a pending adjustment.
const FIELDS = new Set(['speedFps', 'offsetFrames']);
export const isClipTimingPatch = (patch) => {
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((key) => FIELDS.has(key));
};

export function createClipTimingWrites() {
  const shots = new Map();

  const drain = async (sceneId, queue) => {
    while (queue.next) {
      const { patch, persist, finish } = queue.next;
      queue.next = null;
      finish(await persist(sceneId, patch));
    }
    shots.delete(sceneId);
  };

  return {
    enqueue(sceneId, patch, persist) {
      const active = shots.get(sceneId);
      if (active?.next) {
        Object.assign(active.next.patch, patch);
        return active.next.done;
      }
      let finish;
      const done = new Promise((resolve) => { finish = resolve; });
      const next = { patch: { ...patch }, persist, done, finish };
      if (active) {
        active.next = next;
      } else {
        const queue = { next };
        shots.set(sceneId, queue);
        queue.tail = drain(sceneId, queue);
      }
      return done;
    },
    hasNewerField: (sceneId, field) => Object.hasOwn(shots.get(sceneId)?.next?.patch || {}, field),
    settled: () => shots.size ? Promise.all([...shots.values()].map((queue) => queue.tail)) : undefined,
  };
}
