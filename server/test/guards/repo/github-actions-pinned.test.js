import { readdirSync } from 'fs';
import { join, relative } from 'path';

import { describe, expect, it } from 'vitest';
import { readText, REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows');
// Composite actions run external actions too; their `uses:` lines get the same pin contract.
const ACTIONS_DIR = join(REPO_ROOT, '.github/actions');
function listWorkflowFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listWorkflowFiles(path);
    return entry.isFile() && /\.ya?ml$/i.test(entry.name) ? [path] : [];
  }).sort();
}

const WORKFLOW_FILES = listWorkflowFiles(WORKFLOWS_DIR);
const ACTION_FILES = listWorkflowFiles(ACTIONS_DIR);
const FULL_COMMIT_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[a-f0-9]{40}$/i;
const RELEASE_VERSION_COMMENT = /^v\d+\.\d+\.\d+$/;

function parseUsesLine(line) {
  const match = line.match(/^\s*(?:-\s*)?uses:\s*(["']?)([^"'#\s]+)\1(?:\s+#\s*(.*))?\s*$/);
  if (match) {
    return { reference: match[2], comment: match[3]?.trim() ?? '' };
  }

  if (/^\s*(?:-\s*)?uses:/.test(line)) {
    return { error: 'malformed uses reference' };
  }
  return null;
}

function findUnpinnedUses(yaml) {
  const violations = [];
  for (const [index, line] of yaml.split('\n').entries()) {
    const parsed = parseUsesLine(line);
    if (!parsed) continue;

    if (parsed.error) {
      violations.push({ line: index + 1, reason: parsed.error });
      continue;
    }
    if (parsed.reference.startsWith('./') && !parsed.reference.includes('@')) continue;
    if (!FULL_COMMIT_REF.test(parsed.reference)) {
      violations.push({ line: index + 1, reference: parsed.reference, reason: 'external uses must name a full commit SHA' });
      continue;
    }
    if (!RELEASE_VERSION_COMMENT.test(parsed.comment)) {
      violations.push({ line: index + 1, reference: parsed.reference, reason: 'pinned actions need an exact upstream version comment' });
    }
  }
  return violations;
}

describe('GitHub Actions immutable pin contract', () => {
  it('pins every external action and keeps its exact version beside the SHA', () => {
    expect(ACTION_FILES.length).toBeGreaterThan(0);
    for (const filename of [...WORKFLOW_FILES, ...ACTION_FILES]) {
      const yaml = readText(filename);
      expect(findUnpinnedUses(yaml), relative(REPO_ROOT, filename)).toEqual([]);
    }
  });

  it('rejects branch and tag refs while allowing local reusable workflows', () => {
    expect(findUnpinnedUses('      - uses: actions/checkout@main')).toHaveLength(1);
    expect(findUnpinnedUses('      - uses: actions/checkout@v7')).toHaveLength(1);
    expect(findUnpinnedUses('      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1')).toEqual([]);
    expect(findUnpinnedUses('    uses: ./.github/workflows/ci.yml')).toEqual([]);
    expect(findUnpinnedUses('      - uses: ./.github/actions/setup-server')).toEqual([]);
  });

  it('keeps the contents write grant in the release workflow', () => {
    const releasePath = join(WORKFLOWS_DIR, 'release.yml');
    const release = readText(releasePath);

    for (const filename of WORKFLOW_FILES.filter((path) => path !== releasePath)) {
      const yaml = readText(filename);
      expect(yaml, relative(REPO_ROOT, filename)).not.toMatch(/^\s+contents: write\s*$/m);
    }
    expect(release).toMatch(/^permissions:\n {2}contents: write$/m);
  });
});
