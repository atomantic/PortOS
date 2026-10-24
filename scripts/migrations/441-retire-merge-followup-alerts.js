/** Retire the human reminders formerly emitted for automated PR merge work. */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJSONFile } from '../../server/lib/jsonIo.js';
import { supersedingTimestamp } from '../../server/lib/tombstones.js';
import { writeJsonAtomic } from './_lib.js';

// Frozen producer signatures: do not retire unrelated or edited commitments.
const TITLE = 'PR left open: its merge follow-up was blocked';
const NEXT_ACTION = 'Check the linked PR. If it is still open, fix the blocker and re-run the task or merge it manually.';

export default {
  async up({ rootDir }) {
    const notificationPath = join(rootDir, 'data', 'notifications.json');
    const history = await readJSONFile(notificationPath, null, { strict: true });
    let notifications = 0;
    if (history !== null) {
      if (!Array.isArray(history.notifications)) throw new Error('Invalid notification history');
      for (const record of history.notifications) {
        if (record?.type !== 'agent_warning' || record.title !== TITLE
          || !record.metadata?.taskId || !record.metadata?.prUrl
          || (record.historyHidden === true && record.read === true)) continue;
        record.historyHidden = true;
        record.read = true;
        notifications++;
      }
      if (notifications) await writeJsonAtomic(notificationPath, history);
    }

    const threadsDir = join(rootDir, 'data', 'brain', 'threads');
    const entries = await readdir(threadsDir, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    let threads = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(threadsDir, entry.name, 'index.json');
      const record = await readJSONFile(path, null, { strict: true });
      if (!record || record._deleted || record.source !== 'cos' || record.title !== TITLE
        || record.nextAction !== NEXT_ACTION || ['done', 'archived'].includes(record.status)
        || !Array.isArray(record.refs) || record.refs.length !== 1
        || record.refs[0]?.kind !== 'cos.task' || !record.refs[0]?.id) continue;
      const timestamp = supersedingTimestamp(record.updatedAt);
      await writeJsonAtomic(path, {
        ...record, status: 'archived', closedAt: timestamp, updatedAt: timestamp,
      });
      threads++;
    }
    return { notifications, threads };
  },
};
