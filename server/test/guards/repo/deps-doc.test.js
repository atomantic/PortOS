/**
 * Check that the Quick Reference justifies each dependency in the workspace
 * and manifest group that declares it. Versions stay in the manifests.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverWorkspaces, workspaceDir } from '../../../../scripts/trusted-rebuilds.js';
import { readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

const DOC = readText(join(REPO_ROOT, 'docs/DEPS.md'));
const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const WORKSPACES = discoverWorkspaces();
const DECLARED = new Set();
for (const workspace of WORKSPACES) {
  const pkg = JSON.parse(readText(join(workspaceDir(workspace), 'package.json')));
  for (const group of GROUPS) {
    for (const name of Object.keys(pkg[group] ?? {})) {
      DECLARED.add(`${workspace} ${group}: ${name}`);
    }
  }
}

function quickReferenceRows(markdown) {
  const section = markdown.split('## Quick Reference Table\n')[1]?.split('\n## ')[0] ?? '';
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
  const documented = quickReferenceRows(DOC);

  it('documents every direct dependency under the workspace and manifest group that declares it', () => {
    expect([...DECLARED].filter(entry => !documented.includes(entry))).toEqual([]);
  });

  it('has one current row per declaration, with historical removals allowed', () => {
    expect(documented.filter(entry => !DECLARED.has(entry))).toEqual([]);
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('includes the install workspaces and their current declarations as dependencies are retired', () => {
    expect(WORKSPACES).toEqual(expect.arrayContaining(['root', 'client', 'server', 'browser']));
    expect(DECLARED.size).toBeGreaterThan(0);
    expect(documented.length).toBe(DECLARED.size);
  });

  it('counts active rows in the right scope and excludes historical removals', () => {
    const sample = [
      '## Quick Reference Table',
      '| **Client dependencies** | | | | |',
      '| `legacy` | 1 | REPLACED | | |',
      '| `old` | 2 | REMOVED (direct) | | |',
      '| `current` | 1 | KEEP | | |',
      '| **Server devDependencies** | | | | |',
      '| `current` | 1 | KEEP | | |',
    ].join('\n');
    expect(quickReferenceRows(sample)).toEqual(['client dependencies: current', 'server devDependencies: current']);
  });
});
