/**
 * Surface contract for the taskLearning.js barrel: every export of the leaf
 * modules it re-exports must stay reachable through it. Behavior suites live
 * beside each leaf (taskLearning/*.test.js).
 */
import { describe, it, expect } from 'vitest';
import * as taskLearning from './taskLearning.js';
import * as index from './taskLearning/index.js';

describe('taskLearning.js barrel surface', () => {
  it('re-exports every taskLearning/index.js export unchanged', () => {
    const exported = Object.keys(index);
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) expect(taskLearning[name], name).toBe(index[name]);
  });
});
