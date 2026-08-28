import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

// These files have writers in both autobiography.js and digital-twin-sync.js.
// Sharing the tails keeps every read-modify-write cycle ordered across services.
export const queueAutobiographyStoriesWrite = createFileWriteQueue();
export const queueAutobiographyConfigWrite = createFileWriteQueue();
