import { describe, it, expect } from 'vitest';
import {
  slugMarker,
  extractSlugFromBody,
  normalizeSlug,
  isProposalDuplicate,
  isAppParked,
} from './dedup.js';
import {
  CLOSED_SUPPRESSION_MS,
} from './constants.js';

describe('slug helpers', () => {
  it('round-trips a slug marker', () => {
    expect(extractSlugFromBody(`text ${slugMarker('my-slug')} more`)).toBe('my-slug');
  });

  it('extracts nothing from a body with no marker', () => {
    expect(extractSlugFromBody('no marker here')).toBe(null);
  });

  it('normalizes messy slugs', () => {
    expect(normalizeSlug('  My Cool Feature!! ')).toBe('my-cool-feature');
    expect(normalizeSlug('already-good')).toBe('already-good');
  });

  it('returns null for empty/non-string slugs', () => {
    expect(normalizeSlug('')).toBe(null);
    expect(normalizeSlug('   ')).toBe(null);
    expect(normalizeSlug(null)).toBe(null);
    expect(normalizeSlug(42)).toBe(null);
  });
});

describe('isProposalDuplicate (dedup)', () => {
  const now = Date.parse('2026-07-07T00:00:00Z');

  it('suppresses when an OPEN issue carries the same slug', () => {
    const existing = [{ slug: 'add-metrics', state: 'open' }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(true);
  });

  it('suppresses when a CLOSED issue is within the 30-day window', () => {
    const closedAt = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const existing = [{ slug: 'add-metrics', state: 'closed', closedAt }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(true);
  });

  it('ALLOWS re-file when a closed issue is older than 30 days', () => {
    const closedAt = new Date(now - (CLOSED_SUPPRESSION_MS + 24 * 60 * 60 * 1000)).toISOString();
    const existing = [{ slug: 'add-metrics', state: 'closed', closedAt }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(false);
  });

  it('SUPPRESSES a checked PLAN item (closed with no closedAt — #2620)', () => {
    // A `- [x]` PLAN item reads as closed with no timestamp; it stays permanently
    // within the dedup window — a completed proposal never needs re-proposal —
    // and an unchecked `- [ ]` item (state: 'open') stays suppressed too.
    const closed = [{ slug: 'add-metrics', state: 'closed' }];
    const open = [{ slug: 'add-metrics', state: 'open' }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: closed, now })).toBe(true);
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: open, now })).toBe(true);
  });

  it('matches slug embedded in a body marker (no parsed slug field)', () => {
    const existing = [{ body: `stuff ${slugMarker('add-metrics')}`, state: 'open' }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(true);
  });

  it('does not suppress a different slug', () => {
    const existing = [{ slug: 'other-thing', state: 'open' }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(false);
  });

  it('is a no-op for a bad slug', () => {
    expect(isProposalDuplicate({ slug: '', existingIssues: [{ slug: 'x', state: 'open' }], now })).toBe(false);
  });

  it('normalizes both sides before comparing', () => {
    const existing = [{ slug: 'Add Metrics!', state: 'open' }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(true);
  });
});

describe('isAppParked (pause)', () => {
  it('is parked when at least one blocking issue is open', () => {
    expect(isAppParked([{ state: 'open' }, { state: 'closed' }])).toBe(true);
  });

  it('is not parked when all blocking issues are closed', () => {
    expect(isAppParked([{ state: 'closed' }])).toBe(false);
  });

  it('is not parked with no blocking issues', () => {
    expect(isAppParked([])).toBe(false);
  });
});
