/**
 * Barrel-surface test for issues.js (#2531, #16214): the barrel must keep
 * re-exporting every leaf's public surface. Behavior suites live beside each
 * leaf (issueCrud, issueStages, issueSync, issuesShared) over
 * issues.testFixtures.js.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const h = await vi.hoisted(() => import('./issues.testFixtures.js'));

vi.mock('../../lib/fileUtils.js', () => h.fileUtilsFactory());
vi.mock('../../lib/conflictJournal.js', (importOriginal) => h.conflictJournalFactory(importOriginal));
vi.mock('crypto', () => h.cryptoFactory());
vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());
vi.mock('./seriesCoverImage.js', () => h.coverRefresh);

const barrel = await import('./issues.js');
const leaves = {
  issuesShared: await import('./issuesShared.js'),
  issueCrud: await import('./issueCrud.js'),
  issueStages: await import('./issueStages.js'),
  issueSync: await import('./issueSync.js'),
};

describe('pipeline issues barrel', () => {
  it.each(Object.entries(leaves))('re-exports every %s export unchanged', (_name, leaf) => {
    const exported = Object.keys(leaf);
    expect(exported.length).toBeGreaterThan(0);
    for (const key of exported) {
      expect(barrel[key], key).toBe(leaf[key]);
    }
  });
});
