/**
 * The presentation tables must cover the server's vocabulary exactly: a finding
 * kind the server can emit but `FINDING_KIND_META` lacks renders as an
 * unlabeled badge with no repair path, and a status `REVIEW_STATUS_META` lacks
 * silently falls out of the coverage table. The vocabulary is re-exported from
 * the server leaf, so only these client-owned tables can drift.
 */
import { describe, it, expect } from 'vitest';
import {
  AUGMENTABLE_FINDING_KINDS,
  CHARACTER_REVIEW_STATUSES,
  DEPTH_META,
  FINDING_KIND_META,
  INTEGRITY_DEPTHS,
  INTEGRITY_FINDING_KINDS,
  REVIEW_STATUS_META,
  findingIsRepairable,
} from './characterIntegrity.js';

describe('cast-integrity presentation covers the server vocabulary', () => {
  it('has badge copy for every finding kind, review status and depth', () => {
    expect(Object.keys(FINDING_KIND_META).sort()).toEqual([...INTEGRITY_FINDING_KINDS].sort());
    expect(Object.keys(REVIEW_STATUS_META).sort()).toEqual([...CHARACTER_REVIEW_STATUSES].sort());
    expect(Object.keys(DEPTH_META).sort()).toEqual([...INTEGRITY_DEPTHS].sort());
  });

  it('offers the Augment button on exactly the machine-repairable kinds', () => {
    const repairable = INTEGRITY_FINDING_KINDS.filter((kind) => findingIsRepairable({ kind }));
    expect(repairable).toEqual([...AUGMENTABLE_FINDING_KINDS]);
  });
});
