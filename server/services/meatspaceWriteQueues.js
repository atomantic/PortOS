/**
 * Write queues shared between the local MeatSpace writers and the federation
 * snapshot apply (`dataSync.js#applyMeatspaceRemote`).
 *
 * A sync apply is a read -> merge -> atomicWrite cycle on the same file a local
 * add/edit is rewriting, so both sides must run on the SAME queue or a peer
 * snapshot can overwrite a record added between the apply's read and write
 * (and vice versa). The queues live in their own leaf module so dataSync does
 * not have to import the full meatspace / meatspaceHealth service graphs just
 * to reach them. The daily log's queue lives with its store
 * (`queueDailyLogWrite` in `meatspaceDailyLog.js`).
 */

import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

/** Serializes every read-modify-write of `meatspace/config.json`. */
export const queueConfigWrite = createFileWriteQueue();

/**
 * Serializes read-modify-write of `blood-tests.json`, `epigenetic-tests.json`
 * and `eyes.json`. One shared tail (not one per file): the three are tiny and
 * rarely written, so the simpler single queue costs nothing.
 */
export const queueHealthWrite = createFileWriteQueue();
