import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cosWorkerBudget, DEFAULT_MAX_CONCURRENT_AGENTS, readMaxConcurrentAgents } from './cosWorkerBudget.js';

describe('cosWorkerBudget', () => {
  it('divides the cores between concurrent agents and never exceeds the proven cap', () => {
    expect(cosWorkerBudget({ cpus: 18, agents: 3 })).toBe(4);
    expect(cosWorkerBudget({ cpus: 18, agents: 6 })).toBe(3);
    expect(cosWorkerBudget({ cpus: 8, agents: 8, maxWorkers: 2 })).toBe(1);
    expect(cosWorkerBudget({ cpus: 2, agents: 10 })).toBe(1);
  });
});

describe('readMaxConcurrentAgents', () => {
  const roots = [];
  const rootWith = (config) => {
    const root = mkdtempSync(join(tmpdir(), 'cos-budget-'));
    roots.push(root);
    mkdirSync(join(root, 'data', 'cos'), { recursive: true });
    if (config !== undefined) writeFileSync(join(root, 'data', 'cos', 'config.json'), config);
    return root;
  };
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

  it('reads the CoS setting and falls back to the default when absent, corrupt or invalid', () => {
    expect(readMaxConcurrentAgents(rootWith('{"maxConcurrentAgents":5}'))).toBe(5);
    expect(readMaxConcurrentAgents(rootWith())).toBe(DEFAULT_MAX_CONCURRENT_AGENTS);
    expect(readMaxConcurrentAgents(rootWith('{not json'))).toBe(DEFAULT_MAX_CONCURRENT_AGENTS);
    expect(readMaxConcurrentAgents(rootWith('{"maxConcurrentAgents":0}'))).toBe(DEFAULT_MAX_CONCURRENT_AGENTS);
  });
});
