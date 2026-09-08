import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

import { CLAIM_FLOW_TASK_TYPES } from './claimFlowTaskTypes.js';
import { isClaimFlowTask } from '../services/agentPromptBuilder.js';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(LIB_DIR, '..');
const OWNING_MODULE = join(LIB_DIR, 'claimFlowTaskTypes.js');

// A LOCAL binding of the name — `const`/`let`/`var CLAIM_FLOW_TASK_TYPES = …`.
// An `import { CLAIM_FLOW_TASK_TYPES } from …` line binds the same name but is
// exactly what this issue asks for, so it must NOT match (probed below).
const LOCAL_DECLARATION = /(?:^|[;{}\n])\s*(?:const|let|var)\s+CLAIM_FLOW_TASK_TYPES\s*=/;

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);

function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else if (/\.(js|mjs|jsx)$/.test(entry) && !full.endsWith('.test.js')) out.push(full);
  }
  return out;
}

describe('CLAIM_FLOW_TASK_TYPES is declared exactly once', () => {
  it('detects a re-declaration and ignores an import of the same name', () => {
    // Bypass probe: without this, a detector that silently matched nothing
    // would pass every assertion below while guarding nothing.
    expect(LOCAL_DECLARATION.test("const CLAIM_FLOW_TASK_TYPES = new Set(['plan-task']);")).toBe(true);
    expect(LOCAL_DECLARATION.test('import foo from "x";\nlet CLAIM_FLOW_TASK_TYPES = [];')).toBe(true);
    expect(LOCAL_DECLARATION.test("import { CLAIM_FLOW_TASK_TYPES } from '../lib/claimFlowTaskTypes.js';")).toBe(false);
  });

  it('has no second declaration anywhere under server/', () => {
    const offenders = collectSourceFiles(SERVER_DIR)
      .filter(file => file !== OWNING_MODULE)
      .filter(file => LOCAL_DECLARATION.test(readFileSync(file, 'utf8')))
      .map(file => relative(SERVER_DIR, file));
    expect(offenders).toEqual([]);
  });

  it.each([
    ['services/agentPromptBuilder.js', 'reads the set back via isClaimFlowTask()'],
    ['services/cosTaskGenerator.js', 'stamps metadata.claimFlow from the set'],
  ])('%s imports the shared set (%s)', (relPath) => {
    const source = readFileSync(join(SERVER_DIR, relPath), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\bCLAIM_FLOW_TASK_TYPES\b[^}]*\}\s*from\s*'\.\.\/lib\/claimFlowTaskTypes\.js'/);
    expect(LOCAL_DECLARATION.test(source)).toBe(false);
  });
});

describe('the shared set drives the read side', () => {
  it('lists the claim-owned task kinds', () => {
    expect([...CLAIM_FLOW_TASK_TYPES].sort()).toEqual(
      ['claim-issue', 'claim-issue-gitlab', 'claim-issue-jira', 'claim-work', 'plan-task']
    );
  });

  it('treats every member as a claim-flow run via its legacy analysisType', () => {
    for (const analysisType of CLAIM_FLOW_TASK_TYPES) {
      expect(isClaimFlowTask({ metadata: { analysisType } })).toBe(true);
    }
    expect(isClaimFlowTask({ metadata: { analysisType: 'ux' } })).toBe(false);
  });
});
