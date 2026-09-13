import { describe, it, expect } from 'vitest';
import { peerCosTasksSchema } from './peerSyncValidation.js';
import { TASK_STATUS_VALUES, TASK_PRIORITY_VALUES } from './taskParser.js';

// The wire vocabulary and the markdown store's vocabulary must be the same list.
// They were two hand-written copies, and a peer entry the receiver accepts but
// `generateTasksMarkdown` cannot represent is a task the receiver deletes on its
// very next file write — with no deletion to federate back, so no peer can
// restore it (#7239).
describe('peer CoS task wire vocabulary tracks the markdown store', () => {
  const payload = tasks => ({ schemaVersion: 1, listHash: 'a'.repeat(64), tasks });
  const entry = overrides => ({
    id: 'task-1', taskType: 'user', status: 'pending', priority: 'HIGH',
    description: 'x', metadata: {}, ...overrides,
  });

  it('accepts every status the store can represent, and nothing else', () => {
    for (const status of TASK_STATUS_VALUES) {
      expect(peerCosTasksSchema.safeParse(payload([entry({ status })])).success).toBe(true);
    }
    expect(peerCosTasksSchema.safeParse(payload([entry({ status: 'archived' })])).success).toBe(false);
  });

  it('accepts every priority the store can represent, and nothing else', () => {
    for (const priority of TASK_PRIORITY_VALUES) {
      expect(peerCosTasksSchema.safeParse(payload([entry({ priority })])).success).toBe(true);
    }
    expect(peerCosTasksSchema.safeParse(payload([entry({ priority: 'URGENT' })])).success).toBe(false);
  });
});
