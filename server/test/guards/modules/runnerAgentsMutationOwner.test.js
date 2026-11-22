/**
 * Rule: `runnerAgents` is mutated only through `trackRunnerAgent` / `dropRunnerAgent`
 * in `server/services/agent/agentState.js` (#17342).
 * Why: an entry may carry the in-flight Ollama hold of a runner-hosted harness; a
 * bare `runnerAgents.delete` or overwriting `.set` leaks it, deferring every later
 * Ollama context reload until the drain timeout.
 * Fix: call `dropRunnerAgent(id)` / `trackRunnerAgent(id, entry)` instead.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');
const OWNER = 'services/agent/agentState.js';
const BARE_MUTATION = /\brunnerAgents\.(set|delete|clear)\(/;

describe('runnerAgents mutation owner (#17342)', () => {
  it('has no bare runnerAgents.set/delete/clear outside agentState.js', () => {
    const offenders = trackedFiles(SERVER_ROOT, ['*.js', '*.mjs'])
      .filter((file) => file && !file.includes('.test.') && file !== OWNER)
      .filter((file) => BARE_MUTATION.test(readText(join(SERVER_ROOT, file))));
    expect(offenders).toEqual([]);
  });

  it('still sees the owner module (control)', () => {
    expect(BARE_MUTATION.test(readText(join(SERVER_ROOT, OWNER)))).toBe(true);
  });
});
