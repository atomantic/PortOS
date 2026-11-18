import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { runAgentContextEval } from './agentContextEval.js';

const fixturePath = fileURLToPath(new URL('../../test/fixtures/agent-context-eval.json', import.meta.url));
const loadSuite = async () => JSON.parse(await readFile(fixturePath, 'utf8'));

describe('agentContextEval', () => {
  it('runs the fixture-backed public contract without live data or LLM access', async () => {
    const report = await runAgentContextEval(await loadSuite());

    expect(report).toMatchObject({
      kind: 'portos-agent-context-eval',
      reportVersion: 1,
      suite: 'agent-context-public-contract',
      failureThreshold: 0,
      passed: true,
      counts: { pass: 10, fail: 0, error: 0, skip: 1 },
    });
    expect(report.cases).toHaveLength(11);
    expect(report.cases.every((result) => result.source && result.tool)).toBe(true);
    expect(report.cases.find((result) => result.id === 'stale-source-signaling')).toMatchObject({ status: 'pass' });
    expect(report.cases.find((result) => result.id === 'localized-profile')).toMatchObject({ status: 'skip' });
  });

  it('applies the configurable failure threshold to fail and error results', async () => {
    const suite = await loadSuite();
    suite.cases[0].expect.equals[0].value = 999;

    const strict = await runAgentContextEval(suite);
    const tolerant = await runAgentContextEval(suite, { failureThreshold: 1 });

    expect(strict).toMatchObject({ passed: false, counts: { fail: 1, error: 0 } });
    expect(tolerant).toMatchObject({ passed: true, failureThreshold: 1, counts: { fail: 1, error: 0 } });
  });
});
