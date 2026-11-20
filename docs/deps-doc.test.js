/**
 * Check that the Quick Reference justifies each dependency in the workspace
 * and manifest group that declares it. Versions stay in the manifests.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverWorkspaces, workspaceDir } from '../scripts/trusted-rebuilds.js';

const DOC = readFileSync(new URL('./DEPS.md', import.meta.url), 'utf8');
const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const WORKSPACES = discoverWorkspaces();
const DECLARED = new Set();
for (const workspace of WORKSPACES) {
  const pkg = JSON.parse(readFileSync(join(workspaceDir(workspace), 'package.json'), 'utf8'));
  for (const group of GROUPS) {
    for (const name of Object.keys(pkg[group] ?? {})) {
      DECLARED.add(`${workspace} ${group}: ${name}`);
    }
  }
}

function quickReferenceRows() {
  const section = DOC.split('## Quick Reference Table\n')[1]?.split('\n## ')[0] ?? '';
  const rows = [];
  let scope = '';
  for (const line of section.split('\n')) {
    const [, cell, , verdict] = line.split('|').map(part => part.trim());
    const heading = /^\*\*(\S+) (\w+)\*\*$/.exec(cell ?? '');
    if (heading) scope = `${heading[1].toLowerCase()} ${heading[2]}`;
    const name = /`([^`]+)`/.exec(cell ?? '')?.[1];
    if (name && !/^(REMOVED|REPLACED)\b/.test(verdict ?? '')) rows.push(`${scope}: ${name}`);
  }
  return rows;
}

describe('docs/DEPS.md', () => {
  const documented = quickReferenceRows();

  it('documents every direct dependency under the workspace and manifest group that declares it', () => {
    expect([...DECLARED].filter(entry => !documented.includes(entry))).toEqual([]);
  });

  it('has one current row per declaration, with historical removals allowed', () => {
    expect(documented.filter(entry => !DECLARED.has(entry))).toEqual([]);
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('scans a non-empty set of manifests and table rows', () => {
    expect(WORKSPACES.length).toBeGreaterThanOrEqual(4);
    expect(documented.length).toBeGreaterThanOrEqual(40);
  });
});
