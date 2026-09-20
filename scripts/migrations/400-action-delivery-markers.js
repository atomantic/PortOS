/**
 * Additive history visibility for notification-backed obligations. Source
 * records remain in the same local store; existing read state is preserved.
 * PostgreSQL's idempotent schema upgrade adds review_queue_triage.delivery.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../server/lib/fileUtils.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data/notifications.json');
    const raw = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return;
    const document = JSON.parse(raw);
    if (!Array.isArray(document.notifications)) throw new Error('Invalid notification history');
    let changed = false;
    for (const record of document.notifications) {
      if (record && typeof record === 'object' && record.historyHidden === undefined) {
        record.historyHidden = false;
        changed = true;
      }
    }
    if (changed) await atomicWrite(path, document);
  },
};
