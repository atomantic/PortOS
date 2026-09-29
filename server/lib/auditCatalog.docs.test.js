import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AUDIT_TASK_TYPE_LIST, AUDIT_DEFINITIONS } from './auditCatalog.js';

const DOC = new URL('../../docs/features/self-improvement-audits.md', import.meta.url);

const parseRows = () => readFileSync(DOC, 'utf8')
  .split('\n')
  .map((line) => line.match(/^\| `([a-z-]+)` \|.*\| ((?:`[^`]+`(?:, )?)+) \| \w+ \|/))
  .filter(Boolean)
  .map(([, taskType, labels]) => ({
    taskType,
    labels: [...labels.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
  }));

describe('self-improvement-audits.md lane table', () => {
  it('has exactly one row per catalog lane', () => {
    const types = parseRows().map((r) => r.taskType);
    expect(new Set(types).size).toBe(types.length);
    expect([...types].sort()).toEqual([...AUDIT_TASK_TYPE_LIST].sort());
  });

  it('documents the labels each lane files under', () => {
    for (const { taskType, labels } of parseRows()) {
      const { issueLabel, extraLabels } = AUDIT_DEFINITIONS[taskType].filing;
      expect(labels, taskType).toEqual([issueLabel, ...extraLabels]);
    }
  });
});
