/**
 * Dismiss pending Review Hub items from the retired `task:ready` bridge.
 *
 * The old bridge created a `type: 'cos'` review item for every task ready to
 * spawn, including tasks whose description began with the generated SWARM MODE
 * prompt. That bridge no longer exists; the live CoS approval producer is the
 * authoritative source now. Existing bridge records otherwise remain visible
 * as "Stored review obligations" and can offer an approve action for work that
 * is not actually awaiting approval.
 *
 * Match the old record shape rather than every `type: 'cos'` item so a future
 * producer can keep using the review store without being swept up by this
 * compatibility cleanup. Dismiss instead of deleting so the old records stay
 * auditable while disappearing from pending action projections.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';

const ITEMS_REL = join('data', 'review', 'items.json');

const hasReference = (value) => (
  (typeof value === 'string' && value.trim().length > 0)
  || (typeof value === 'number' && Number.isFinite(value))
);

export const isRetiredCosReviewAlert = (item) => {
  const metadata = item?.metadata;
  return item?.type === 'cos'
    && item?.status === 'pending'
    && metadata
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    && hasReference(metadata.taskId)
    && hasReference(metadata.referenceId)
    && metadata.category == null
    && metadata.actionKind == null
    && metadata.sourceOwned !== true;
};

export default {
  async up({ rootDir }) {
    const path = join(rootDir, ITEMS_REL);
    const raw = await readFile(path, 'utf-8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { dismissed: 0, reason: 'no-file' };

    let items;
    try {
      items = JSON.parse(raw);
    } catch {
      console.warn('⚠️ Review alerts: items file is not valid JSON — skipping retired CoS cleanup');
      return { dismissed: 0, reason: 'unparseable' };
    }
    if (!Array.isArray(items)) {
      console.warn('⚠️ Review alerts: items file is not an array — skipping retired CoS cleanup');
      return { dismissed: 0, reason: 'unexpected-shape' };
    }

    const now = new Date().toISOString();
    let dismissed = 0;
    const next = items.map((item) => {
      if (!isRetiredCosReviewAlert(item)) return item;
      dismissed++;
      return { ...item, status: 'dismissed', updatedAt: now };
    });

    if (dismissed === 0) return { dismissed: 0 };

    await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`🧹 Review alerts: dismissed ${dismissed} retired CoS alert(s)`);
    return { dismissed };
  },
};
