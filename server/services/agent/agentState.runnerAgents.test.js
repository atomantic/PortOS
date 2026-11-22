/**
 * `runnerAgents` entries may carry the in-flight Ollama hold of a runner-hosted
 * harness (#17342). These pin the two helpers that own the map's mutations, and
 * a source guard that keeps every other module going through them: one bare
 * `runnerAgents.delete` leaks the hold, deferring every later context reload to
 * the drain timeout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dropRunnerAgent, runnerAgents, trackRunnerAgent } from './agentState.js';

afterEach(() => runnerAgents.clear());

describe('runner-agent tracking helpers', () => {
  it('dropRunnerAgent removes the entry and releases its hold exactly once', () => {
    const releaseOllamaWork = vi.fn();
    trackRunnerAgent('agent-1', { taskId: 'task-1', releaseOllamaWork });
    expect(dropRunnerAgent('agent-1')).toBe(true);
    expect(dropRunnerAgent('agent-1')).toBe(false);
    expect(runnerAgents.has('agent-1')).toBe(false);
    expect(releaseOllamaWork).toHaveBeenCalledTimes(1);
  });

  it('trackRunnerAgent releases the hold of an entry it replaces', () => {
    const first = vi.fn();
    const second = vi.fn();
    trackRunnerAgent('agent-1', { releaseOllamaWork: first });
    trackRunnerAgent('agent-1', { releaseOllamaWork: second });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('a throwing release still drops the entry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    trackRunnerAgent('agent-1', { releaseOllamaWork: () => { throw new Error('boom'); } });
    expect(() => dropRunnerAgent('agent-1')).not.toThrow();
    expect(runnerAgents.has('agent-1')).toBe(false);
  });
});

describe('runnerAgents is mutated only through the tracking helpers', () => {
  const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

  it('has no bare runnerAgents.set/delete/clear outside agentState.js', () => {
    const offenders = ['services', 'lib', 'routes'].flatMap((dir) => walk(join(serverRoot, dir)))
      .filter((path) => path.endsWith('.js') && !path.endsWith('.test.js') && !path.endsWith('agentState.js'))
      .filter((path) => /\brunnerAgents\.(set|delete|clear)\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(serverRoot, path));
    expect(offenders).toEqual([]);
  });
});
