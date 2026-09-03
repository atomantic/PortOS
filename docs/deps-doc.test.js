/**
 * Parity guard for docs/DEPS.md.
 *
 * DEPS.md calls itself a "living reference of every third-party dependency in
 * PortOS" and is the artifact a reviewer consults to answer "why is this package
 * here, and is it still justified?". Nothing enforced that claim, and it drifted:
 * `playwright-core` landed as a server runtime dependency 27 days after the
 * document's stated last-audit date and had no row at all, so the newest
 * dependency in the tree was the one with no recorded justification.
 *
 * These assertions move that failure from "the next audit, months later" to the
 * commit that introduces it. They deliberately check *names*, not versions —
 * DEPS.md carries no version for most rows, and asserting on the few that do
 * would turn every Dependabot bump into a doc-edit chore.
 *
 * The test is colocated with the document it guards; `server/vitest.config.js`
 * globs `../docs/**` so `cd server && npm test` picks it up.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { discoverWorkspaces, workspaceDir } from '../scripts/trusted-rebuilds.js';

const DOC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'DEPS.md'), 'utf8');

/**
 * Every direct dependency name in every workspace manifest, mapped to the
 * workspaces declaring it. Workspaces are discovered rather than hardcoded
 * (`discoverWorkspaces()` is the repo's existing single source for "what is a
 * workspace"), so a fifth workspace is covered without editing a list here.
 *
 * `optionalDependencies` counts too — an optional package is still installed
 * third-party code with a supply-chain surface. `peerDependencies` does not: a
 * peer is declared for a consumer to install, and no PortOS workspace is a
 * published library.
 *
 * Manifests are read and JSON-parsed as files rather than resolved as modules:
 * CI never installs root `node_modules`, so anything reached through an
 * installed package would be green locally and red in CI.
 */
const WORKSPACES = discoverWorkspaces();
const DECLARED = new Map();
for (const label of WORKSPACES) {
  const pkg = JSON.parse(readFileSync(join(workspaceDir(label), 'package.json'), 'utf8'));
  const declared = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies];
  for (const name of declared.flatMap((group) => Object.keys(group ?? {}))) {
    DECLARED.set(name, [...(DECLARED.get(name) ?? []), label]);
  }
}

/**
 * Rows of the Quick Reference table, as `{ name, verdict }`. Scoped to that one
 * section so a table added to the prose below can't be mistaken for the roster.
 * Cells are split rather than pattern-matched so padding and any decoration
 * around the name (a link, a footnote marker) leave the row readable;
 * section headings (`**Server deps**`) and the browser workspace's `_(none)_`
 * placeholder carry no backticked package and drop out.
 */
function quickReferenceRows() {
  const afterHeading = DOC.slice(DOC.indexOf('## Quick Reference Table') + 1);
  const end = afterHeading.indexOf('\n## ');
  const section = end === -1 ? afterHeading : afterHeading.slice(0, end);
  return section
    .split('\n')
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .map(([, name, , verdict]) => ({ name: /`([^`]+)`/.exec(name ?? '')?.[1], verdict: verdict ?? '' }))
    .filter(({ name }) => name);
}

describe('docs/DEPS.md', () => {
  it('documents every dependency declared in every workspace manifest', () => {
    // A Quick Reference row, not merely a backticked mention anywhere in the
    // file: prose elsewhere (a "Last audited" note, a detailed finding) names
    // packages in passing, and accepting that would let a deleted row pass.
    const documented = new Set(quickReferenceRows().map(({ name }) => name));
    const undocumented = [...DECLARED.entries()]
      .filter(([name]) => !documented.has(name))
      .map(([name, labels]) => `${name} (${labels.join(', ')})`);
    expect(undocumented).toEqual([]);
  });

  it('names no package that no manifest declares, unless the row records a removal', () => {
    const stale = quickReferenceRows()
      .filter(({ name, verdict }) => !DECLARED.has(name) && !/REMOVED|REPLACED/.test(verdict))
      .map(({ name }) => name);
    expect(stale).toEqual([]);
  });

  it('scans a non-empty set of manifests and table rows', () => {
    // Without this, a broken discovery path or a table-format change lets both
    // assertions above pass over nothing at all.
    expect(WORKSPACES.length).toBeGreaterThanOrEqual(4);
    expect(quickReferenceRows().length).toBeGreaterThanOrEqual(40);
  });
});
