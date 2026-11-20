import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AUDIT_TASK_TYPE_LIST, AUDIT_EXECUTION_PROFILES } from './auditCatalog.js';

const DOC = new URL('../../docs/features/self-improvement-audits.md', import.meta.url);

const [activeSection, legacySection] = readFileSync(DOC, 'utf8').split('## Legacy task profiles');
const parseRows = section => section
  .split('\n')
  .map((line) => line.match(/^\| `([a-z-]+)` \|.*\| ((?:`[^`]+`(?:, )?)+) \| \w+ \|/))
  .filter(Boolean)
  .map(([, taskType, labels]) => ({
    taskType,
    labels: [...labels.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
  }));

describe('self-improvement-audits.md lane table', () => {
  it('has exactly one row per catalog lane', () => {
    const active = parseRows(activeSection).map(r => r.taskType);
    expect(active.sort()).toEqual([...AUDIT_TASK_TYPE_LIST].sort());
    const types = [...active, ...parseRows(legacySection).map(r => r.taskType)];
    expect(new Set(types).size).toBe(types.length);
    expect([...types].sort()).toEqual(Object.keys(AUDIT_EXECUTION_PROFILES).sort());
  });

  it('documents the labels each lane files under', () => {
    for (const { taskType, labels } of [...parseRows(activeSection), ...parseRows(legacySection)]) {
      const { issueLabel, extraLabels } = AUDIT_EXECUTION_PROFILES[taskType].filing;
      expect(labels, taskType).toEqual([issueLabel, ...extraLabels]);
    }
  });
});
