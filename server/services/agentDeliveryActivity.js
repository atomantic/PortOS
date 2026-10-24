import { cosEvents } from './cosEvents.js';

// Process-local evidence: persisted "running" stages cannot prove liveness after a crash.
const activities = new Map();
export const COMPLETION_RECOVERY_BATCH_SIZE = 10;

export function getDeliveryActivity(agentId) {
  return activities.get(agentId)?.at(-1)?.activity || null;
}

export async function withDeliveryActivity(agentId, label, work) {
  const entry = { activity: { label, startedAt: new Date().toISOString() } };
  const entries = activities.get(agentId) || [];
  activities.set(agentId, entries);
  entries.push(entry);
  const publish = () => cosEvents.emit('agent:updated', { id: agentId, deliveryActivity: getDeliveryActivity(agentId) });
  try {
    publish();
    return await work();
  } finally {
    entries.splice(entries.indexOf(entry), 1);
    if (!entries.length) activities.delete(agentId);
    publish();
  }
}
