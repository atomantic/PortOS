import { createMutex } from '../lib/asyncMutex.js';
import { listReviewQueueTriage, upsertReviewQueueTriage, triageIdentityKey } from './reviewQueueTriageStore.js';

const withDelivery = createMutex();
const SEVERITY = { low: 0, normal: 1, medium: 1, high: 2, critical: 3 };

// Read state and source text revisions are not new delivery occurrences.
const deliveryIdentity = (item) => ({
  actionKey: `delivery:${item.id}`,
  occurrence: item.occurrence ?? '',
  revision: '',
});

/** Claim before interrupting. A lost client response can suppress a nudge,
 * but a second tab/reload cannot interrupt twice for the same generation. */
export function claimActionDelivery(item, channel) {
  return withDelivery(async () => {
    const identity = deliveryIdentity(item);
    const key = triageIdentityKey(identity);
    const entries = await listReviewQueueTriage();
    const previous = entries.find((entry) => triageIdentityKey(entry) === key);
    const severity = SEVERITY[item.severity] ?? 1;
    const escalated = previous?.delivery && severity > previous.delivery.severity;
    const generation = (previous?.deliveryGeneration ?? 0) + (escalated ? 1 : 0);
    if (previous?.delivery?.channels?.[channel] === generation) return { claimed: false, generation };
    await upsertReviewQueueTriage({
      ...identity,
      deliveryGeneration: generation,
      delivery: {
        severity: Math.max(severity, previous?.delivery?.severity ?? 0),
        channels: { ...previous?.delivery?.channels, [channel]: generation },
      },
    });
    return { claimed: true, generation };
  });
}

/** Callers cannot grant themselves reminder consent or a new occurrence. */
export async function claimQueueDelivery(id, channel = 'toast', occurrence) {
  const { buildQueue } = await import('./reviewQueue.js');
  const queue = await buildQueue({ query: { view: 'today' } });
  const item = queue.items.find((candidate) => candidate.id === id);
  if (!item) return { claimed: false };
  if (occurrence !== undefined && item.occurrence !== occurrence) return { claimed: false };
  if (channel === 'toast') {
    const { getPostConfig } = await import('./meatspacePost.js');
    if (id !== 'product:daily-post' || !(await getPostConfig()).reminder?.enabled) return { claimed: false };
    const { getNotifications } = await import('./notifications.js');
    const notices = await getNotifications();
    if (item.source !== 'product' || !notices.some((notice) =>
      notice.metadata?.actionId === id && notice.metadata?.occurrence === item.occurrence
      && notice.type === 'daily_post_reminder')) return { claimed: false };
  }
  return claimActionDelivery(item, channel);
}
