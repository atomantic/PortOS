import { describe, it, expect } from 'vitest';
import { QUOTA_BURN_PROMPT_PRESETS } from './quotaBurnPresets.js';
import {
  AUDIT_DEFINITIONS,
  AUDIT_TASK_TYPES,
  FILE_ISSUES_MODE_CONTRACT,
  DO_WORK_MODE_CONTRACT,
  isAuditTaskType,
  defaultFileIssuesFor,
  isFileIssuesMode,
  getAuditFilingPreset,
  modeContractFor,
  applyAuditModeWrapper,
} from './auditCatalog.js';

describe('AUDIT_DEFINITIONS', () => {
  it('has a filing preset (slug + label) for every audit type', () => {
    for (const [taskType, def] of Object.entries(AUDIT_DEFINITIONS)) {
      expect(def.filing, taskType).toBeTruthy();
      expect(def.filing.slugPrefix, taskType).toMatch(/-$/);
      expect(def.filing.issueLabel, taskType).toBeTruthy();
      expect(def.filing.planCommitMessage, taskType).toContain('propose');
    }
  });

  it('maps every quota-burn audit preset to a scheduled audit type', () => {
    const mapped = new Set(
      Object.values(AUDIT_DEFINITIONS).map((def) => def.quotaBurnId).filter(Boolean)
    );
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      expect(mapped.has(preset.id), `missing scheduled counterpart for ${preset.id}`).toBe(true);
    }
  });

  it('defaults new audit types to file-issues and existing do-work types to implement', () => {
    expect(defaultFileIssuesFor('ux')).toBe(true);
    expect(defaultFileIssuesFor('data-safety')).toBe(true);
    expect(defaultFileIssuesFor('simplify')).toBe(true);
    expect(defaultFileIssuesFor('security')).toBe(false);
    expect(defaultFileIssuesFor('accessibility')).toBe(false);
    expect(defaultFileIssuesFor('unknown')).toBe(false);
  });
});

describe('isFileIssuesMode', () => {
  it('is false for non-audit types', () => {
    expect(isFileIssuesMode('claim-issue', { fileIssues: true })).toBe(false);
    expect(isAuditTaskType('claim-issue')).toBe(false);
  });

  it('honors an explicit boolean (and the TASKS.md string form)', () => {
    expect(isFileIssuesMode('security', { fileIssues: true })).toBe(true);
    expect(isFileIssuesMode('security', { fileIssues: 'true' })).toBe(true);
    expect(isFileIssuesMode('ux', { fileIssues: false })).toBe(false);
    expect(isFileIssuesMode('ux', { fileIssues: 'false' })).toBe(false);
  });

  it('falls back to the catalog default when the key is absent', () => {
    expect(isFileIssuesMode('ux', {})).toBe(true);
    expect(isFileIssuesMode('security', {})).toBe(false);
    expect(isFileIssuesMode('data-safety', null)).toBe(true);
  });
});

describe('mode contracts + wrapper', () => {
  it('file-issues contract records findings via {trackerInstructions} and forbids edits', () => {
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('{trackerInstructions}');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('OVERRIDES');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('same `git status`');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('CI or release failure');
    expect(FILE_ISSUES_MODE_CONTRACT).toContain('recurring manual churn');
    expect(modeContractFor(true)).toBe(FILE_ISSUES_MODE_CONTRACT);
  });

  it('do-work contract tells the agent to implement one fix', () => {
    expect(DO_WORK_MODE_CONTRACT).toContain('implement');
    expect(DO_WORK_MODE_CONTRACT).not.toContain('{trackerInstructions}');
    expect(modeContractFor(false)).toBe(DO_WORK_MODE_CONTRACT);
  });

  it('prepends the banner when the stored prompt has no placeholder', () => {
    const wrapped = applyAuditModeWrapper('Fix the bug and commit.', FILE_ISSUES_MODE_CONTRACT);
    expect(wrapped.startsWith(FILE_ISSUES_MODE_CONTRACT)).toBe(true);
    expect(wrapped).toContain('Fix the bug and commit.');
  });

  it('leaves a prompt that already has {modeInstructions} untouched', () => {
    const prompt = 'Mission\n\n{modeInstructions}';
    expect(applyAuditModeWrapper(prompt, FILE_ISSUES_MODE_CONTRACT)).toBe(prompt);
  });

  it('is a no-op without a mode banner', () => {
    expect(applyAuditModeWrapper('hello', '')).toBe('hello');
    expect(applyAuditModeWrapper('hello', null)).toBe('hello');
  });
});

describe('getAuditFilingPreset', () => {
  it('returns the preset for an audit type and null otherwise', () => {
    expect(getAuditFilingPreset('data-safety').slugPrefix).toBe('data-safety-');
    expect(getAuditFilingPreset('simplify').issueLabel).toBe('code-quality');
    expect(getAuditFilingPreset('claim-issue')).toBeNull();
  });

  it('AUDIT_TASK_TYPES is derived from the definitions table', () => {
    expect(AUDIT_TASK_TYPES).toEqual(new Set(Object.keys(AUDIT_DEFINITIONS)));
  });
});
