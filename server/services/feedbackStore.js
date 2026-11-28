/** Digital Twin feedback persistence. Local edits, erasure and peer merges share the file queue and read cache. */
import { join } from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const feedbackFile = () => join(PATHS.digitalTwin, 'feedback.json');

let feedbackCache = null;

// Peer sync (digital-twin-sync) and local mutators share feedback.json; every
// read-modify-write runs in this queue against a fresh read so neither side
// overwrites the other from a stale cache.
export const queueFeedbackWrite = createFileWriteQueue();

function defaultFeedback() {
  return {
    version: '1.0.0',
    entries: [],
    stats: { totalFeedback: 0, soundsLikeMe: 0, doesntSoundLikeMe: 0 },
    documentWeightAdjustments: {},
    lastCalculatedAt: null
  };
}

// Strict: ENOENT yields the default, but an unreadable or malformed file throws
// so a mutator never replaces user feedback it failed to parse.
export async function readFeedbackFresh() {
  return (await readJSONFile(feedbackFile(), null, { strict: true })) ?? defaultFeedback();
}

export async function loadFeedback() {
  if (feedbackCache) return feedbackCache;
  const fresh = await readFeedbackFresh();
  // A queued write may have published a newer value while the read was in flight.
  return feedbackCache ??= fresh;
}

export async function saveFeedback(data) {
  await ensureDir(PATHS.digitalTwin, { mode: 0o700 });
  data.updatedAt = new Date().toISOString();
  await atomicWrite(feedbackFile(), data, { mode: 0o600, dirMode: 0o700 });
  feedbackCache = data;
}

/**
 * Apply a peer-sync merge to feedback.json inside the write queue. `mergeFn(local)`
 * returns `{ merged, changed }`; the cache is replaced with what was written.
 * Returns whether anything was written.
 */
export function applyFeedbackMerge(mergeFn, readLocal = path => readJSONFile(path, null, { strict: true })) {
  return queueFeedbackWrite(async () => {
    const local = await readLocal(feedbackFile());
    const { merged, changed } = mergeFn(local);
    if (!changed) return false;
    await ensureDir(PATHS.digitalTwin, { mode: 0o700 });
    await atomicWrite(feedbackFile(), merged, { mode: 0o600, dirMode: 0o700 });
    feedbackCache = merged;
    return true;
  });
}
