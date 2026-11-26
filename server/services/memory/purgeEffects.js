/** Remove local approval state and notify observers after a PostgreSQL memory purge commits. */
import { decrementAgentPendingApproval } from '../memoryConfig.js';
import { removeByMetadata } from '../notifications.js';
import { cosEvents } from '../cos/cosEvents.js';

export async function finishMemoryPurge(id, removed) {
  if (removed?.status === 'pending_approval') await decrementAgentPendingApproval(removed.source_agent_id);
  const { removeMemoryApprovalItems } = await import('../review.js');
  await removeMemoryApprovalItems(id);
  await removeByMetadata('memoryId', id);

  console.log(`🧠 Memory purged: ${id}`);
  cosEvents.emit('memory:deleted', { id, hard: true });
}
